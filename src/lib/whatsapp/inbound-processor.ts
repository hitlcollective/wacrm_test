/**
 * Shared inbound processor.
 *
 * Takes NormalisedEvents (the provider-agnostic shape produced by
 * `WhatsAppProvider.parseWebhook`) and persists them to the
 * database. Both the Meta webhook route and (PR 2) the Evolution
 * webhook route call into this module. The processor doesn't know
 * or care which provider produced the events.
 *
 * The body of each helper below is byte-for-byte the same logic
 * that used to live in `src/app/api/whatsapp/webhook/route.ts`.
 * The only changes vs the pre-PR-1 code:
 *   - The function signatures now take `NormalisedEvent` /
 *     `NormalisedMessage` instead of the provider-specific Meta
 *     `WhatsAppMessage` / `WhatsAppWebhookEntry` shapes.
 *   - The `accessToken` parameter is gone from the message path —
 *     media URL resolution happens inside the provider's
 *     `parseWebhook`, so by the time we get here, the message's
 *     `image.url` / `video.url` / etc. are already set if the
 *     provider could resolve them.
 *   - Status events arrive pre-normalised to the internal ladder
 *     (`sent` / `delivered` / etc.) and pre-validated against the
 *     status-ladder rules. The provider's parser owns that logic.
 *
 * What's deliberately NOT here:
 *   - Provider webhook signature verification. Each provider
 *     exposes `verifyWebhookSignature(rawBody, signature)`; the
 *     route checks it BEFORE calling into this module.
 *   - Meta config lookup by `phone_number_id`. The provider's
 *     parser already matched the inbound against a config row
 *     and produced events for that account; this module is told
 *     which account to attribute the event to via `ctx`.
 *   - HTTP shape (request, response, status codes). Pure data in,
 *     DB writes out.
 */

import { createClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { normalizePhone } from './phone-utils'
import { handleTemplateWebhookChange, isTemplateWebhookField } from './template-webhook'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import type { NormalisedEvent, NormalisedMessage } from './providers/types'

// ============================================================
// Service-role Supabase client (lazy)
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

// ============================================================
// Context passed in by the route
// ============================================================

/**
 * What the shared processor needs to know to attribute a normalised
 * event to a tenant + insert rows that need an audit `user_id`.
 * The route resolves the account + user from the matched
 * `whatsapp_config` row (Meta) or from the `?secret=…` lookup
 * (Evolution, PR 2).
 */
export interface InboundContext {
  accountId: string
  /** Admin who saved the WhatsApp config; used as the user_id
   *  audit column on inserts that need a NOT NULL FK. */
  configOwnerUserId: string
}

// ============================================================
// Top-level dispatcher
// ============================================================

/**
 * Persist a batch of NormalisedEvents. Best-effort per event — a
 * throw in one event's persistence logs and continues so a single
 * bad message doesn't take down the whole batch. The route
 * continues to ack the provider with 200 either way.
 */
export async function processInboundEvents(
  events: NormalisedEvent[],
  ctx: InboundContext,
): Promise<void> {
  for (const event of events) {
    try {
      await processInboundEvent(event, ctx)
    } catch (err) {
      console.error(
        '[inbound-processor] event processing failed:',
        err instanceof Error ? err.message : err,
      )
    }
  }
}

async function processInboundEvent(
  event: NormalisedEvent,
  ctx: InboundContext,
): Promise<void> {
  switch (event.kind) {
    case 'message':
      await processMessage(
        event.message,
        event.contact,
        ctx.accountId,
        ctx.configOwnerUserId,
      )
      return
    case 'status':
      await handleStatusUpdate(event.status)
      return
    case 'template_change':
      // Template-lifecycle events keep their original value shape so
      // `handleTemplateWebhookChange` can pull the bits it cares
      // about. The `isTemplateWebhookField` guard here is a
      // defence-in-depth check in case a non-template event ever
      // leaks into this branch.
      if (isTemplateWebhookField(event.field)) {
        await handleTemplateWebhookChange(
          { field: event.field, value: event.value },
          supabaseAdmin(),
        )
      }
      return
    case 'connection_update':
      // Connection-state events are Evolution-specific. The Meta
      // route never produces this kind. Persist the new state on
      // the whatsapp_config row so the UI can read it without a
      // round-trip to the provider.
      await persistConnectionState(ctx.accountId, event.state, event.reason)
      return
  }
}

// ============================================================
// Inbound message
// ============================================================

interface ContactOutcome {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contact: any
  wasCreated: boolean
}

async function processMessage(
  message: NormalisedMessage,
  contact: { phone: string; name: string },
  accountId: string,
  configOwnerUserId: string,
): Promise<void> {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.name

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName,
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
  )
  if (!conversation) return

  // Reactions short-circuit here — they aren't messages. We never
  // insert into `messages`, never bump unread_count, never update
  // last_message_text.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  // Derive the DB-facing content fields from the NormalisedMessage.
  // The provider has already resolved any media URLs to stable
  // wacrm-proxy URLs (Meta) or Evolution's URL (PR 2 will re-fetch
  // to long-term storage).
  const { contentText, mediaUrl } = extractContentFields(message)
  const interactiveReplyId =
    message.type === 'interactive' ? message.interactive?.button_reply?.id
      ?? message.interactive?.list_reply?.id
      ?? null
      : null

  // Resolve swipe-reply context if present. A missing parent is
  // fine — we just store NULL and the UI renders the message
  // without a quote.
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id,
    )
    if (!replyToInternalId) {
      console.warn(
        '[inbound-processor] reply context parent not found:',
        message.context.id,
      )
    }
  }

  // The messages.content_type CHECK constraint allows:
  //   text, image, document, audio, video, location, template, interactive
  // (widened in migration 010 to add 'interactive'). Map
  // non-allowed values to the closest allowed one so the INSERT
  // doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'   // stickers are images
      : 'text'    // reaction, unknown → text fallback

  // Determine whether this is the contact's very first inbound
  // message BEFORE we insert, so the count is accurate. Covers
  // the case where the contact row already exists (manual add /
  // CSV import) but they've never messaged us before — which
  // new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.id,
    status: 'delivered',
    created_at: new Date(parseInt(message.timestamp, 10) * 1000).toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: interactiveReplyId,
  })

  if (msgError) {
    console.error('[inbound-processor] Error inserting message:', msgError)
    return
  }

  // Update conversation
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${message.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('[inbound-processor] Error updating conversation:', convError)
  }

  // If this contact was a recent broadcast recipient, flag the
  // reply so the broadcast's `replied_count` advances (via the
  // aggregate trigger installed in migration 003).
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an
  // active run or started a new one), we suppress the
  // `new_message_received` + `keyword_match` automation triggers
  // for this inbound. The relationship-level triggers
  // (`new_contact_created`, `first_inbound_message`) still fire
  // even when consumed — those are about WHO is messaging, not
  // what they said.
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: message.id,
        }
      : {
          kind: 'text',
          text: contentText ?? message.text?.body ?? '',
          meta_message_id: message.id,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event. All
  // dispatches run here (not earlier) so the contact, conversation,
  // and inbound message all exist before any step — including
  // send_message — runs. Fire-and-forget: a slow or failing
  // automation must not block the webhook's 200 OK response.
  const inboundText = contentText ?? message.text?.body ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
      },
    }).catch((err) =>
      console.error('[inbound-processor] automation dispatch failed:', err),
    )
  }
}

// ============================================================
// Content extraction
// ============================================================

/**
 * Pull the human-readable text + the media URL out of a
 * NormalisedMessage. Used to be `parseMessageContent` inside the
 * webhook route; now lives here as a free function so both
 * providers' events flow through one canonical mapper.
 */
function extractContentFields(message: NormalisedMessage): {
  contentText: string | null
  mediaUrl: string | null
} {
  switch (message.type) {
    case 'text':
      return { contentText: message.text?.body ?? null, mediaUrl: null }
    case 'image':
      return {
        contentText: message.image?.caption ?? null,
        mediaUrl: message.image?.url ?? null,
      }
    case 'video':
      return {
        contentText: message.video?.caption ?? null,
        mediaUrl: message.video?.url ?? null,
      }
    case 'document':
      return {
        contentText:
          message.document?.caption ??
          message.document?.filename ??
          null,
        mediaUrl: message.document?.url ?? null,
      }
    case 'audio':
      return { contentText: null, mediaUrl: message.audio?.url ?? null }
    case 'sticker':
      return { contentText: null, mediaUrl: message.sticker?.url ?? null }
    case 'location': {
      const loc = message.location
      if (!loc) return { contentText: null, mediaUrl: null }
      const parts = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
        .filter(Boolean)
        .join(' - ')
      return { contentText: parts || null, mediaUrl: null }
    }
    case 'reaction':
      return { contentText: message.reaction?.emoji ?? null, mediaUrl: null }
    case 'interactive': {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply
      return {
        contentText: reply?.title ?? reply?.id ?? '[Interactive reply]',
        mediaUrl: null,
      }
    }
  }
}

