/**
 * WhatsApp provider abstraction.
 *
 * wacrm supports two WhatsApp back-ends:
 *   - 'meta'      — the official Meta WhatsApp Cloud API
 *   - 'evolution' — Evolution API (https://github.com/evolution-foundation/evolution-api),
 *                   a self-hosted gateway that wraps the unofficial
 *                   Baileys Web session and exposes a REST surface
 *
 * Both implement the same `WhatsAppProvider` interface so route
 * handlers can stay provider-agnostic. The provider is selected by
 * `whatsapp_config.provider` (set in migration 027).
 *
 * Why an interface and not a single class with branches:
 *   - Each provider has a fundamentally different auth model (Meta
 *     uses per-phone access tokens; Evolution uses per-instance
 *     apikeys), a different webhook signing model (Meta HMAC, Evolution
 *     nothing), and a different inbound payload shape. Inlining the
 *     branches as a switch statement everywhere would repeat the
 *     shape of those differences on every call site. An interface
 *     pins the contract and lets the two implementations diverge
 *     without the route handlers noticing.
 *   - The existing tests (send.test.ts, webhook tests) keep passing
 *     unchanged because the public shape of the send + webhook
 *     routes doesn't change. Only the internals route through
 *     `getProvider(config)`.
 *
 * Contract surface:
 *   - Sending: one method per message kind, returning the provider's
 *     message id (so the inbox can correlate future status updates).
 *   - Settings → "Test Connection": `verifyCredentials()` returns a
 *     human-readable name (Meta: display_phone_number; Evolution:
 *     the connected JID) plus an optional metadata blob.
 *   - Webhook signature verification: provider decides what's
 *     authentic. Meta uses HMAC-SHA256; Evolution trusts the
 *     `?secret=…` URL parameter.
 *   - Webhook payload → normalised events: `parseWebhook` is async
 *     because it may need to resolve media IDs to proxy URLs
 *     (Meta needs an authenticated HEAD to verify the media still
 *     exists; Evolution v2 returns a transient URL we may want to
 *     immediately re-fetch to a stable URL). The output shape is
 *     identical for every provider — that's the whole point of
 *     `NormalisedEvent` below.
 */

import type { MessageTemplate } from '@/types'
import type { SendTimeParams } from '../template-send-builder'

// ============================================================
// Discriminator
// ============================================================

export type WhatsAppProviderId = 'meta' | 'evolution'

// ============================================================
// Common send arg shapes
// ============================================================

