/**
 * Tests for the Evolution re-register-webhook route.
 *
 * Coverage:
 *   - Auth + account resolution
 *   - Per-row validation (provider, completeness)
 *   - Env-var guards (NEXT_PUBLIC_APP_URL, EVOLUTION_GLOBAL_APIKEY)
 *   - Decrypt success + failure
 *   - Success path: correct URL + secret handed to Evolution
 *   - Evolution rejection surfaces as 502
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Module mocks (hoisted)
// ============================================================

const getUserMock = vi.fn()
const fromMock = vi.fn()

const supabaseMock = {
  auth: { getUser: getUserMock },
  from: fromMock,
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

const registerWebhookMock = vi.fn(async (_args?: unknown) => undefined)
// vi.fn() doesn't preserve `new` semantics with arrow-function
// implementations — we need a class so `new EvolutionLifecycleClient(...)`
// in the route actually constructs the mock.
// Track constructor args so the test can assert on what the route
// handed the lifecycle client.
const lastClientConfig: { value: unknown } = { value: null }
class EvolutionLifecycleClientMock {
  registerWebhook = registerWebhookMock
  constructor(config: unknown) {
    lastClientConfig.value = config
  }
}

vi.mock('@/lib/whatsapp/evolution/instance-client', () => ({
  EvolutionLifecycleClient: EvolutionLifecycleClientMock,
  EvolutionLifecycleError: class EvolutionLifecycleError extends Error {
    status: number
    body: unknown
    constructor(message: string, status: number, body: unknown) {
      super(message)
      this.name = 'EvolutionLifecycleError'
      this.status = status
      this.body = body
    }
  },
}))

const decryptMock = vi.fn((ciphertext: string) => `decrypted:${ciphertext}`)
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: decryptMock,
  encrypt: vi.fn(),
  isLegacyFormat: vi.fn(),
}))

const { POST } = await import('./route')

// ============================================================
// Helpers
// ============================================================

interface ConfigRow {
  id?: string
  provider: 'evolution' | 'meta'
  evolution_base_url?: string | null
  evolution_instance_name?: string | null
  evolution_apikey?: string | null
  evolution_webhook_url_secret?: string | null
}

/**
 * Model the `.from('x').select(...).eq(...).maybeSingle()` chain so
 * the route's profile + config reads return what each test wants.
 * The route makes two `from` calls in order: first `profiles` to
 * resolve the account id, then `whatsapp_config` to read the row.
 */
function setupChains(
  profileResult: { account_id: string } | null,
  configResult: ConfigRow | null,
) {
  // Profile chain
  const profileChain = {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: profileResult,
          error: null,
        })),
      })),
    })),
  }
  // Config chain
  const configChain = {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: configResult,
          error: null,
        })),
      })),
    })),
  }
  // First call returns profile, second returns config. The cast is
  // limited to the supabase surface area; assertions below use
  // typed `Mock` lookups instead of `as any[]`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fromMock.mockReturnValueOnce(profileChain as any).mockReturnValueOnce(configChain as any)
}

function makeConfig(overrides: Partial<ConfigRow> = {}): ConfigRow {
  return {
    id: 'row-1',
    provider: 'evolution',
    evolution_base_url: 'https://evo.example.com',
    evolution_instance_name: 'wacrm-test-1234',
    evolution_apikey: 'enc-apikey',
    evolution_webhook_url_secret: 'enc-secret',
    ...overrides,
  }
}

