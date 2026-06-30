/**
 * Evolution API provider.
 *
 * Evolution API is a self-hosted gateway for WhatsApp. It wraps
 * either the unofficial Baileys Web session or the official Meta
 * Cloud API and exposes a unified REST surface. We integrate with
 * the Baileys path (the default; the "free WhatsApp" reason most
 * people pick Evolution).
 *
 * Reference: https://github.com/evolution-foundation/evolution-api
 * Reference: https://docs.evolutionfoundation.com.br
 *
 * What lives here:
 *   - Sending: REST calls to `{baseUrl}/message/send{Text,Media,Buttons,List,Reaction}/{instance}`.
 *     Auth via the `apikey` header. The instance is paired with a
 *     phone via a QR code; wacrm stores the resulting apikey
 *     encrypted (same AES-GCM helper as Meta's access_token).
 *   - `verifyCredentials()` → `GET /instance/connectionState/{name}`.
 *     Returns the connected JID as the displayName.
 *   - `verifyWebhookSignature()` → no-op. Evolution doesn't sign
 *     payloads. The route enforces a `?secret=…` URL parameter
 *     against `whatsapp_config.evolution_webhook_url_secret` before
 *     calling `parseWebhook` — that's the only authentication.
 *   - `parseWebhook()` translates Evolution's flat event payload
 *     (`{ event, instance, data }`) into NormalisedEvents. The
 *     most common events are MESSAGES_UPSERT (inbound message),
 *     MESSAGES_UPDATE (delivery ack), and CONNECTION_UPDATE.
 *
 * What's NOT here (lands in PR 2):
 *   - Instance create / QR pairing (`POST /instance/create`,
 *     `GET /instance/connect/{name}` for the QR).
 *   - Webhook registration (`POST /webhook/set/{name}`).
 *   - Per-message media persistence to Supabase Storage.
 *     v2 returns short-lived base64 URLs that we should mirror
 *     to long-term storage on inbound; for PR 1 the URL is passed
 *     through and the inbox renders whatever it gets.
 *
 * v1 status: this provider compiles and is exercised by mocked
 * tests, but real-webhook integration is gated on PR 2 work where
 * we wire up the actual UI + registration flow.
 */

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

export interface EvolutionProviderConfig {
  /** Base URL of the Evolution deployment, e.g. `https://evo.example.com`.
   *  No trailing slash. The route stores whatever the operator types;
   *  we strip a trailing slash here defensively. */
  baseUrl: string
  /** Instance name as registered with Evolution. */
  instanceName: string
  /** Instance apikey (decrypted). Sent as the `apikey` header on every
   *  Evolution call. */
  apiKey: string
}

export class EvolutionProvider implements WhatsAppProvider {
  private config: EvolutionProviderConfig
  private base: string

  constructor(config: EvolutionProviderConfig) {
    this.config = config
    this.base = config.baseUrl.replace(/\/$/, '')
  }

  // ============================================================
  // Sending
  // ============================================================

  async sendText(args: SendTextArgs): Promise<SendResult> {
    const r = await this.evolutionFetch<{ key?: { id?: string } }>(
      'POST',
      `/message/sendText/${this.config.instanceName}`,
      {
        number: this.normalisePhone(args.to),
        text: args.text,
        ...(args.contextMessageId
          ? { quoted: { key: { id: args.contextMessageId } } }
          : {}),
      },
    )
    return { messageId: r.key?.id ?? '' }
  }

  async sendMedia(args: SendMediaArgs): Promise<SendResult> {
    const r = await this.evolutionFetch<{ key?: { id?: string } }>(
      'POST',
      `/message/sendMedia/${this.config.instanceName}`,
      {
        number: this.normalisePhone(args.to),
        mediatype: args.kind,
        media: args.link,
        // Audio carries no caption (Meta-equivalent rule carried over:
        // image / video / document accept a caption; audio does not).
      ...(args.caption && args.kind !== "audio" ? { caption: args.caption } : {}),
        ...(args.filename ? { fileName: args.filename } : {}),
        ...(args.contextMessageId
          ? { quoted: { key: { id: args.contextMessageId } } }
          : {}),
      },
    )
    return { messageId: r.key?.id ?? '' }
  }

