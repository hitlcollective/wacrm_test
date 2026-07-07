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
 *   POST   /webhook/set/{name}              — { webhook: { enabled, url, webhook_by_events, events, webhook_base64? } }
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
    /** Real Evolution v2 nests the apikey under `instance`. */
    apikey?: string
    /** Some v2 builds expose it as `token` instead. */
    token?: string
    /** Some v2 builds echo the slug under `instance` (not just
     *  at the top level). We don't currently use it (we sent the
     *  name ourselves in the request body) but typed for
     *  future-proofing. */
    instanceName?: string
  }
  state?: string
  connectionStatus?: string
  ownerJid?: string | null
  jid?: string | null
  response?: { message?: string | string[] }
  message?: string | string[]
}

/**
 * Walk an unknown response object and return the first string
 * value whose key looks like an apikey/token holder. Used as
 * a last-resort fallback when the canonical paths all miss
 * (which would otherwise leave the customer stuck on a 'no
 * apikey' error). We only inspect two levels deep so a
 * pathological deep object doesn't burn CPU.
 */
function findApikeyByKeyName(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null
  const KEY_RE = /apikey|api[_-]?key|secret|token/i
  const stack: unknown[] = [obj]
  let depth = 0
  while (stack.length && depth < 4) {
    depth++
    const next = stack.shift()
    if (!next || typeof next !== 'object') continue
    for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length >= 8 && KEY_RE.test(k)) {
        return v
      }
      if (v && typeof v === 'object') stack.push(v)
    }
  }
  return null
}

/**
 * Recursively summarise an unknown response by listing the
 * keys at each nesting level. Used for the diagnostic
 * console.warn above — we never include the values, so a
 * redacted log line is safe to share.
 */
function summariseKeys(
  obj: unknown,
  depth = 0,
  maxDepth = 3,
): unknown {
  if (depth > maxDepth) return '…'
  if (obj === null || obj === undefined) return obj
  if (Array.isArray(obj)) {
    return obj.length <= 2
      ? obj.map((v) => summariseKeys(v, depth + 1, maxDepth))
      : `[…${obj.length} items]`
  }
  if (typeof obj !== 'object') return '?'
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = summariseKeys(v, depth + 1, maxDepth)
    } else if (Array.isArray(v)) {
      out[k] = v.length <= 2 ? '[…]' : `[…${v.length}]`
    } else {
      out[k] = '?'
    }
  }
  return out
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
    // Several response shapes are seen in the wild across
    // Evolution v1 / v2 and various forks. Pull from each in
    // turn and pick the first non-empty string.
    //
    //   v1:         { apikey, hash }
    //   v2 alt:     { hash: { apikey, hash } }            (some forks)
    //   v2:         { instance: { apikey, token, ... },
    //                  hash, qrcode }                     (canonical)
    //   rare:       { auth: { token, apikey } }
    //   rare:       { data: { apikey } }
    //   rare:       { token } (hash IS the apikey)
    //
    // If we still find nothing, we walk the response for any
    // field whose key looks like an apikey holder. This is a
    // last resort — it only fires if none of the named paths
    // matched.
    const hashObj = typeof hash === 'object' && hash !== null ? hash : null
    const authObj =
      typeof r.auth === 'object' && r.auth !== null
        ? (r.auth as Record<string, unknown>)
        : null
    const dataObj =
      typeof r.data === 'object' && r.data !== null
        ? (r.data as Record<string, unknown>)
        : null

    const candidates: unknown[] = [
      hashObj?.apikey,
      r.apikey,
      r.instance?.apikey,
      r.instance?.token,
      authObj?.apikey,
      authObj?.token,
      dataObj?.apikey,
      dataObj?.token,
      // Some very old builds used the hash field as the apikey
      // directly. Last-ditch fallback (only if it's plausibly
      // long enough to be a key, not a short status hash).
      typeof hash === 'string' && hash.length > 16 ? hash : undefined,
    ]
    let apikey = candidates.find(
      (c) => typeof c === 'string' && c.length > 0,
    ) as string | undefined

    // Last-resort: walk the response for any key whose NAME
    // suggests an apikey/token holder. We only do this if
    // the named paths above all failed — it's noisy on
    // well-formed responses.
    if (!apikey) {
      apikey = findApikeyByKeyName(r) ?? undefined
    }

    if (!apikey) {
      // Diagnostic breadcrumb: tell us exactly which fields
      // Evolution returned so we can add a new shape to the
      // list above. We log KEYS only, never values, so we
      // don't accidentally exfiltrate the apikey in shared
      // logs.
      console.warn(
        '[EvolutionLifecycleClient.createInstance] ' +
          'could not find an apikey in the response. ' +
          'Response keys: ' +
          JSON.stringify(summariseKeys(r)),
      )
    }
    return {
      instanceName: r.instance?.instanceName ?? instanceName,
      apikey: apikey ?? '',
      hash:
        typeof hash === 'string'
          ? hash
          : hashObj?.hash,
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
        webhook: {
          enabled: true,
          url: args.url,
          webhook_by_events: false,
          // base64 off — we read raw JSON, the inbox renders inline
          // media URLs that Evolution hands us.
          webhook_base64: false,
          events,
        },
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
