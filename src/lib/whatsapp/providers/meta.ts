/**
 * Meta WhatsApp Cloud API provider.
 *
 * Thin wrapper around the existing `lib/whatsapp/meta-api.ts` helpers
 * so the `WhatsAppProvider` interface is satisfied. The behaviour is
 * byte-for-byte identical to the pre-abstraction code path — the
 * refactor moves HOW we call Meta behind the interface, not WHAT
 * we call.
 *
 * What lives here:
 *   - Sending: one-liner forwarders to `meta-api.ts` (`sendTextMessage`,
 *     `sendMediaMessage`, etc.). The named-args convention is preserved
 *     on both sides so a typo surfaces as a TypeScript error.
 *   - `verifyCredentials()` → `verifyPhoneNumber()`. Returns
 *     `display_phone_number` as the displayName so the UI can show
 *     "Connected as +1 555 0100" without a separate query.
 *   - `verifyWebhookSignature()` → the same HMAC-SHA256 check the
 *     route used to do inline, now called via the provider. META_APP_SECRET
 *     is read from env inside the signature helper (it fails closed if
 *     missing); no need to pass it through the constructor.
 *   - `parseWebhook()` walks Meta's `entry[].changes[].value` tree
 *     and emits NormalisedEvents. Media URLs are resolved through
 *     `getMediaUrl()` (HEAD-only) so the inbox can render a stable
 *     `/api/whatsapp/media/{id}` proxy URL. Reactions and template
 *     changes route to their dedicated branches in the shared
 *     processor via the matching NormalisedEvent kinds.
 *
 * What's NOT here:
 *   - The DB persistence (find-or-create contact / conversation,
 *     insert message, dispatch flow runner + automations). That's
 *     the shared processor's job — see `inbound-processor.ts`.
 *   - The Meta config save flow. That's `api/whatsapp/config/route.ts`
 *     and the route continues to call `meta-api.ts` directly for the
 *     registration-specific endpoints (`/register`, `/subscribed_apps`)
 *     because they have no equivalent in other providers.
 */

import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendReactionMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  verifyPhoneNumber,
  getMediaUrl,
} from '../meta-api'
import { verifyMetaWebhookSignature } from '../webhook-signature'
import type {
  SendTextArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendReactionArgs,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  SendResult,
  VerifyCredentialsResult,
  NormalisedEvent,
  NormalisedMessage,
  WhatsAppProvider,
} from './types'

export interface MetaProviderConfig {
  phoneNumberId: string
  accessToken: string
  wabaId?: string | null
}

export class MetaProvider implements WhatsAppProvider {
  private config: MetaProviderConfig

  constructor(config: MetaProviderConfig) {
    this.config = config
  }

  // ============================================================
  // Sending
  // ============================================================