  async sendTemplate(_args: SendTemplateArgs): Promise<SendResult> {
    // Evolution doesn't have Meta's template approval system. The
    // templates UI surface is hidden when provider === 'evolution'
    // (PR 3 work), so this method is unreachable in v1. Throw
    // loudly if a future caller forgets that gate.
    throw new Error(
      'EvolutionProvider.sendTemplate is not implemented. Templates require Meta; use Flows for structured outbound on Evolution.',
    )
  }

  async sendReaction(args: SendReactionArgs): Promise<SendResult> {
    const r = await this.evolutionFetch<{ key?: { id?: string } }>(
      'POST',
      `/message/sendReaction/${this.config.instanceName}`,
      {
        number: this.normalisePhone(args.to),
        key: { id: args.targetMessageId },
        reaction: args.emoji,
      },
    )
    return { messageId: r.key?.id ?? '' }
  }

  async sendInteractiveButtons(
    args: SendInteractiveButtonsArgs,
  ): Promise<SendResult> {
    const r = await this.evolutionFetch<{ key?: { id?: string } }>(
      'POST',
      `/message/sendButtons/${this.config.instanceName}`,
      {
        number: this.normalisePhone(args.to),
        title: args.bodyText,
        description: args.bodyText,
        footer: args.footerText,
        buttons: args.buttons.map((b) => ({
          type: 'reply',
          displayText: b.title,
          id: b.id,
        })),
        ...(args.headerText ? { header: { title: args.headerText } } : {}),
      },
    )
    return { messageId: r.key?.id ?? '' }
  }

  async sendInteractiveList(
    args: SendInteractiveListArgs,
  ): Promise<SendResult> {
    const r = await this.evolutionFetch<{ key?: { id?: string } }>(
      'POST',
      `/message/sendList/${this.config.instanceName}`,
      {
        number: this.normalisePhone(args.to),
        title: args.bodyText,
        description: args.bodyText,
        buttonText: args.buttonLabel,
        footer: args.footerText,
        sections: args.sections.map((s) => ({
          ...(s.title ? { title: s.title } : {}),
          rows: s.rows.map((r) => ({
            id: r.id,
            title: r.title,
            ...(r.description ? { description: r.description } : {}),
          })),
        })),
      },
    )
    return { messageId: r.key?.id ?? '' }
  }

  // ============================================================
  // Settings → "Test Connection"
  // ============================================================

  async verifyCredentials(): Promise<VerifyCredentialsResult> {
    const r = await this.evolutionFetch<{
      instance?: { state?: string; ownerJid?: string | null }
    }>('GET', `/instance/connectionState/${this.config.instanceName}`)
    return {
      displayName: r.instance?.ownerJid ?? this.config.instanceName,
      metadata: {
        state: r.instance?.state,
        instance_name: this.config.instanceName,
      },
    }
  }

  // ============================================================
  // Webhook
  // ============================================================

  /** Evolution doesn't sign webhook payloads. Authentication is the
   *  `?secret=…` URL parameter the route checks before calling
   *  parseWebhook, so this method is a no-op. */
  verifyWebhookSignature(_rawBody: string, _signature: string | null): boolean {
    return true
  }

