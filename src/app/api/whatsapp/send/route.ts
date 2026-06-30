import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import {
  getProvider,
  decryptConfigRow,
  type WhatsAppConfigRow,
} from '@/lib/whatsapp/providers'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import type { MessageTemplate } from '@/types'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'

// POST /api/whatsapp/send
// Sends a message through whichever WhatsApp provider the
// caller's account is configured for. The provider abstraction
// lives in src/lib/whatsapp/providers; this route is now a thin
// shell that loads + decrypts the config, picks a provider,
// dispatches the right send* method, and handles the cross-
// cutting bits (rate limit, contact/conversation lookup, flow
// pause on agent send, message insert).
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Resolve the caller's account_id. Every downstream lookup
    // (conversation, whatsapp_config, message_templates) is
    // account-scoped post-multi-user, so the previous `user_id`
    // filters returned nothing for teammates who didn't author
    // the row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      reply_to_message_id,
    } = body

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 }
      )
    }

    const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const
    const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(message_type)

    const VALID_MESSAGE_TYPES = ['text', 'template', ...MEDIA_KINDS] as const
    if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(message_type)) {
      return NextResponse.json(
        { error: `Unsupported message_type "${message_type}"` },
        { status: 400 }
      )
    }

    if (message_type === 'text' && !content_text) {
      return NextResponse.json(
        { error: 'content_text is required for text messages' },
        { status: 400 }
      )
    }

    if (message_type === 'template' && !template_name) {
      return NextResponse.json(
        { error: 'template_name is required for template messages' },
        { status: 400 }
      )
    }

    if (isMediaKind && !media_url) {
      return NextResponse.json(
        { error: `media_url is required for ${message_type} messages` },
        { status: 400 }
      )
    }

    if (
      isMediaKind &&
      message_type !== 'audio' &&
      typeof content_text === 'string' &&
      content_text.length > 1024
    ) {
      return NextResponse.json(
        { error: 'Caption exceeds the 1024-character limit' },
        { status: 400 }
      )
    }

    // Resolve the target conversation.
    let conversation: { id: string; contact?: { id: string; phone?: string } | null } | null = null

    if (conversationIdInput) {
      const { data, error: convError } = await supabase
        .from('conversations')
        .select('*, contact:contacts(*)')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single()

      if (convError || !data) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        )
      }
      conversation = data
    } else {
      const { data: contactRow, error: contactErr } = await supabase
        .from('contacts')
        .select('*')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .maybeSingle()

      if (contactErr || !contactRow) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        )
      }

      const resolved = await findOrCreateConversation(
        supabase,
        accountId,
        user.id,
        contact_id,
      )
      if (!resolved) {
        return NextResponse.json(
          { error: 'Failed to open a conversation for this contact' },
          { status: 500 }
        )
      }
      conversation = { ...resolved, contact: resolved.contact ?? contactRow }
    }

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    const conversation_id = conversation.id

    const contact = conversation.contact
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 }
      )
    }

    // Sanitize and validate phone. The Meta sandbox-error retry
    // loop below uses Meta's sanitiser specifically — the
    // variants are Meta-shaped. For Evolution, the provider's
    // sendText/sendMedia does its own digit-only normalisation.
    const sanitizedPhone = sanitizePhoneForMeta(contact.phone)
    if (!isValidE164(sanitizedPhone)) {
      return NextResponse.json(
        { error: 'Invalid phone number format' },
        { status: 400 }
      )
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured. Please set up your WhatsApp integration first.' },
        { status: 400 }
      )
    }

    const decrypted = decryptConfigRow(config as WhatsAppConfigRow, decrypt)
    const provider = getProvider(decrypted, {
      metaAppSecret: process.env.META_APP_SECRET ?? null,
    })

    // Self-heal legacy CBC-encrypted tokens. Fire-and-forget: we
    // return from the send without waiting, so a failed upgrade
    // just means the next send tries again. The upgrade is
    // idempotent — concurrent sends both produce valid GCM
    // ciphertexts of the same plaintext, last write wins.
    if (isLegacyFormat(config.access_token)) {
      void supabase
        .from('whatsapp_config')
        .update({ access_token: encrypt(decrypted.accessToken!) })
        .eq('id', config.id)
        .then(({ error }) => {
          if (error) {
            console.warn(
              '[whatsapp/send] access_token GCM upgrade failed:',
              error.message,
            )
          }
        })
    }
    if (isLegacyFormat(config.evolution_apikey)) {
      void supabase
        .from('whatsapp_config')
        .update({ evolution_apikey: encrypt(decrypted.evolutionApiKey!) })
        .eq('id', config.id)
        .then(({ error }) => {
          if (error) {
            console.warn(
              '[whatsapp/send] evolution_apikey GCM upgrade failed:',
              error.message,
            )
          }
        })
    }

    // Resolve the reply target (if any) to the provider's
    // message_id, which is what `context.message_id` on the
    // outgoing payload needs. The parent must belong to this
    // same conversation — otherwise a caller could quote
    // messages they can't see by guessing UUIDs.
    let contextMessageId: string | undefined
    if (reply_to_message_id) {
      const { data: parent, error: parentError } = await supabase
        .from('messages')
        .select('message_id, conversation_id')
        .eq('id', reply_to_message_id)
        .eq('conversation_id', conversation_id)
        .maybeSingle()

      if (parentError || !parent) {
        return NextResponse.json(
          { error: 'reply_to_message_id not found in this conversation' },
          { status: 400 }
        )
      }
      if (!parent.message_id) {
        console.warn(
          '[whatsapp/send] reply target has no provider message_id; sending without context',
        )
      } else {
        contextMessageId = parent.message_id
      }
    }

    // Load the template row if needed. Match on
    // (account_id, name, language) — same triple the unique index
    // enforces — so multi-language templates work correctly.
    // The provider's sendTemplate will throw if the provider
    // doesn't support templates (Evolution v1).
    let templateRow: MessageTemplate | null = null
    if (message_type === 'template' && template_name) {
      const { data } = await supabase
        .from('message_templates')
        .select('*')
        .eq('account_id', accountId)
        .eq('name', template_name)
        .eq('language', template_language || 'en_US')
        .maybeSingle()
      if (data && !isMessageTemplate(data)) {
        return NextResponse.json(
          {
            error:
              'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
          },
          { status: 500 },
        )
      }
      templateRow = data ?? null
    }

    // Dispatch via the provider. The Meta-specific phone-variants
    // retry (the "recipient not in allowed list" loop) is gated
    // to provider === 'meta' because it's a Meta sandbox/trial
    // behaviour. For Evolution, the provider's own send
    // does digit-only normalisation and the variants loop would
    // just add noise.
    const isMeta = decrypted.provider === 'meta'
    const variants = isMeta ? phoneVariants(sanitizedPhone) : [sanitizedPhone]

    const attempt = async (phone: string): Promise<string> => {
      if (message_type === 'template') {
        const result = await provider.sendTemplate({
          to: phone,
          templateName: template_name,
          language: template_language || 'en_US',
          template: templateRow ?? undefined,
          messageParams: template_message_params ?? undefined,
          params: template_params || [],
          contextMessageId,
        })
        return result.messageId
      }
      if (isMediaKind) {
        const result = await provider.sendMedia({
          to: phone,
          kind: message_type as 'image' | 'video' | 'document' | 'audio',
          link: media_url,
          caption: content_text || undefined,
          filename: filename || undefined,
          contextMessageId,
        })
        return result.messageId
      }
      const result = await provider.sendText({
        to: phone,
        text: content_text,
        contextMessageId,
      })
      return result.messageId
    }

    let waMessageId = ''
    let workingPhone = sanitizedPhone
    try {
      let lastError: unknown = null
      for (const variant of variants) {
        try {
          waMessageId = await attempt(variant)
          workingPhone = variant
          lastError = null
          break
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // Only retry on Meta + only when the failure is
          // specifically the Meta "recipient not in allowed list"
          // error. Any other error (bad token, invalid template,
          // etc.) bubbles up immediately.
          if (!isMeta || !isRecipientNotAllowedError(message)) {
            throw err
          }
          lastError = err
          console.warn(
            `[whatsapp/send] variant "${variant}" rejected by Meta, trying next…`,
          )
        }
      }
      if (lastError) throw lastError
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown provider error'
      const providerLabel = isMeta ? 'Meta API' : 'Evolution API'
      console.error(`${providerLabel} send failed for all variants:`, message)
      return NextResponse.json(
        { error: `${providerLabel} error: ${message}` },
        { status: 502 }
      )
    }

    // If a non-original variant succeeded (Meta only), update the
    // contact so future sends go straight through.
    if (isMeta && workingPhone !== sanitizedPhone) {
      console.log(
        `[whatsapp/send] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`,
      )
      await supabase
        .from('contacts')
        .update({ phone: workingPhone })
        .eq('id', contact.id)
    }

    // Insert message into DB.
    const { data: messageRecord, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id,
        sender_type: 'agent',
        content_type: message_type,
        content_text: content_text || null,
        media_url: media_url || null,
        template_name: template_name || null,
        message_id: waMessageId,
        status: 'sent',
        reply_to_message_id: reply_to_message_id || null,
      })
      .select()
      .single()

    if (msgError) {
      console.error('Error inserting sent message:', msgError)
      return NextResponse.json(
        { error: `Message sent to provider but failed to save to DB: ${msgError.message}` },
        { status: 500 }
      )
    }

    // Update conversation
    await supabase
      .from('conversations')
      .update({
        last_message_text: content_text || `[${message_type}]`,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation_id)

    // Pause any active Flow run for this contact.
    try {
      const { error: pauseErr } = await supabaseAdmin()
        .from('flow_runs')
        .update({
          status: 'paused_by_agent',
          ended_at: new Date().toISOString(),
          end_reason: 'agent_replied',
        })
        .eq('account_id', accountId)
        .eq('contact_id', contact.id)
        .eq('status', 'active')
      if (pauseErr) {
        console.error('[flows] pause-on-agent-send failed:', pauseErr.message)
      }
    } catch (err) {
      console.error(
        '[flows] pause-on-agent-send threw:',
        err instanceof Error ? err.message : err,
      )
    }

    return NextResponse.json({
      success: true,
      message_id: messageRecord.id,
      whatsapp_message_id: waMessageId,
    })
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    )
  }
}

type SendSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * Return the contact's conversation in this account, creating one
 * if it doesn't exist yet. Mirrors the webhook's find-or-create so
 * an inbound-then-outbound (or outbound-first) sequence converges on
 * a single thread per contact.
 */
async function findOrCreateConversation(
  supabase: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string,
) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (existing) return existing

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
    })
    .select('*, contact:contacts(*)')
    .single()

  if (error) {
    console.error('Error creating conversation for contact send:', error.message)
    return null
  }

  return created
}
