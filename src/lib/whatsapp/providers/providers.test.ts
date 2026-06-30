/**
 * Provider layer tests.
 *
 * Three concerns are exercised here:
 *
 * 1. Meta provider `parseWebhook` — verify the Meta → NormalisedEvent
 *    translation handles each Meta message type + status events.
 *
 * 2. Evolution provider `parseWebhook` — same coverage for Evolution
 *    (Baileys) payloads. The shapes differ wildly from Meta; the
 *    point of the contract test (4) is that downstream code can't
 *    tell.
 *
 * 3. Normalised-event contract — given the same logical event
 *    (an inbound text message from a customer), both providers
 *    emit a NormalisedEvent with the same shape. The shared
 *    processor depends on this.
 *
 * 4. Factory — `getProvider` returns the right class for each
 *    `provider` discriminator, defaults to Meta for `undefined`
 *    (defensive default for old fixtures), and throws on a
 *    misconfigured row (missing required fields).
 *
 * What's NOT here: the shared processor is a thin DB layer and
 * the existing send/webhook tests already cover the
 * end-to-end Meta path. We add one focused assertion that
 * the processor receives the same event shape from both
 * providers — see the contract test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MetaProvider } from './meta'
import { EvolutionProvider } from './evolution'
import { getProvider } from './index'
import type { NormalisedEvent } from './types'

// ============================================================
// Helpers
// ============================================================

/**
 * Mock fetch and return the captured call. Restores fetch on
 * cleanup so test ordering is irrelevant.
 */
function mockFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mock = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    return responder(url, (init ?? {}) as RequestInit)
  })
  globalThis.fetch = mock as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

const META_PHONE = '15555550100'

// ============================================================
// Meta provider — parseWebhook
// ============================================================

describe('MetaProvider.parseWebhook', () => {
  it('translates an inbound text message into a NormalisedEvent', async () => {
    const p = new MetaProvider({
      phoneNumberId: '123',
      accessToken: 'tok',
    })
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123' },
                contacts: [{ profile: { name: 'Alice' }, wa_id: META_PHONE }],
                messages: [
                  {
                    id: 'wamid-1',
                    from: META_PHONE,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'hello' },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    })

    const events = await p.parseWebhook(body)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.kind).toBe('message')
    if (ev.kind !== 'message') throw new Error('narrow')
    expect(ev.message.type).toBe('text')
    expect(ev.message.text?.body).toBe('hello')
    expect(ev.message.from).toBe(META_PHONE)
    expect(ev.contact.phone).toBe(META_PHONE)
    expect(ev.contact.name).toBe('Alice')
  })

  it('translates a status update into a status event', async () => {
    const p = new MetaProvider({
      phoneNumberId: '123',
      accessToken: 'tok',
    })
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123' },
                statuses: [
                  {
                    id: 'wamid-2',
                    status: 'delivered',
                    timestamp: '1700000001',
                    recipient_id: META_PHONE,
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    })

    const events = await p.parseWebhook(body)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.kind).toBe('status')
    if (ev.kind !== 'status') throw new Error('narrow')
    expect(ev.status.id).toBe('wamid-2')
    expect(ev.status.status).toBe('delivered')
  })

  it('returns an empty array for malformed JSON', async () => {
    const p = new MetaProvider({ phoneNumberId: '123', accessToken: 'tok' })
    expect(await p.parseWebhook('not json')).toEqual([])
  })

  it('routes a template_lifecycle event into template_change', async () => {
    const p = new MetaProvider({ phoneNumberId: '123', accessToken: 'tok' })
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: 'message_template_status_update',
              value: {
                message_template_id: '987',
                event: 'APPROVED',
                // The `messaging_product` is absent on template
                // events, so the parser routes to template_change
                // even when field is present.
              },
            },
          ],
        },
      ],
    })

    const events = await p.parseWebhook(body)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.kind).toBe('template_change')
    if (ev.kind !== 'template_change') throw new Error('narrow')
    expect(ev.field).toBe('message_template_status_update')
  })
})

// ============================================================
// Evolution provider — parseWebhook
// ============================================================