beforeEach(() => {
  getUserMock.mockReset()
  fromMock.mockReset()
  registerWebhookMock.mockReset()
  decryptMock.mockClear()
  decryptMock.mockImplementation((c: string) => `decrypted:${c}`)
  // Default: env vars are set.
  vi.stubEnv('EVOLUTION_GLOBAL_APIKEY', 'test-global-apikey')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
  // Default: registerWebhook resolves successfully.
  registerWebhookMock.mockResolvedValue(undefined)
  // Default: signed-in user with a profile.
  getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

// ============================================================
// Tests
// ============================================================

describe('POST /api/whatsapp/evolution/instance/webhook — auth', () => {
  it('returns 401 when no user is signed in', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null })
    const res = await POST()
    expect(res.status).toBe(401)
    expect(registerWebhookMock).not.toHaveBeenCalled()
  })

  it('returns 401 when auth.getUser errors', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'u' } },
      error: new Error('boom'),
    })
    const res = await POST()
    expect(res.status).toBe(401)
  })

  it('returns 403 when the profile has no account_id', async () => {
    setupChains(null, null)
    const res = await POST()
    expect(res.status).toBe(403)
    expect(registerWebhookMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/whatsapp/evolution/instance/webhook — config', () => {
  it('returns 404 when the row is for a different provider', async () => {
    setupChains({ account_id: 'acc-1' }, makeConfig({ provider: 'meta' }))
    const res = await POST()
    expect(res.status).toBe(404)
    expect(registerWebhookMock).not.toHaveBeenCalled()
  })

  it('returns 404 when there is no whatsapp_config row at all', async () => {
    setupChains({ account_id: 'acc-1' }, null)
    const res = await POST()
    expect(res.status).toBe(404)
    expect(registerWebhookMock).not.toHaveBeenCalled()
  })

  it('returns 409 when evolution_base_url is missing', async () => {
    setupChains(
      { account_id: 'acc-1' },
      makeConfig({ evolution_base_url: null }),
    )
    const res = await POST()
    expect(res.status).toBe(409)
  })

  it('returns 409 when evolution_instance_name is missing', async () => {
    setupChains(
      { account_id: 'acc-1' },
      makeConfig({ evolution_instance_name: null }),
    )
    const res = await POST()
    expect(res.status).toBe(409)
  })

  it('returns 409 when evolution_webhook_url_secret is missing', async () => {
    setupChains(
      { account_id: 'acc-1' },
      makeConfig({ evolution_webhook_url_secret: null }),
    )
    const res = await POST()
    expect(res.status).toBe(409)
  })
})

describe('POST /api/whatsapp/evolution/instance/webhook — env guards', () => {
  it('returns 422 when NEXT_PUBLIC_APP_URL is unset', async () => {
    setupChains({ account_id: 'acc-1' }, makeConfig())
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    const res = await POST()
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toMatch(/NEXT_PUBLIC_APP_URL/)
    expect(registerWebhookMock).not.toHaveBeenCalled()
  })

  it('returns 503 when EVOLUTION_GLOBAL_APIKEY is unset', async () => {
    setupChains({ account_id: 'acc-1' }, makeConfig())
    vi.stubEnv('EVOLUTION_GLOBAL_APIKEY', '')
    const res = await POST()
    expect(res.status).toBe(503)
    expect(registerWebhookMock).not.toHaveBeenCalled()
  })

  it('strips a trailing slash from NEXT_PUBLIC_APP_URL when building the URL', async () => {
    setupChains({ account_id: 'acc-1' }, makeConfig())
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com/')
    const res = await POST()
    expect(res.status).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = (registerWebhookMock.mock.calls[0] as any[])[0].url
    expect(url).toBe(
      'https://crm.example.com/api/whatsapp/evolution/webhook?secret=decrypted%3Aenc-secret',
    )
  })
})

describe('POST /api/whatsapp/evolution/instance/webhook — decrypt', () => {
  it('returns 500 with a clear message when decrypt throws', async () => {
    setupChains({ account_id: 'acc-1' }, makeConfig())
    decryptMock.mockImplementationOnce(() => {
      throw new Error('bad ciphertext')
    })
    const res = await POST()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/ENCRYPTION_KEY/)
    expect(registerWebhookMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/whatsapp/evolution/instance/webhook — success path', () => {
  it('calls registerWebhook with the reconstructed URL + decrypted secret', async () => {
    setupChains({ account_id: 'acc-1' }, makeConfig())
    const res = await POST()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      webhookRegistered: true,
      url: 'https://crm.example.com/api/whatsapp/evolution/webhook?secret=decrypted%3Aenc-secret',
    })
    expect(registerWebhookMock).toHaveBeenCalledTimes(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = (registerWebhookMock.mock.calls[0] as any[])[0]
    expect(args.instanceName).toBe('wacrm-test-1234')
    expect(args.url).toBe(
      'https://crm.example.com/api/whatsapp/evolution/webhook?secret=decrypted%3Aenc-secret',
    )
    expect(args.secret).toBe('decrypted:enc-secret')
  })

  it('passes the global apikey to EvolutionLifecycleClient', async () => {
    setupChains({ account_id: 'acc-1' }, makeConfig())
    vi.stubEnv('EVOLUTION_GLOBAL_APIKEY', 'specific-key')
    await POST()
    expect(lastClientConfig.value).toEqual({
      baseUrl: 'https://evo.example.com',
      globalApiKey: 'specific-key',
    })
  })
})

describe('POST /api/whatsapp/evolution/instance/webhook — Evolution errors', () => {
  it('returns 502 when registerWebhook throws an EvolutionLifecycleError', async () => {
    setupChains({ account_id: 'acc-1' }, makeConfig())
    registerWebhookMock.mockRejectedValueOnce(
      new Error('Evolution rejected: invalid instance'),
    )
    const res = await POST()
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/Evolution rejected the webhook registration/)
    expect(body.error).toMatch(/invalid instance/)
  })

  it('returns 502 with a fallback message when the error is not an Error instance', async () => {
    setupChains({ account_id: 'acc-1' }, makeConfig())
    // Throw a string (not an Error). The route's catch should
    // still classify it as an Evolution-side failure and return
    // 502 with the "webhook registration failed" fallback.
    registerWebhookMock.mockRejectedValueOnce('not an error object')
    const res = await POST()
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/Evolution rejected the webhook registration/)
    expect(body.error).toMatch(/webhook registration failed/)
  })
})