export interface SendTextArgs {
  to: string
  text: string
  /** Provider's message id of the message being replied to. Renders a
   *  quote preview in WhatsApp. */
  contextMessageId?: string
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaArgs {
  to: string
  kind: MediaKind
  /** Public URL the provider fetches at send time. The composer uploads
   *  to chat-media storage first and passes the resulting URL. */
  link: string
  /** Optional caption. Meta caps at 1024 chars. Audio ignores it. */
  caption?: string
  /** Document-only. Shown in the recipient's chat as the file name. */
  filename?: string
  contextMessageId?: string
}

export interface SendTemplateArgs {
  to: string
  templateName: string
  language?: string
  /** Meta-only: legacy body-only params. Kept for callers that haven't
   *  migrated to the structured `template` + `messageParams` pair. */
  params?: string[]
  /** Local template row. For Meta this is what the send-builder turns
   *  into the components array. For Evolution v1 (B1) it's unused. */
  template?: MessageTemplate
  /** Structured per-send values. */
  messageParams?: SendTimeParams
  contextMessageId?: string
}

export interface SendReactionArgs {
  to: string
  /** Provider's message id of the message being reacted to. */
  targetMessageId: string
  /** Single emoji. Empty string = remove the reaction. */
  emoji: string
}

export interface InteractiveButton {
  /** Stable id returned in the webhook when tapped. */
  id: string
  /** Visible label. */
  title: string
}

export interface SendInteractiveButtonsArgs {
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: InteractiveButton[]
  contextMessageId?: string
}

export interface InteractiveListRow {
  id: string
  title: string
  description?: string
}

export interface InteractiveListSection {
  title?: string
  rows: InteractiveListRow[]
}

export interface SendInteractiveListArgs {
  to: string
  bodyText: string
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: InteractiveListSection[]
  contextMessageId?: string
}

export interface SendResult {
  /** Provider's message id. Stored verbatim on `messages.message_id` so
   *  future status webhooks can be matched back to the row. */
  messageId: string
}

export interface VerifyCredentialsResult {
  /** What to show the operator in the UI ("+1 555 0100" for Meta, the
   *  connected JID like "5511999999999@s.whatsapp.net" for Evolution). */
  displayName: string
  metadata?: Record<string, unknown>
}

// ============================================================
// Normalised inbound event
// ============================================================
//
// `parseWebhook` is the bridge between provider-specific payload
// shapes (Meta's `entry[].changes[].value.messages[]` tree, Evolution's
// flat `event` + `instance` + `data` shape) and the shared processor.
// The shared processor only ever sees the shape below.

export interface NormalisedMessage {
  id: string
  /** Sender phone in E.164-ish form, no separators. */
  from: string
  /** Unix epoch as a string (Meta's convention; Evolution also gives
   *  us a string). String here so the shared processor doesn't have
   *  to know which provider sent what type. */
  timestamp: string
  type:
    | 'text'
    | 'image'
    | 'video'
    | 'document'
    | 'audio'
    | 'sticker'
    | 'location'
    | 'reaction'
    | 'interactive'
  text?: { body: string }
  image?: {
    id: string
    mime_type: string
    caption?: string
    /** Provider-resolved URL the inbox can fetch. May be a wacrm-side
     *  proxy URL (`/api/whatsapp/media/{id}`) for Meta, or an
     *  Evolution URL the shared media proxy understands. */
    url?: string
  }
  video?: {
    id: string
    mime_type: string
    caption?: string
    url?: string
  }
  document?: {
    id: string
    mime_type: string
    filename?: string
    caption?: string
    url?: string
  }
  audio?: {
    id: string
    mime_type: string
    url?: string
  }
  sticker?: {
    id: string
    mime_type: string
    url?: string
  }
  location?: {
    latitude: number
    longitude: number
    name?: string
    address?: string
  }
  reaction?: {
    message_id: string
    emoji: string
  }
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /** Set when the customer swipe-replies to one of our messages. */
  context?: { id: string }
}

export interface NormalisedStatus {
  /** Provider's message id — same value the row in `messages.message_id`
   *  was set to when we sent (or for inbound, when we received) the
   *  message. */
  id: string
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'replied' | 'failed'
  /** Unix epoch (number). Some providers send seconds, some millis;
   *  the provider normalises to seconds. */
  timestamp: number
  recipient_id: string
}

export type NormalisedEvent =
  | {
      kind: 'message'
      message: NormalisedMessage
      contact: { phone: string; name: string }
    }
  | { kind: 'status'; status: NormalisedStatus }
  | { kind: 'template_change'; field: string; value: unknown }
  | {
      kind: 'connection_update'
      state: 'connected' | 'disconnected' | 'connecting'
      reason?: string
    }

// ============================================================
// The interface
// ============================================================

export interface WhatsAppProvider {
  // Sending ----------------------------------------------------------
  sendText(args: SendTextArgs): Promise<SendResult>
  sendMedia(args: SendMediaArgs): Promise<SendResult>
  sendTemplate(args: SendTemplateArgs): Promise<SendResult>
  sendReaction(args: SendReactionArgs): Promise<SendResult>
  sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<SendResult>
  sendInteractiveList(args: SendInteractiveListArgs): Promise<SendResult>

  // Settings → "Test Connection" ------------------------------------
  verifyCredentials(): Promise<VerifyCredentialsResult>

  // Webhook authenticity --------------------------------------------
  /**
   * True when the request is authentic. Providers that don't sign
   * their webhooks (Evolution) may instead rely on a URL-shared
   * secret checked by the route — in that case this returns true
   * unconditionally and the route enforces the URL-secret check
   * before calling parseWebhook.
   */
  verifyWebhookSignature(rawBody: string, signature: string | null): boolean

  // Webhook payload → normalised events -----------------------------
  /**
   * Parse a webhook POST body into NormalisedEvents. Async because
   * it may resolve media URLs against the provider. Throws on a
   * payload that's so malformed no events can be extracted — the
   * route handler should log and 200 anyway so the provider doesn't
   * retry forever on a bad payload.
   */
  parseWebhook(rawBody: string): Promise<NormalisedEvent[]>
}
