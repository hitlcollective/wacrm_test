/**
 * Evolution API — instance lifecycle client.
 *
 * Wraps the five endpoints we need for the "Connect with Evolution"
 * Settings card. The provider class in `./providers/evolution.ts`
 * handles SEND + parseWebhook (because they share a single per-provider
 * config), while this client handles LIFECYCLE (create / pair /
 * status / delete / register-webhook), which is only called from
 * the Settings UI and the webhook route registration step.
 *
 * Reference: https://docs.evolutionfoundation.com.br
 *   POST   /instance/create                 — { instanceName, number?, integration? }
 *   GET    /instance/connect/{name}         — { pairingCode, base64, count }
 *   GET    /instance/connectionState/{name} — { instance: { state, ownerJid } }
 *   DELETE /instance/delete/{name}          — empty 200
 *   POST   /webhook/set/{name}              — { url, webhook_by_events, events, webhook_base64? }
 *
 * Why a separate client from the provider:
 *   The provider carries an apikey + baseUrl that the customer pastes
 *   AFTER the instance is created. The lifecycle client here uses the
 *   GLOBAL Evolution apikey (a fixed token set on the server side, env
 *   var `EVOLUTION_GLOBAL_APIKEY`) and a fixed base URL. The two
 *   surfaces live in different security contexts: the per-instance
 *   apikey is the customer's, the global apikey is the operator's.
 */

import crypto from 'crypto'

export interface EvolutionLifecycleConfig {
  baseUrl: string
  /** The global apikey configured on the Evolution server itself. Used
   *  for create / connect / status / delete. NOT the per-instance apikey
   *  that comes back from /instance/create (that one is what the
   *  EvolutionProvider uses to send). */
  globalApiKey: string
}

export interface CreateInstanceArgs {
  /** Auto-generated if not provided. We use a slug like
   *  `wacrm-{randomShort}` so multiple wacrm installs on the same
   *  Evolution server don't collide. */
  instanceName?: string
  /** The customer's WhatsApp number in E.164-ish form (no `+`). Used
   *  by some Baileys integrations to pre-fill the pairing hint; the
   *  official Cloud API integration ignores it. */
  number?: string
}

export interface CreateInstanceResult {
  instanceName: string
  /** The per-instance apikey returned by Evolution. This is what the
   *  EvolutionProvider carries. The UI saves it to whatsapp_config
   *  right after creation so subsequent sends go through. */
  apikey: string
  /** The hash Evolution returns alongside the apikey (used by some
   *  versions to confirm the credentials work). v2 returns it; v1
   *  may not. We don't depend on it. */
  hash?: string
}

export interface QrResponse {
  /** base64-encoded PNG. Render directly in
   *  `<img src={`data:image/png;base64,${qr}`} />`. */
  pairingCode?: string
  /** Evolution's "code" form (the raw text the WhatsApp app shows
   *  under the QR) — useful for the "Or paste this code" fallback
   *  some operators want. Not all versions include it. */
  base64?: string
  count?: number
}

export interface StatusResponse {
  state: 'open' | 'close' | 'connecting' | 'refused' | 'disconnected' | string | null
  ownerJid?: string | null
}

export interface RegisterWebhookArgs {
  instanceName: string
  /** The full wacrm webhook URL Evolution should POST to. The UI
   *  computes this from window.location.origin + path. */
  url: string
  /** Path/query secret the route checks before parsing. */
  secret: string
  /** Events we want Evolution to send. The MESSAGES_UPSERT +
   *  MESSAGES_UPDATE + CONNECTION_UPDATE triad covers everything the
   *  EvolutionProvider.parseWebhook understands. */
  events?: string[]
}

export class EvolutionLifecycleError extends Error {
  status: number
  body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'EvolutionLifecycleError'
    this.status = status
    this.body = body
  }
}

type AnyResponse = Record<string, unknown> & {
  apikey?: string
  hash?:
    | string
    | {
        apikey?: string
        hash?: string
      }
  pairingCode?: string
  base64?: string
  count?: number
  instance?: {
    state?: string
    connectionStatus?: string
    ownerJid?: string | null
    jid?: string | null
  }
  state?: string
  connectionStatus?: string
  ownerJid?: string | null
  jid?: string | null
  response?: { message?: string | string[] }
  message?: string | string[]
}