// ============================================================
// Status update
// ============================================================

// The happy-path status ladder — pending → sent → delivered →
// read → replied. Webhook replays must never regress a recipient
// back down this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch
// that is only valid from the early states (pending / sent) —
// once Meta has delivered or the user has read or replied, a
// later "failed" status event is a bug in the provider's pipeline
// or a spoof attempt and must be ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false
  if (ci < 0) return true
  return ii > ci
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: number
  recipient_id: string
}): Promise<void> {
  // 1) Mirror onto messages. The provider's parser has already
  //    validated the status against the internal ladder, so we
  //    just write the string.
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)

  if (msgErr) {
    console.error('[inbound-processor] Error updating message status:', msgErr)
  }

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id.
  //    The aggregate trigger on broadcast_recipients re-derives
  //    the parent broadcast's counts automatically.
  const tsIso = new Date(status.timestamp * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('[inbound-processor] Error fetching broadcast recipient:', recFetchErr)
    return
  }
  if (!recipient) return

  if (!isValidStatusTransition(recipient.status, status.status)) return

  const update: Record<string, unknown> = { status: status.status }
  if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
  if (status.status === 'delivered') update.delivered_at = tsIso
  if (status.status === 'read') update.read_at = tsIso

  const { error: recUpdateErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .update(update)
    .eq('id', recipient.id)

  if (recUpdateErr) {
    console.error('[inbound-processor] Error updating broadcast recipient:', recUpdateErr)
  }
}

// ============================================================
// Helpers
// ============================================================

async function flagBroadcastReplyIfAny(
  accountId: string,
  contactId: string,
): Promise<void> {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('[inbound-processor] Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('[inbound-processor] flagBroadcastReplyIfAny failed:', err)
  }
}

async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string,
): Promise<string | null> {
  // Despite the name, this resolves the provider's message_id
  // (Meta: WAMID; Evolution: Baileys message id) into the row's
  // internal UUID. The function name predates the Evolution work
  // and stays for diff-clarity with the original code.
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error(
      '[inbound-processor] lookupInternalIdByMetaId failed:',
      error.message,
    )
    return null
  }
  return data?.id ?? null
}

async function handleReaction(
  message: NormalisedMessage,
  conversationId: string,
  contactId: string,
): Promise<void> {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId,
  )
  if (!targetInternalId) {
    console.warn(
      '[inbound-processor] reaction target message not found; skipping',
      reaction.message_id,
    )
    return
  }

  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[inbound-processor] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' },
    )
  if (upsertError) {
    console.error('[inbound-processor] reaction upsert failed:', upsertError.message)
  }
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[inbound-processor] Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) {
    return existing
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    console.error('[inbound-processor] Error creating conversation:', createError.message)
    return null
  }

  return newConv
}

async function persistConnectionState(
  accountId: string,
  state: 'connected' | 'disconnected' | 'connecting',
  reason?: string,
): Promise<void> {
  // Connection-state events are Evolution-specific. The Meta
  // route never produces this kind. Update only the Evolution
  // columns on the matching account row.
  const update: Record<string, unknown> = {
    evolution_connection_state: state,
    evolution_last_seen_at: new Date().toISOString(),
  }
  if (state === 'connected') {
    update.evolution_last_disconnect_reason = null
  }
  if (state === 'disconnected' && reason) {
    update.evolution_last_disconnect_reason = reason
  }
  const { error } = await supabaseAdmin()
    .from('whatsapp_config')
    .update(update)
    .eq('account_id', accountId)
    .eq('provider', 'evolution')
  if (error) {
    console.error(
      '[inbound-processor] persistConnectionState failed:',
      error.message,
    )
  }
}