describe('EvolutionProvider.parseWebhook', () => {
  it('translates a MESSAGES_UPSERT text into a NormalisedEvent', async () => {
    const p = new EvolutionProvider({
      baseUrl: 'https://evo.example.com',
      instanceName: 'wacrm-prod',
      apiKey: 'apikey-1',
    })
    const body = JSON.stringify({
      event: 'MESSAGES_UPSERT',
      instance: 'wacrm-prod',
      data: {
        key: {
          remoteJid: `${META_PHONE}@s.whatsapp.net`,
          fromMe: false,
          id: 'evo-1',
        },
        pushName: 'Bob',
        messageTimestamp: 1700000000,
        message: { conversation: 'hi from evolution' },
      },
    })

    const events = await p.parseWebhook(body)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.kind).toBe('message')
    if (ev.kind !== 'message') throw new Error('narrow')
    expect(ev.message.type).toBe('text')
    expect(ev.message.text?.body).toBe('hi from evolution')
    expect(ev.message.from).toBe(META_PHONE)
    expect(ev.contact.name).toBe('Bob')
  })

  it('ignores MESSAGES_UPSERT for fromMe=true (our own sends)', async () => {
    const p = new EvolutionProvider({
      baseUrl: 'https://evo.example.com',
      instanceName: 'i',
      apiKey: 'k',
    })
    const body = JSON.stringify({
      event: 'MESSAGES_UPSERT',
      instance: 'i',
      data: {
        key: { remoteJid: 'x@s.whatsapp.net', fromMe: true, id: '1' },
        message: { conversation: 'echo' },
      },
    })
    const events = await p.parseWebhook(body)
    expect(events).toEqual([])
  })

  it('maps MESSAGES_UPDATE numeric status to the internal ladder', async () => {
    const p = new EvolutionProvider({
      baseUrl: 'https://evo.example.com',
      instanceName: 'i',
      apiKey: 'k',
    })
    const body = JSON.stringify({
      event: 'MESSAGES_UPDATE',
      instance: 'i',
      data: [
        {
          key: { id: 'evo-msg-1', remoteJid: `${META_PHONE}@s.whatsapp.net` },
          update: { status: 3, timestamp: 1700000000 },
        },
      ],
    })
    const events = await p.parseWebhook(body)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.kind).toBe('status')
    if (ev.kind !== 'status') throw new Error('narrow')
    expect(ev.status.status).toBe('delivered')
  })

  it('emits a connection_update from CONNECTION_UPDATE', async () => {
    const p = new EvolutionProvider({
      baseUrl: 'https://evo.example.com',
      instanceName: 'i',
      apiKey: 'k',
    })
    const body = JSON.stringify({
      event: 'CONNECTION_UPDATE',
      instance: 'i',
      data: { state: 'open' },
    })
    const events = await p.parseWebhook(body)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.kind).toBe('connection_update')
    if (ev.kind !== 'connection_update') throw new Error('narrow')
    expect(ev.state).toBe('connected')
  })
})

// ============================================================
// Provider contract
// ============================================================
//
// The shared processor's whole reason for existing is that both
// providers emit the same NormalisedEvent shape. These two tests
// assert that — same logical event, two providers, same shape.

describe('Provider contract — both providers emit the same shape', () => {
  it('emits a {kind:"message"} event with .text.body for a text message', async () => {
    const meta = new MetaProvider({ phoneNumberId: '1', accessToken: 't' })
    const evolution = new EvolutionProvider({
      baseUrl: 'https://e.example.com',
      instanceName: 'i',
      apiKey: 'k',
    })

    const metaBody = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '1' },
                contacts: [{ profile: { name: 'X' }, wa_id: META_PHONE }],
                messages: [
                  {
                    id: 'a',
                    from: META_PHONE,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'hi' },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    })
    const evoBody = JSON.stringify({
      event: 'MESSAGES_UPSERT',
      instance: 'i',
      data: {
        key: { remoteJid: `${META_PHONE}@s.whatsapp.net`, fromMe: false, id: 'b' },
        pushName: 'X',
        messageTimestamp: 1700000000,
        message: { conversation: 'hi' },
      },
    })

    const metaEvents = await meta.parseWebhook(metaBody)
    const evoEvents = await evolution.parseWebhook(evoBody)

    expect(metaEvents).toHaveLength(1)
    expect(evoEvents).toHaveLength(1)
    const m = metaEvents[0] as Extract<NormalisedEvent, { kind: 'message' }>
    const e = evoEvents[0] as Extract<NormalisedEvent, { kind: 'message' }>

    // Both must produce a text message carrying the same body
    // text. From here, the shared processor doesn't care which
    // provider produced it.
    expect(m.message.type).toBe('text')
    expect(e.message.type).toBe('text')
    expect(m.message.text?.body).toBe('hi')
    expect(e.message.text?.body).toBe('hi')
    // Sender phone in E.164-ish form (no @s.whatsapp.net suffix).
    expect(m.message.from).toBe(META_PHONE)
    expect(e.message.from).toBe(META_PHONE)
  })
})

// ============================================================
// Factory
// ============================================================