export class EvolutionLifecycleClient {
  private base: string
  private apiKey: string

  constructor(config: EvolutionLifecycleConfig) {
    this.base = config.baseUrl.replace(/\/$/, '')
    this.apiKey = config.globalApiKey
  }

  async createInstance(
    args: CreateInstanceArgs = {},
  ): Promise<CreateInstanceResult> {
    const instanceName = args.instanceName ?? this.generateInstanceName()
    const body = {
      instanceName,
      qrcode: true,
      // integration: 'WHATSAPP-BAILEYS' is the default. The
      // 'WHATSAPP-BUSINESS' integration is the official Meta path
      // and would defeat the point of self-hosting; we leave the
      // default explicit for clarity.
      integration: 'WHATSAPP-BAILEYS',
      ...(args.number ? { number: args.number } : {}),
    }
    const r = (await this.fetch('POST', '/instance/create', body)) as AnyResponse
    const hash = r.hash
    return {
      instanceName,
      apikey:
        (typeof hash === 'object' && hash !== null ? hash.apikey : undefined) ??
        r.apikey ??
        '',
      hash:
        typeof hash === 'string'
          ? hash
          : typeof hash === 'object' && hash !== null
            ? hash.hash
            : undefined,
    }
  }

  async getQr(instanceName: string): Promise<QrResponse> {
    const r = (await this.fetch(
      'GET',
      `/instance/connect/${encodeURIComponent(instanceName)}`,
    )) as AnyResponse
    return {
      pairingCode:
        typeof r.pairingCode === 'string' ? r.pairingCode : undefined,
      base64: typeof r.base64 === 'string' ? r.base64 : undefined,
      count: typeof r.count === 'number' ? r.count : undefined,
    }
  }

  async getStatus(instanceName: string): Promise<StatusResponse> {
    const r = (await this.fetch(
      'GET',
      `/instance/connectionState/${encodeURIComponent(instanceName)}`,
    )) as AnyResponse
    // Two response shapes are seen in the wild: v2 nests under
    // `instance`, v1 returns flat. We normalise.
    const inst = r.instance ?? r
    return {
      state: inst?.state ?? inst?.connectionStatus ?? null,
      ownerJid: inst?.ownerJid ?? inst?.jid ?? null,
    }
  }

  async deleteInstance(instanceName: string): Promise<void> {
    await this.fetch('DELETE', `/instance/delete/${encodeURIComponent(instanceName)}`)
  }

  async registerWebhook(args: RegisterWebhookArgs): Promise<void> {
    const events = args.events ?? [
      'MESSAGES_UPSERT',
      'MESSAGES_UPDATE',
      'CONNECTION_UPDATE',
    ]
    await this.fetch(
      'POST',
      `/webhook/set/${encodeURIComponent(args.instanceName)}`,
      {
        url: args.url,
        webhook_by_events: false,
        // base64 off — we read raw JSON, the inbox renders inline
        // media URLs that Evolution hands us.
        webhook_base64: false,
        events,
      },
    )
  }

  // ============================================================
  // Internals
  // ============================================================

  private generateInstanceName(): string {
    // 10 hex chars + 4 hex. Plenty of entropy to avoid collisions on
    // a single Evolution instance; if the server still has it, the
    // create call returns 403 and the UI retries with a fresh name.
    const a = crypto.randomBytes(5).toString('hex')
    const b = crypto.randomBytes(2).toString('hex')
    return `wacrm-${a}-${b}`
  }

  private async fetch(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${this.base}${path}`
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: this.apiKey,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text.length ? JSON.parse(text) : null
    } catch {
      parsed = text
    }
    if (!res.ok) {
      // Evolution returns 4xx with `{ response: { message: [...] } }`
      // or 5xx with `{ message: '...' }`. Pull the most informative
      // field we can find.
      const p = parsed as AnyResponse
      const m = p?.response?.message ?? p?.message
      const message =
        (Array.isArray(m) && m[0]) ||
        (typeof m === 'string' && m) ||
        `Evolution ${method} ${path} failed: ${res.status}`
      throw new EvolutionLifecycleError(message, res.status, parsed)
    }
    return parsed
  }
}
