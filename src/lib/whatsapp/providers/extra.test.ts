/**
 * Additional provider-layer tests.
 *
 * Covers the bits the providers.test.ts file doesn't:
 *   - decryptConfigRow (the factory's row → decrypted view helper)
 *   - Evolution provider's sendMedia / sendReaction / sendInteractive
 *     methods (the existing file only covers sendText)
 *
 * Kept in a separate file so the import surface stays small —
 * the providers test file is already big.
 */

import { describe, it, expect, vi } from 'vitest'
import { EvolutionProvider } from './evolution'
import { decryptConfigRow, getProvider } from './index'
import { MetaProvider } from './meta'

// ============================================================
// decryptConfigRow
// ============================================================

describe('decryptConfigRow', () => {
  it('decrypts the Meta access_token and leaves Evolution columns null', () => {
    const row = {
      id: 'r1',
      account_id: 'a1',
      user_id: 'u1',
      provider: 'meta' as const,
      phone_number_id: '12345',
      waba_id: 'w1',
      access_token: 'cipher-meta',
      verify_token: 'cipher-verify',
      status: 'connected' as const,
      connected_at: null,
      registered_at: null,
      evolution_base_url: null,
      evolution_instance_name: null,
      evolution_apikey: null,
      evolution_webhook_url_secret: null,
      evolution_connection_state: null,
      evolution_connected_jid: null,
      evolution_last_seen_at: null,
      evolution_last_disconnect_reason: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    }
    const out = decryptConfigRow(row, (c) => `plain:${c}`)
    expect(out.accessToken).toBe('plain:cipher-meta')
    expect(out.evolutionApiKey).toBeNull()
    expect(out.evolutionBaseUrl).toBeNull()
    expect(out.evolutionInstanceName).toBeNull()
    expect(out.accountId).toBe('a1')
    expect(out.userId).toBe('u1')
  })

  it('decrypts the Evolution apikey and leaves Meta columns null', () => {
    const row = {
      id: 'r2',
      account_id: 'a2',
      user_id: 'u2',
      provider: 'evolution' as const,
      phone_number_id: null,
      waba_id: null,
      access_token: null,
      verify_token: null,
      status: null,
      connected_at: null,
      registered_at: null,
      evolution_base_url: 'https://evo.example.com',
      evolution_instance_name: 'prod',
      evolution_apikey: 'cipher-evo',
      evolution_webhook_url_secret: 'secret',
      evolution_connection_state: 'connected' as const,
      evolution_connected_jid: 'jid',
      evolution_last_seen_at: null,
      evolution_last_disconnect_reason: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    }
    const out = decryptConfigRow(row, (c) => `plain:${c}`)
    expect(out.evolutionApiKey).toBe('plain:cipher-evo')
    expect(out.accessToken).toBeNull()
    expect(out.phoneNumberId).toBeNull()
    expect(out.evolutionBaseUrl).toBe('https://evo.example.com')
    expect(out.evolutionInstanceName).toBe('prod')
  })

  it('returns nulls when the ciphertext is null (defensive)', () => {
    const row = {
      id: 'r3',
      account_id: 'a3',
      user_id: 'u3',
      provider: 'meta' as const,
      phone_number_id: '123',
      waba_id: null,
      access_token: null, // edge case
      verify_token: null,
      status: null,
      connected_at: null,
      registered_at: null,
      evolution_base_url: null,
      evolution_instance_name: null,
      evolution_apikey: null,
      evolution_webhook_url_secret: null,
      evolution_connection_state: null,
      evolution_connected_jid: null,
      evolution_last_seen_at: null,
      evolution_last_disconnect_reason: null,
      created_at: '',
      updated_at: '',
    }
    const out = decryptConfigRow(row, () => {
      throw new Error('decryptor should not be called for null ciphertext')
    })
    expect(out.accessToken).toBeNull()
  })
})

// ============================================================
// getProvider with a partially-misconfigured Evolution row
// ============================================================

describe('getProvider — defensive defaults', () => {
  it('returns Meta when provider is missing and Meta fields are set', () => {
    const p = getProvider(
      {
        // provider intentionally omitted (defensive default)
        accountId: 'a',
        userId: 'u',
        phoneNumberId: '123',
        accessToken: 'tok',
        wabaId: null,
        evolutionBaseUrl: null,
        evolutionInstanceName: null,
        evolutionApiKey: null,
      } as any,
      { metaAppSecret: null },
    )
    expect(p).toBeInstanceOf(MetaProvider)
  })
})