  async sendText(args: SendTextArgs): Promise<SendResult> {
    const r = await sendTextMessage({
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      to: args.to,
      text: args.text,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: r.messageId }
  }

  async sendMedia(args: SendMediaArgs): Promise<SendResult> {
    const r = await sendMediaMessage({
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      to: args.to,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: r.messageId }
  }

  async sendTemplate(args: SendTemplateArgs): Promise<SendResult> {
    const r = await sendTemplateMessage({
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      to: args.to,
      templateName: args.templateName,
      language: args.language,
      template: args.template,
      messageParams: args.messageParams,
      params: args.params,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: r.messageId }
  }

  async sendReaction(args: SendReactionArgs): Promise<SendResult> {
    const r = await sendReactionMessage({
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      to: args.to,
      targetMessageId: args.targetMessageId,
      emoji: args.emoji,
    })
    return { messageId: r.messageId }
  }

  async sendInteractiveButtons(
    args: SendInteractiveButtonsArgs,
  ): Promise<SendResult> {
    const r = await sendInteractiveButtons({
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      to: args.to,
      bodyText: args.bodyText,
      headerText: args.headerText,
      footerText: args.footerText,
      buttons: args.buttons,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: r.messageId }
  }

  async sendInteractiveList(
    args: SendInteractiveListArgs,
  ): Promise<SendResult> {
    const r = await sendInteractiveList({
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      to: args.to,
      bodyText: args.bodyText,
      buttonLabel: args.buttonLabel,
      headerText: args.headerText,
      footerText: args.footerText,
      sections: args.sections,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: r.messageId }
  }

  // ============================================================
  // Settings → "Test Connection"
  // ============================================================

  async verifyCredentials(): Promise<VerifyCredentialsResult> {
    const info = await verifyPhoneNumber({
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
    })
    return {
      displayName: info.display_phone_number,
      metadata: {
        verified_name: info.verified_name,
        quality_rating: info.quality_rating,
        id: info.id,
      },
    }
  }

  // ============================================================
  // Webhook
  // ============================================================

  verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
    return verifyMetaWebhookSignature(rawBody, signature)
  }

  async parseWebhook(rawBody: string): Promise<NormalisedEvent[]> {
    let body: MetaWebhookBody
    try {
      body = JSON.parse(rawBody) as MetaWebhookBody
    } catch {
      // Malformed JSON — surface as zero events so the route can
      // 200-ack and Meta doesn't retry forever.
      return []
    }

    const out: NormalisedEvent[] = []
    if (!body.entry) return out

    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        const value = change.value
        if (!value) continue

        // Template-lifecycle events have a non-messaging field and a
        // distinct value shape. Hand them off via the dedicated event
        // kind so the shared processor can route to
        // `handleTemplateWebhookChange`.
        if (value.messaging_product !== 'whatsapp' && change.field) {
          out.push({
            kind: 'template_change',
            field: change.field,
            value: value as unknown,
          })
          continue
        }

        // Status updates.
        for (const status of value.statuses ?? []) {
          if (!status?.id) continue
          out.push({
            kind: 'status',
            status: {
              id: status.id,
              status: normaliseStatus(status.status),
              timestamp: parseInt(String(status.timestamp ?? '0'), 10) || 0,
              recipient_id: status.recipient_id ?? '',
            },
          })
        }

        // Inbound messages.
        if (!value.messages || !value.contacts) continue
        for (let i = 0; i < value.messages.length; i++) {
          const m = value.messages[i]
          const c = value.contacts[i] ?? value.contacts[0]
          if (!m || !c) continue

          const message = await this.normaliseMessage(m)
          if (!message) continue

          out.push({
            kind: 'message',
            message,
            contact: {
              phone: c.wa_id ?? message.from,
              name: c.profile?.name ?? message.from,
            },
          })
        }
      }
    }

    return out
  }

  /**
   * Convert a Meta WhatsAppMessage into a NormalisedMessage.
   * Returns null for unsupported message types (currently none —
   * we map everything, falling back to 'text' for unknown kinds).
   * Async because media IDs are resolved via getMediaUrl() so the
   * inbox can render a stable /api/whatsapp/media/{id} URL.
   */
  private async normaliseMessage(m: MetaMessage): Promise<NormalisedMessage | null> {
    const base = {
      id: m.id,
      from: m.from,
      timestamp: m.timestamp,
    }
    const ctx = m.context?.id ? { id: m.context.id } : undefined

    switch (m.type) {
      case 'text': {
        return {
          ...base,
          type: 'text',
          text: { body: m.text?.body ?? '' },
          ...(ctx ? { context: ctx } : {}),
        }
      }
      case 'image': {
        const slot = m.image
        if (!slot) return null
        const url = await this.safeMediaUrl(slot.id)
        return {
          ...base,
          type: 'image',
          image: {
            id: slot.id,
            mime_type: slot.mime_type ?? 'image/jpeg',
            ...(slot.caption ? { caption: slot.caption } : {}),
            ...(url ? { url } : {}),
          },
          ...(ctx ? { context: ctx } : {}),
        }
      }
      case 'video': {
        const slot = m.video
        if (!slot) return null
        const url = await this.safeMediaUrl(slot.id)
        return {
          ...base,
          type: 'video',
          video: {
            id: slot.id,
            mime_type: slot.mime_type ?? 'video/mp4',
            ...(slot.caption ? { caption: slot.caption } : {}),
            ...(url ? { url } : {}),
          },
          ...(ctx ? { context: ctx } : {}),
        }
      }
      case 'document': {
        const slot = m.document
        if (!slot) return null
        const url = await this.safeMediaUrl(slot.id)
        return {
          ...base,
          type: 'document',
          document: {
            id: slot.id,
            mime_type: slot.mime_type ?? 'application/octet-stream',
            ...(slot.filename ? { filename: slot.filename } : {}),
            ...(slot.caption ? { caption: slot.caption } : {}),
            ...(url ? { url } : {}),
          },
          ...(ctx ? { context: ctx } : {}),
        }
      }
      case 'audio': {
        const slot = m.audio
        if (!slot) return null
        const url = await this.safeMediaUrl(slot.id)
        return {
          ...base,
          type: 'audio',
          audio: {
            id: slot.id,
            mime_type: slot.mime_type ?? 'audio/ogg',
            ...(url ? { url } : {}),
          },
          ...(ctx ? { context: ctx } : {}),
        }
      }
      case 'sticker': {
        const slot = m.sticker
        if (!slot) return null
        const url = await this.safeMediaUrl(slot.id)
        return {
          ...base,
          type: 'sticker',
          sticker: {
            id: slot.id,
            mime_type: slot.mime_type ?? 'image/webp',
            ...(url ? { url } : {}),
          },
          ...(ctx ? { context: ctx } : {}),
        }
      }
      case 'location': {
        const loc = m.location
        if (!loc) return null
        return {
          ...base,
          type: 'location',
          location: {
            latitude: loc.latitude,
            longitude: loc.longitude,
            ...(loc.name ? { name: loc.name } : {}),
            ...(loc.address ? { address: loc.address } : {}),
          },
          ...(ctx ? { context: ctx } : {}),
        }
      }
      case 'reaction': {
        return {
          ...base,
          type: 'reaction',
          reaction: {
            message_id: m.reaction?.message_id ?? '',
            emoji: m.reaction?.emoji ?? '',
          },
          ...(ctx ? { context: ctx } : {}),
        }
      }
      case 'interactive': {
        const reply = m.interactive?.button_reply ?? m.interactive?.list_reply
        if (reply?.id) {
          return {
            ...base,
            type: 'interactive',
            interactive: {
              type: m.interactive?.button_reply ? 'button_reply' : 'list_reply',
              ...(m.interactive?.button_reply
                ? { button_reply: m.interactive.button_reply }
                : {}),
              ...(m.interactive?.list_reply
                ? { list_reply: m.interactive.list_reply }
                : {}),
            },
            text: { body: reply.title ?? reply.id },
            ...(ctx ? { context: ctx } : {}),
          }
        }
        return {
          ...base,
          type: 'interactive',
          text: { body: '[Interactive reply]' },
          ...(ctx ? { context: ctx } : {}),
        }
      }
      default:
        return {
          ...base,
          type: 'text',
          text: { body: `[Unsupported message type: ${m.type}]` },
          ...(ctx ? { context: ctx } : {}),
        }
    }
  }

  /**
   * Resolve a Meta media id to a stable wacrm proxy URL. The proxy
   * endpoint streams the bytes with the access token. Best-effort:
   * a failed resolve leaves url undefined and the inbox renders a
   * broken-image bubble (existing behaviour — the old code logged
   * and continued).
   */
  private async safeMediaUrl(mediaId: string): Promise<string | undefined> {
    try {
      await getMediaUrl({ mediaId, accessToken: this.config.accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (err) {
      // Mirror the old behaviour: log + continue. A failed resolve
      // is operational noise, not a message-loss bug — the broken-
      // image UI is honest about the state.
      console.error(
        `[meta] Failed to resolve media ${mediaId}:`,
        err instanceof Error ? err.message : err,
      )
      return undefined
    }
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Meta's status values already match our internal ladder. The
 * normaliser exists for future-proofing — if Meta introduces a
 * new status, we don't want a stray string to land in the DB
 * unchecked.
 */
function normaliseStatus(s: string): NormalisedEventStatusName {
  switch (s) {
    case 'pending':
    case 'sent':
    case 'delivered':
    case 'read':
    case 'replied':
    case 'failed':
      return s
    default:
      // Unknown — degrade to 'sent' so the row at least gets a
      // valid CHECK-constrained value. The shared processor can
      // re-validate against the ladder if needed.
      return 'sent'
  }
}

type NormalisedEventStatusName =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'replied'
  | 'failed'

// ============================================================
// Local types for the Meta webhook payload
// ============================================================
//
// These mirror the existing WhatsAppMessage / WhatsAppWebhookEntry
// shapes in `src/app/api/whatsapp/webhook/route.ts`. We duplicate
// them here because pulling in the route file would import a Next.js
// request/response dependency we don't need in the provider. Once
// the route is refactored in this PR, these move to a single
// shared types file.

interface MetaMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body?: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  context?: { id: string }
}

interface MetaWebhookBody {
  entry?: Array<{
    id: string
    changes: Array<{
      value: {
        messaging_product?: string
        metadata?: {
          display_phone_number: string
          phone_number_id: string
        }
        contacts?: Array<{
          profile: { name: string }
          wa_id: string
        }>
        messages?: MetaMessage[]
        statuses?: Array<{
          id: string
          status: string
          timestamp: string
          recipient_id: string
        }>
      } & Record<string, unknown>
      field: string
    }>
  }>
}