  async parseWebhook(rawBody: string): Promise<NormalisedEvent[]> {
    let body: EvolutionWebhookBody
    try {
      body = JSON.parse(rawBody) as EvolutionWebhookBody
    } catch {
      return []
    }

    const out: NormalisedEvent[] = []

    switch (body.event) {
      case 'MESSAGES_UPSERT': {
        // MESSAGES_UPSERT fires for both incoming AND outgoing
        // messages. Filter to `fromMe === false` so we don't
        // re-insert our own sends.
        const messages = this.coerceArray(
          body.data as EvolutionMessage | EvolutionMessage[] | undefined
        )
        for (const m of messages) {
          if (m.key?.fromMe) continue
          const normalised = this.normaliseMessage(m)
          if (normalised) {
            out.push({
              kind: 'message',
              message: normalised,
              contact: {
                phone: this.jidToPhone(m.key?.remoteJid ?? ''),
                name: m.pushName ?? this.jidToPhone(m.key?.remoteJid ?? ''),
              },
            })
          }
        }
        break
      }
      case 'MESSAGES_UPDATE': {
        // MESSAGES_UPDATE can be a single object or an array.
        const updates = this.coerceArray(
          body.data as EvolutionStatusUpdate | EvolutionStatusUpdate[] | undefined
        )
        for (const u of updates) {
          const id = u.key?.id
          if (!id) continue
          const statusCode = u.update?.status
          out.push({
            kind: 'status',
            status: {
              id,
              status: evolutionStatusToInternal(statusCode),
              timestamp: typeof u.update?.timestamp === 'number'
                ? Math.floor(u.update.timestamp / 1000)
                : Math.floor(Date.now() / 1000),
              recipient_id: this.jidToPhone(u.key?.remoteJid ?? ''),
            },
          })
        }
        break
      }
      case 'CONNECTION_UPDATE': {
        // data is `{ instance: string, state: 'open' | 'close' | 'connecting', ... }`
        const d = body.data as { state?: string; instance?: string } | undefined
        if (d?.state) {
          out.push({
            kind: 'connection_update',
            state: d.state === 'open' ? 'connected' : d.state === 'connecting' ? 'connecting' : 'disconnected',
          })
        }
        break
      }
      // QRCODE_UPDATED, TYPEBOT_START, CHAT_PRESENCE, etc. — ignored
      // for v1. They don't carry customer-facing data we persist.
      default:
        break
    }

    return out
  }

  // ============================================================
  // Internals
  // ============================================================