// ============================================================
// Evolution provider — sendMedia
// ============================================================

describe('EvolutionProvider.sendMedia', () => {
  function mockJsonResponse(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('POSTs to /message/sendMedia/{instance} with mediatype and media URL', async () => {
    const realFetch = globalThis.fetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mock = vi.fn(async (_input: any, init?: any) => {
      return mockJsonResponse({ key: { id: 'evo-media-1' } })
    })
    globalThis.fetch = mock as typeof fetch

    try {
      const p = new EvolutionProvider({
        baseUrl: 'https://evo.example.com',
        instanceName: 'prod',
        apiKey: 'k',
      })
      const r = await p.sendMedia({
        to: '15555550100',
        kind: 'image',
        link: 'https://example.com/img.png',
        caption: 'look at this',
        contextMessageId: 'wamid-prev',
      })
      expect(r.messageId).toBe('evo-media-1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const init = (mock.mock.calls[0] as any)[1]
      const body = JSON.parse(init.body)
      expect(body.mediatype).toBe('image')
      expect(body.media).toBe('https://example.com/img.png')
      expect(body.caption).toBe('look at this')
      // contextMessageId is included as `quoted: { key: { id: ... } }`
      expect(body.quoted).toEqual({ key: { id: 'wamid-prev' } })
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('omits caption for audio (Meta-equivalent rule, carried over)', async () => {
    const realFetch = globalThis.fetch
    const mock = vi.fn(async () => mockJsonResponse({ key: { id: 'a' } }))
    globalThis.fetch = mock as typeof fetch

    try {
      const p = new EvolutionProvider({
        baseUrl: 'https://e.example.com',
        instanceName: 'i',
        apiKey: 'k',
      })
      await p.sendMedia({
        to: '1',
        kind: 'audio',
        link: 'https://example.com/voice.ogg',
        caption: 'should be dropped',
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const init = (mock.mock.calls[0] as any)[1]
      const body = JSON.parse(init.body)
      expect(body.caption).toBeUndefined()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

// ============================================================
// Evolution provider — sendReaction
// ============================================================

describe('EvolutionProvider.sendReaction', () => {
  it('POSTs to /message/sendReaction/{instance} with key + reaction', async () => {
    const realFetch = globalThis.fetch
    const mock = vi.fn(async () =>
      new Response(JSON.stringify({ key: { id: 'r1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    globalThis.fetch = mock as typeof fetch

    try {
      const p = new EvolutionProvider({
        baseUrl: 'https://e.example.com',
        instanceName: 'prod',
        apiKey: 'k',
      })
      const r = await p.sendReaction({
        to: '15555550100',
        targetMessageId: 'wamid-target',
        emoji: '❤️',
      })
      expect(r.messageId).toBe('r1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const init = (mock.mock.calls[0] as any)[1]
      const body = JSON.parse(init.body)
      expect(body.key).toEqual({ id: 'wamid-target' })
      expect(body.reaction).toBe('❤️')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

// ============================================================
// Evolution provider — sendInteractiveButtons
// ============================================================

describe('EvolutionProvider.sendInteractiveButtons', () => {
  it('POSTs to /message/sendButtons/{instance} with mapped button shape', async () => {
    const realFetch = globalThis.fetch
    const mock = vi.fn(async () =>
      new Response(JSON.stringify({ key: { id: 'b1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    globalThis.fetch = mock as typeof fetch

    try {
      const p = new EvolutionProvider({
        baseUrl: 'https://e.example.com',
        instanceName: 'prod',
        apiKey: 'k',
      })
      const r = await p.sendInteractiveButtons({
        to: '15555550100',
        bodyText: 'Choose one',
        headerText: 'Header',
        footerText: 'Footer',
        buttons: [
          { id: 'a', title: 'Apple' },
          { id: 'b', title: 'Banana' },
        ],
      })
      expect(r.messageId).toBe('b1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const init = (mock.mock.calls[0] as any)[1]
      const body = JSON.parse(init.body)
      expect(body.buttons).toEqual([
        { type: 'reply', displayText: 'Apple', id: 'a' },
        { type: 'reply', displayText: 'Banana', id: 'b' },
      ])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