describe('getProvider', () => {
  it('returns a MetaProvider when provider is "meta"', () => {
    const p = getProvider(
      {
        provider: 'meta',
        accountId: 'a',
        userId: 'u',
        phoneNumberId: '123',
        accessToken: 'tok',
        wabaId: null,
        evolutionBaseUrl: null,
        evolutionInstanceName: null,
        evolutionApiKey: null,
      },
      { metaAppSecret: null },
    )
    expect(p).toBeInstanceOf(MetaProvider)
  })

  it('returns an EvolutionProvider when provider is "evolution"', () => {
    const p = getProvider(
      {
        provider: 'evolution',
        accountId: 'a',
        userId: 'u',
        phoneNumberId: null,
        accessToken: null,
        wabaId: null,
        evolutionBaseUrl: 'https://evo.example.com',
        evolutionInstanceName: 'prod',
        evolutionApiKey: 'apikey',
      },
      { metaAppSecret: null },
    )
    expect(p).toBeInstanceOf(EvolutionProvider)
  })

  it('defaults to Meta when provider is undefined (defensive — old fixtures)', () => {
    const p = getProvider(
      {
        // provider: undefined
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

  it('throws when a Meta row is missing phone_number_id', () => {
    expect(() =>
      getProvider(
        {
          provider: 'meta',
          accountId: 'a',
          userId: 'u',
          phoneNumberId: null,
          accessToken: 'tok',
          wabaId: null,
          evolutionBaseUrl: null,
          evolutionInstanceName: null,
          evolutionApiKey: null,
        },
        { metaAppSecret: null },
      ),
    ).toThrow(/phone_number_id is null/)
  })

  it('throws when an Evolution row is missing the base URL', () => {
    expect(() =>
      getProvider(
        {
          provider: 'evolution',
          accountId: 'a',
          userId: 'u',
          phoneNumberId: null,
          accessToken: null,
          wabaId: null,
          evolutionBaseUrl: null,
          evolutionInstanceName: 'i',
          evolutionApiKey: 'k',
        },
        { metaAppSecret: null },
      ),
    ).toThrow(/evolution_base_url is null/)
  })
})

// ============================================================
// Evolution provider — sending (HTTP mocked)
// ============================================================

describe('EvolutionProvider.sendText', () => {
  let restore: () => void
  afterEach(() => restore?.())

  it('POSTs to /message/sendText/{instance} with the apikey header', async () => {
    let captured!: { url: string; init: RequestInit }
    restore = mockFetch((url, init) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({ key: { id: 'evo-sent-1' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })

    const p = new EvolutionProvider({
      baseUrl: 'https://evo.example.com',
      instanceName: 'prod',
      apiKey: 'secret-key',
    })
    const r = await p.sendText({ to: '+1 555 0100', text: 'hello' })

    expect(r.messageId).toBe('evo-sent-1')
    expect(captured?.url).toBe('https://evo.example.com/message/sendText/prod')
    expect(captured?.init.method).toBe('POST')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['apikey']).toBe('secret-key')
    const body = JSON.parse(captured!.init.body as string)
    expect(body.number).toBe('15550100') // digits-only
    expect(body.text).toBe('hello')
  })

  it('strips a trailing slash from the base URL', async () => {
    let captured!: { url: string; init: RequestInit }
    restore = mockFetch((url, init) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({ key: { id: 'x' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })

    const p = new EvolutionProvider({
      baseUrl: 'https://evo.example.com/', // trailing slash
      instanceName: 'prod',
      apiKey: 'k',
    })
    await p.sendText({ to: '1', text: 'x' })
    expect(captured?.url).toBe('https://evo.example.com/message/sendText/prod')
  })
})

// ============================================================
// Signature verification
// ============================================================

describe('Provider webhook signature verification', () => {
  const realSecret = process.env.META_APP_SECRET

  beforeEach(() => {
    // Make sure the test environment has no META_APP_SECRET set
    // (so verifyMetaWebhookSignature fails closed) or restore it
    // after. Vitest doesn't isolate process.env between tests by
    // default.
    delete process.env.META_APP_SECRET
  })
  afterEach(() => {
    if (realSecret === undefined) delete process.env.META_APP_SECRET
    else process.env.META_APP_SECRET = realSecret
  })

  it('Meta provider rejects when META_APP_SECRET is missing (fail closed)', () => {
    const p = new MetaProvider({ phoneNumberId: '1', accessToken: 't' })
    expect(p.verifyWebhookSignature('{}', 'sha256=00')).toBe(false)
  })

  it('Evolution provider returns true (no signature scheme; URL secret enforced by route)', () => {
    const p = new EvolutionProvider({
      baseUrl: 'https://e.example.com',
      instanceName: 'i',
      apiKey: 'k',
    })
    expect(p.verifyWebhookSignature('{}', null)).toBe(true)
  })
})
