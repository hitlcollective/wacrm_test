/**
 * Tests for the Evolution lifecycle client.
 *
 * Mocked fetch (no real network). Each test sets up a specific
 * response and asserts the client shapes the request + parses
 * the response correctly. We use both v1-shape (flat) and
 * v2-shape (nested under `instance`) responses to verify the
 * normaliser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EvolutionLifecycleClient,
  EvolutionLifecycleError,
} from './instance-client'

// ============================================================
// Helpers
// ============================================================

function mockResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let realFetch: typeof fetch
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  realFetch = globalThis.fetch
  fetchMock = vi.fn()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = fetchMock as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.clearAllMocks()
})

function makeClient() {
  return new EvolutionLifecycleClient({
    baseUrl: 'https://evo.example.com',
    globalApiKey: 'global-key',
  })
}

// ============================================================
// createInstance
// ============================================================

describe('EvolutionLifecycleClient.createInstance', () => {
  it('POSTs to /instance/create with the right headers and an auto-generated instance name', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(201, {
        instance: { instanceName: 'wacrm-abc-12' },
        hash: { apikey: 'instance-apikey-1', hash: 'h' },
      }),
    )
    const client = makeClient()
    const r = await client.createInstance()
    expect(r.instanceName).toMatch(/^wacrm-[0-9a-f]+-[0-9a-f]+$/)
    expect(r.apikey).toBe('instance-apikey-1')
    expect(r.hash).toBe('h')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const init = (fetchMock.mock.calls[0] as any)[1]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = (fetchMock.mock.calls[0] as any)[0] as string
    expect(url).toBe('https://evo.example.com/instance/create')
    expect(init.method).toBe('POST')
    expect(init.headers.apikey).toBe('global-key')
    expect(init.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body)
    expect(body.integration).toBe('WHATSAPP-BAILEYS')
    expect(body.qrcode).toBe(true)
    expect(body.instanceName).toBe(r.instanceName)
  })

  it('uses a provided instance name when given', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, { hash: { apikey: 'k' } }),
    )
    const client = makeClient()
    const r = await client.createInstance({ instanceName: 'my-named-instance' })
    expect(r.instanceName).toBe('my-named-instance')
  })

  it('falls back to the top-level apikey when the response uses v1 shape (no nested hash)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, { apikey: 'top-level-key', hash: 'top-level-hash' }),
    )
    const client = makeClient()
    const r = await client.createInstance({ instanceName: 'x' })
    expect(r.apikey).toBe('top-level-key')
    expect(r.hash).toBe('top-level-hash')
  })

  it('passes the number through to Evolution when provided', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { hash: { apikey: 'k' } }))
    const client = makeClient()
    await client.createInstance({ instanceName: 'x', number: '15555550100' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const init = (fetchMock.mock.calls[0] as any)[1]
    const body = JSON.parse(init.body)
    expect(body.number).toBe('15555550100')
  })

  it('throws EvolutionLifecycleError with the parsed message when Evolution returns 4xx', async () => {
    fetchMock.mockResolvedValue(
      mockResponse(403, { response: { message: ['Instance already exists'] } }),
    )
    const client = makeClient()
    let caught: unknown
    try {
      await client.createInstance({ instanceName: 'x' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EvolutionLifecycleError)
    expect((caught as EvolutionLifecycleError).status).toBe(403)
    expect((caught as EvolutionLifecycleError).message).toBe(
      'Instance already exists',
    )
  })

  it('falls back to a generic message when the body has no message field', async () => {
    fetchMock.mockResolvedValue(mockResponse(500, { oops: true }))
    const client = makeClient()
    await expect(client.createInstance({ instanceName: 'x' })).rejects.toThrow(
      /Evolution POST \/instance\/create failed: 500/,
    )
  })
})

// ============================================================
// getQr
// ============================================================

describe('EvolutionLifecycleClient.getQr', () => {
  it('GETs the right URL and returns the QR fields', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, {
        pairingCode: 'base64-png-data',
        base64: 'plain-code-form',
        count: 3,
      }),
    )
    const client = makeClient()
    const r = await client.getQr('my-instance')
    expect(r).toEqual({
      pairingCode: 'base64-png-data',
      base64: 'plain-code-form',
      count: 3,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((fetchMock.mock.calls[0] as any)[0]).toBe(
      'https://evo.example.com/instance/connect/my-instance',
    )
  })

  it('omits fields that Evolution does not return', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { pairingCode: 'png-only' }))
    const client = makeClient()
    const r = await client.getQr('i')
    expect(r.pairingCode).toBe('png-only')
    expect(r.base64).toBeUndefined()
    expect(r.count).toBeUndefined()
  })

  it('handles 404 with a clear error', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(404, { response: { message: ['Instance not found'] } }),
    )
    const client = makeClient()
    let caught: unknown
    try {
      await client.getQr('missing')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EvolutionLifecycleError)
    expect((caught as EvolutionLifecycleError).status).toBe(404)
  })
})

// ============================================================
// getStatus
// ============================================================

describe('EvolutionLifecycleClient.getStatus', () => {
  it('reads v2 nested state (instance.state)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, {
        instance: { state: 'open', ownerJid: '5511@s.whatsapp.net' },
      }),
    )
    const client = makeClient()
    const r = await client.getStatus('i')
    expect(r.state).toBe('open')
    expect(r.ownerJid).toBe('5511@s.whatsapp.net')
  })

  it('falls back to flat v1 shape (state at top level)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, { state: 'close', jid: '5511@s.whatsapp.net' }),
    )
    const client = makeClient()
    const r = await client.getStatus('i')
    expect(r.state).toBe('close')
    expect(r.ownerJid).toBe('5511@s.whatsapp.net')
  })

  it('returns null state when Evolution returns nothing', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, {}))
    const client = makeClient()
    const r = await client.getStatus('i')
    expect(r.state).toBeNull()
    expect(r.ownerJid).toBeNull()
  })
})

// ============================================================
// deleteInstance
// ============================================================

describe('EvolutionLifecycleClient.deleteInstance', () => {
  it('DELETEs the right URL', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, {}))
    const client = makeClient()
    await client.deleteInstance('to-go')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [url, init] = fetchMock.mock.calls[0] as any
    expect(url).toBe('https://evo.example.com/instance/delete/to-go')
    expect(init.method).toBe('DELETE')
  })

  it('URL-encodes the instance name', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, {}))
    const client = makeClient()
    await client.deleteInstance('name with spaces')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((fetchMock.mock.calls[0] as any)[0]).toBe(
      'https://evo.example.com/instance/delete/name%20with%20spaces',
    )
  })
})

// ============================================================
// registerWebhook
// ============================================================

describe('EvolutionLifecycleClient.registerWebhook', () => {
  it('POSTs the webhook URL with the default event list', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { ok: true }))
    const client = makeClient()
    await client.registerWebhook({
      instanceName: 'i',
      url: 'https://wacrm.example.com/api/whatsapp/evolution/webhook',
      secret: 's3cret',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const init = (fetchMock.mock.calls[0] as any)[1]
    const body = JSON.parse(init.body)
    expect(body.url).toBe('https://wacrm.example.com/api/whatsapp/evolution/webhook')
    expect(body.webhook_by_events).toBe(false)
    expect(body.webhook_base64).toBe(false)
    expect(body.events).toEqual([
      'MESSAGES_UPSERT',
      'MESSAGES_UPDATE',
      'CONNECTION_UPDATE',
    ])
  })

  it('respects a custom event list when provided', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { ok: true }))
    const client = makeClient()
    await client.registerWebhook({
      instanceName: 'i',
      url: 'https://wacrm.example.com/hook',
      secret: 's',
      events: ['MESSAGES_UPSERT'],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const init = (fetchMock.mock.calls[0] as any)[1]
    const body = JSON.parse(init.body)
    expect(body.events).toEqual(['MESSAGES_UPSERT'])
  })
})

// ============================================================
// Trailing-slash + base URL hygiene
// ============================================================

describe('EvolutionLifecycleClient baseUrl handling', () => {
  it('strips a trailing slash from baseUrl', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { state: 'open' }))
    const c = new EvolutionLifecycleClient({
      baseUrl: 'https://evo.example.com/',
      globalApiKey: 'k',
    })
    await c.getStatus('i')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((fetchMock.mock.calls[0] as any)[0]).toBe(
      'https://evo.example.com/instance/connectionState/i',
    )
  })
})
