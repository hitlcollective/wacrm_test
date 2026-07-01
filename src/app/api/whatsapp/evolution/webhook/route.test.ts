/**
 * Tests for the Evolution inbound webhook route.
 *
 * This route is security-critical: it accepts unauthenticated
 * POSTs from Evolution, compares the ?secret=… parameter with
 * the encrypted secret on a matching row, and dispatches the
 * payload to processInboundEvents. Tests cover the secret
 * check, the row-scan, the parse, the dispatch, and the
 * always-200 contract (so Evolution doesn't retry malformed
 * payloads forever).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Module mocks
// ============================================================

// Supabase service-role client — used for the row scan.
const fromMock = vi.fn()
const adminCreateClient = vi.fn(() => ({ from: fromMock }))

vi.mock('@supabase/supabase-js', () => ({
  createClient: (..._args: unknown[]) => adminCreateClient(),
}))

// The provider factory — returns a fake provider whose parseWebhook
// returns a hand-crafted event when called.
const parseWebhookMock = vi.fn()
const providerInstance = { parseWebhook: parseWebhookMock }
const getProviderMock = vi.fn(() => providerInstance)

vi.mock('@/lib/whatsapp/providers', () => ({
  getProvider: (..._args: unknown[]) => getProviderMock(),
  decryptConfigRow: (row: any, decrypt: (s: string) => string) => {
    let apiKey: string | null = null
    try {
      apiKey = row.evolution_apikey ? decrypt(row.evolution_apikey) : null
    } catch {
      apiKey = null
    }
    return {
      accountId: row.account_id,
      userId: row.user_id,
      provider: 'evolution',
      evolutionApiKey: apiKey,
      evolutionBaseUrl: row.evolution_base_url,
      evolutionInstanceName: row.evolution_instance_name,
      accessToken: null,
      phoneNumberId: null,
      wabaId: null,
    }
  },
}))

vi.mock('@/lib/whatsapp/inbound-processor', () => ({
  processInboundEvents: vi.fn(async () => undefined),
}))

// ============================================================
// Imports (after mocks)
// ============================================================

const { POST } = await import('./route')
const { processInboundEvents } = await import('@/lib/whatsapp/inbound-processor')

// ============================================================
// Helpers
// ============================================================

// We use a real ENCRYPTION_KEY so the decrypt() in the route
// matches what encrypt() produces. The default key in the
// encryption module is 64-char hex from process.env; we set
// it once at module load. The exact bytes don't matter — we
// only need round-trip stability.
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

const { encrypt } = await import('@/lib/whatsapp/encryption')

interface MockRow {
  id: string
  account_id: string
  user_id: string
  provider: 'evolution'
  evolution_base_url: string
  evolution_instance_name: string
  evolution_apikey: string
  evolution_webhook_url_secret: string | null
}

function makeRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: 'row-1',
    account_id: 'acc-1',
    user_id: 'user-1',
    provider: 'evolution',
    evolution_base_url: 'https://evo.example.com',
    evolution_instance_name: 'inst-1',
    evolution_apikey: encrypt('instance-key'),
    evolution_webhook_url_secret: encrypt('correct-secret'),
    ...overrides,
  }
}

/**
 * Set up the admin client to return `rows` for the scan query.
 * The route does `.from('whatsapp_config').select(...).eq(...).not(...)`
 * — we model the chain so that final `.not()` is what returns
 * the rows.
 */
function mockRows(rows: MockRow[]) {
  const notChain = {
    not: vi.fn(async () => ({ data: rows, error: null })),
  }
  const eqChain = {
    eq: vi.fn(() => notChain),
    not: vi.fn(async () => ({ data: rows, error: null })),
  }
  const selectChain = {
    select: vi.fn(() => eqChain),
    eq: vi.fn(() => eqChain),
  }
  fromMock.mockReturnValue(selectChain)
}

function postRequest(secret: string | null, body = '{"event":"MESSAGES_UPSERT"}'): Request {
  const url = secret
    ? `https://test.local/api/whatsapp/evolution/webhook?secret=${secret}`
    : 'https://test.local/api/whatsapp/evolution/webhook'
  return new Request(url, { method: 'POST', body })
}

// ============================================================
// Tests
// ============================================================