  private async evolutionFetch<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.base}${path}`
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: this.config.apiKey,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) {
      let message = `Evolution API error: ${response.status}`
      try {
        const data = (await response.json()) as {
          response?: { message?: string | string[] }
          message?: string
        }
        const m = data.response?.message ?? data.message
        if (typeof m === 'string') message = m
        else if (Array.isArray(m) && m.length) message = m[0]
      } catch {
        // Non-JSON body — keep the fallback.
      }
      throw new Error(message)
    }
    return (await response.json()) as T
  }

  private normalisePhone(phone: string): string {
    // Evolution accepts the digits-only form. Strip +, spaces, dashes.
    return phone.replace(/[^\d]/g, '')
  }

  private jidToPhone(jid: string): string {
    // Evolution uses `<digits>@s.whatsapp.net` for DMs. Group JIDs
    // are `<digits>-<timestamp>@g.us`; for those we return the bare
    // jid since we don't have a phone to display.
    const at = jid.indexOf('@')
    if (at < 0) return jid
    const local = jid.slice(0, at)
    if (jid.endsWith('@s.whatsapp.net')) {
      return local.replace(/[^\d]/g, '')
    }
    return local
  }

  private coerceArray<T>(v: T | T[] | undefined | null): T[] {
    if (v == null) return []
    return Array.isArray(v) ? v : [v]
  }

  /**
   * Convert an Evolution inbound message into a NormalisedMessage.
   * Returns null for messages we can't map (e.g. unsupported
   * messageType, missing remoteJid).
   */
  private normaliseMessage(m: EvolutionMessage): NormalisedMessage | null {
    if (!m.key?.id || !m.key?.remoteJid) return null

    const base = {
      id: m.key.id,
      from: this.jidToPhone(m.key.remoteJid),
      timestamp: String(
        typeof m.messageTimestamp === 'number'
          ? m.messageTimestamp
          : Math.floor(Date.now() / 1000),
      ),
    }
    const ctx = m.message?.extendedTextMessage?.contextInfo?.stanzaId
      ? { id: m.message.extendedTextMessage.contextInfo.stanzaId }
      : undefined

    const msg = m.message
    if (!msg) return null

    // Text body — Evolution puts free-form text in `conversation`
    // for short messages and in `extendedTextMessage.text` for
    // replies/quotes. Either is a text message for our purposes.
    if (typeof msg.conversation === 'string') {
      return {
        ...base,
        type: 'text',
        text: { body: msg.conversation },
        ...(ctx ? { context: ctx } : {}),
      }
    }
    if (msg.extendedTextMessage?.text) {
      return {
        ...base,
        type: 'text',
        text: { body: msg.extendedTextMessage.text },
        ...(ctx ? { context: ctx } : {}),
      }
    }
    if (msg.imageMessage) {
      return {
        ...base,
        type: 'image',
        image: {
          id: msg.imageMessage.url ?? m.key.id,
          mime_type: msg.imageMessage.mimetype ?? 'image/jpeg',
          ...(msg.imageMessage.caption ? { caption: msg.imageMessage.caption } : {}),
          ...(msg.imageMessage.url ? { url: msg.imageMessage.url } : {}),
        },
        ...(ctx ? { context: ctx } : {}),
      }
    }
    if (msg.videoMessage) {
      return {
        ...base,
        type: 'video',
        video: {
          id: msg.videoMessage.url ?? m.key.id,
          mime_type: msg.videoMessage.mimetype ?? 'video/mp4',
          ...(msg.videoMessage.caption ? { caption: msg.videoMessage.caption } : {}),
          ...(msg.videoMessage.url ? { url: msg.videoMessage.url } : {}),
        },
        ...(ctx ? { context: ctx } : {}),
      }
    }
    if (msg.documentMessage) {
      return {
        ...base,
        type: 'document',
        document: {
          id: msg.documentMessage.url ?? m.key.id,
          mime_type: msg.documentMessage.mimetype ?? 'application/octet-stream',
          ...(msg.documentMessage.fileName ? { filename: msg.documentMessage.fileName } : {}),
          ...(msg.documentMessage.caption ? { caption: msg.documentMessage.caption } : {}),
          ...(msg.documentMessage.url ? { url: msg.documentMessage.url } : {}),
        },
        ...(ctx ? { context: ctx } : {}),
      }
    }
    if (msg.audioMessage) {
      return {
        ...base,
        type: 'audio',
        audio: {
          id: msg.audioMessage.url ?? m.key.id,
          mime_type: msg.audioMessage.mimetype ?? 'audio/ogg',
          ...(msg.audioMessage.url ? { url: msg.audioMessage.url } : {}),
        },
        ...(ctx ? { context: ctx } : {}),
      }
    }
    if (msg.stickerMessage) {
      return {
        ...base,
        type: 'sticker',
        sticker: {
          id: msg.stickerMessage.url ?? m.key.id,
          mime_type: msg.stickerMessage.mimetype ?? 'image/webp',
          ...(msg.stickerMessage.url ? { url: msg.stickerMessage.url } : {}),
        },
        ...(ctx ? { context: ctx } : {}),
      }
    }
    if (msg.locationMessage) {
      const loc = msg.locationMessage
      return {
        ...base,
        type: 'location',
        location: {
          latitude: loc.degreesLatitude ?? 0,
          longitude: loc.degreesLongitude ?? 0,
          ...(loc.name ? { name: loc.name } : {}),
          ...(loc.address ? { address: loc.address } : {}),
        },
      }
    }
    if (msg.reactionMessage) {
      return {
        ...base,
        type: 'reaction',
        reaction: {
          message_id: msg.reactionMessage.key?.id ?? '',
          emoji: msg.reactionMessage.text ?? '',
        },
      }
    }
    // Buttons/list replies — Evolution normalises these into a
    // `buttonsResponseMessage` or `listResponseMessage` field.
    if (msg.buttonsResponseMessage) {
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: {
            id: msg.buttonsResponseMessage.selectedButtonId ?? '',
            title: msg.buttonsResponseMessage.selectedDisplayText ?? '',
          },
        },
        text: {
          body:
            msg.buttonsResponseMessage.selectedDisplayText ??
            msg.buttonsResponseMessage.selectedButtonId ??
            '[Button reply]',
        },
      }
    }
    if (msg.listResponseMessage) {
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: {
            id: msg.listResponseMessage.singleSelectReply?.selectedRowId ?? '',
            title:
              msg.listResponseMessage.title ??
              msg.listResponseMessage.description ??
              '[List reply]',
          },
        },
        text: {
          body:
            msg.listResponseMessage.title ??
            msg.listResponseMessage.description ??
            '[List reply]',
        },
      }
    }
    // Unknown message type — fall back to text so the message still
    // lands in the inbox and the operator sees the body in the
    // server log.
    return {
      ...base,
      type: 'text',
      text: { body: `[Unsupported Evolution messageType]` },
    }
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Evolution's MESSAGES_UPDATE.status is numeric. The codes are
 * inherited from Baileys:
 *   1 = ERROR
 *   2 = PENDING (sent to the phone, not yet delivered to the user)
 *   3 = SERVER_ACK (delivered to the recipient's device)
 *   4 = PLAYED (audio/voice note played)
 *
 * v2's docs are a bit inconsistent about the exact ladder; the
 * safe mapping is to treat anything ≤ 2 as 'sent', 3 as 'delivered',
 * 4 as 'read'. We never go to 'replied' here — replies are
 * distinct MESSAGES_UPSERT events.
 */
function evolutionStatusToInternal(
  code: number | undefined,
): 'pending' | 'sent' | 'delivered' | 'read' | 'failed' {
  switch (code) {
    case 1:
      return 'failed'
    case 2:
      return 'sent'
    case 3:
      return 'delivered'
    case 4:
      return 'read'
    default:
      // Unknown code — degrade to 'sent' so the row at least gets a
      // valid CHECK-constrained value.
      return 'sent'
  }
}

// ============================================================
// Local types for Evolution's webhook payload
// ============================================================
//
// These are intentionally loose. Evolution's v2 payload is loosely
// typed in the upstream TS client and we don't want to break on a
// new field. The narrow `evolutionStatusToInternal` + `normaliseMessage`
// paths pick out the fields we care about; the rest of the payload
// is ignored.

interface EvolutionWebhookBody {
  event?: string
  instance?: string
  // `data` is single object or array depending on event. We coerce.
  data?: EvolutionMessage | EvolutionMessage[] | EvolutionStatusUpdate | EvolutionStatusUpdate[] | { state?: string; instance?: string } | unknown
}

interface EvolutionMessage {
  key?: {
    remoteJid?: string
    fromMe?: boolean
    id?: string
  }
  pushName?: string
  messageTimestamp?: number
  message?: {
    conversation?: string
    extendedTextMessage?: {
      text?: string
      contextInfo?: { stanzaId?: string }
    }
    imageMessage?: {
      url?: string
      mimetype?: string
      caption?: string
    }
    videoMessage?: {
      url?: string
      mimetype?: string
      caption?: string
    }
    documentMessage?: {
      url?: string
      mimetype?: string
      fileName?: string
      caption?: string
    }
    audioMessage?: {
      url?: string
      mimetype?: string
    }
    stickerMessage?: {
      url?: string
      mimetype?: string
    }
    locationMessage?: {
      degreesLatitude?: number
      degreesLongitude?: number
      name?: string
      address?: string
    }
    reactionMessage?: {
      key?: { id?: string }
      text?: string
    }
    buttonsResponseMessage?: {
      selectedButtonId?: string
      selectedDisplayText?: string
    }
    listResponseMessage?: {
      singleSelectReply?: { selectedRowId?: string }
      title?: string
      description?: string
    }
  }
}

interface EvolutionStatusUpdate {
  key?: { id?: string; remoteJid?: string }
  update?: { status?: number; timestamp?: number }
}