beforeEach(() => {
  fromMock.mockReset()
  parseWebhookMock.mockReset()
  getProviderMock.mockClear()
  vi.mocked(processInboundEvents).mockReset()
  // Reset provider mock default — each test sets its own return.
  parseWebhookMock.mockResolvedValue([])
  vi.mocked(processInboundEvents).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/whatsapp/evolution/webhook — secret check', () => {
  it('returns 401 when the ?secret=… parameter is missing', async () => {
    const res = await POST(postRequest(null))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'Missing secret' })
  })

  it('returns 401 when the secret does not match any row', async () => {
    mockRows([makeRow()])
    const res = await POST(postRequest('wrong-secret'))
    expect(res.status).toBe(401)
  })

  it('returns 200 (and processes) when the secret matches a row', async () => {
    const row = makeRow()
    mockRows([row])
    parseWebhookMock.mockResolvedValueOnce([
      {
        kind: 'message',
        message: {
          id: 'wamid-1',
          from: '15555550100',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'hi' },
        },
        contact: { phone: '15555550100', name: 'Alice' },
      },
    ] as any)

    const res = await POST(postRequest('correct-secret'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, processed: 1 })
  })
})

describe('POST /api/whatsapp/evolution/webhook — empty / malformed payload', () => {
  it('returns 200 with processed=0 when parseWebhook returns no events', async () => {
    mockRows([makeRow()])
    parseWebhookMock.mockResolvedValueOnce([])

    const res = await POST(postRequest('correct-secret'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, processed: 0 })
    expect(processInboundEvents).not.toHaveBeenCalled()
  })

  it('returns 200 with parseError when the parser throws', async () => {
    mockRows([makeRow()])
    parseWebhookMock.mockRejectedValueOnce(new Error('JSON parse failed'))

    const res = await POST(postRequest('correct-secret', 'not-json'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, parseError: true })
  })
})

describe('POST /api/whatsapp/evolution/webhook — dispatch', () => {
  it('forwards parsed events to processInboundEvents with the right account context', async () => {
    const row = makeRow({ account_id: 'acc-99', user_id: 'user-99' })
    mockRows([row])
    const events = [
      { kind: 'message', message: { id: 'a' }, contact: { phone: '1', name: 'A' } },
      { kind: 'status', status: { id: 'b', status: 'delivered', timestamp: 1, recipient_id: '1' } },
    ] as any
    parseWebhookMock.mockResolvedValueOnce(events)

    const res = await POST(postRequest('correct-secret'))
    expect(res.status).toBe(200)
    expect(processInboundEvents).toHaveBeenCalledTimes(1)
    expect(processInboundEvents).toHaveBeenCalledWith(events, {
      accountId: 'acc-99',
      configOwnerUserId: 'user-99',
    })
  })

  it('returns 200 even when processInboundEvents throws (per-event isolation is upstream)', async () => {
    mockRows([makeRow()])
    parseWebhookMock.mockResolvedValueOnce([
      { kind: 'message', message: { id: 'a' }, contact: { phone: '1', name: 'A' } },
    ] as any)
    vi.mocked(processInboundEvents).mockRejectedValueOnce(new Error('db down'))

    const res = await POST(postRequest('correct-secret'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, processed: 'partial' })
  })
})

describe('POST /api/whatsapp/evolution/webhook — defensive', () => {
  it('returns 200 when a row has an undecryptable secret (skip + continue)', async () => {
    // r1 has a garbage secret (decrypt throws in the route's
    // own loop); r2 has the good secret. The route should
    // skip r1 and match r2.
    const r1 = makeRow({
      evolution_webhook_url_secret: 'not-a-valid-ciphertext-format',
    })
    const r2 = makeRow()
    mockRows([r1, r2])
    parseWebhookMock.mockResolvedValueOnce([])

    const res = await POST(postRequest('correct-secret'))
    expect(res.status).toBe(200)
  })

  it('returns 200 (no dispatch) when the matched row has no apikey', async () => {
    // Half-populated row: secret matches, but evolution_apikey
    // is null. The route bails with 200 rather than dispatching
    // to a half-configured provider.
    const r = makeRow({ evolution_apikey: '' as any })
    mockRows([r])
    const res = await POST(postRequest('correct-secret'))
    expect(res.status).toBe(200)
    expect(getProviderMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/whatsapp/evolution/webhook — multi-row scan', () => {
  it('handles three rows with the match being the second one (no early break)', async () => {
    // The route must walk the full list of rows to find the
    // match — returning on the first non-match would leak
    // the position via response-time differences. We can't
    // assert on timing directly, but we can assert the match
    // works when the correct row is not first.
    const r1 = makeRow({ evolution_webhook_url_secret: encrypt('a') })
    const r2 = makeRow({ evolution_webhook_url_secret: encrypt('b') })
    const r3 = makeRow({ evolution_webhook_url_secret: encrypt('c') })
    mockRows([r1, r2, r3])
    parseWebhookMock.mockResolvedValueOnce([
      { kind: 'message', message: { id: 'a' }, contact: { phone: '1', name: 'A' } },
    ] as any)

    const res = await POST(postRequest('b'))
    expect(res.status).toBe(200)
    expect(getProviderMock).toHaveBeenCalledTimes(1)
  })
})
