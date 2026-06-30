/**
 * Shared inbound-processor tests.
 *
 * The processor is the heart of the provider abstraction: it
 * takes NormalisedEvents from any provider and persists them
 * to the database. These tests cover each of the four
 * NormalisedEvent kinds + the key shared logic (status ladder,
 * reaction short-circuit, find-or-create contact).
 *
 * We mock the supabase client and the cross-cutting engines
 * (flows, automations) so the tests stay focused on the
 * processor's own branching. A real-world webhook would
 * produce a mix of these events; here we exercise each branch
 * in isolation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Module mocks — must come before the import under test
// ============================================================

// Mock the supabase client. The processor instantiates ONE
// service-role client via `createClient` and calls from/insert/etc
// on it. We replace `from()` with a chainable mock builder so
// each test can set the exact rows it wants the SELECT to return.
const fromMock = vi.fn()
const createClientMock = vi.fn(() => ({ from: fromMock }))

vi.mock('@supabase/supabase-js', () => ({
  createClient: (..._args: unknown[]) => createClientMock(),
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => null),
  isUniqueViolation: vi.fn(() => false),
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(async () => undefined),
}))

vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}))

vi.mock('@/lib/whatsapp/template-webhook', () => ({
  handleTemplateWebhookChange: vi.fn(async () => undefined),
  isTemplateWebhookField: vi.fn((field: string) =>
    field === 'message_template_status_update' ||
    field === 'message_template_quality_update' ||
    field === 'template_components_update',
  ),
}))

// Import under test AFTER the mocks above. The mocks sit
// at module-load time so the order matters.
const { processInboundEvents } = await import('./inbound-processor')
const { findExistingContact } = await import('@/lib/contacts/dedupe')
const { runAutomationsForTrigger } = await import('@/lib/automations/engine')
const { dispatchInboundToFlows } = await import('@/lib/flows/engine')
const { handleTemplateWebhookChange, isTemplateWebhookField } = await import(
  './template-webhook'
)

// ============================================================
// Chainable Supabase mock helper
// ============================================================

interface QueryResult<T> {
  data: T
  error: { message: string } | null
}

function makeChain(result: Partial<QueryResult<unknown>> = { data: null, error: null }) {
  // The chain is "thenable" so callers can `await` it directly.
  const chain: any = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    upsert: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    not: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => result),
    single: vi.fn(async () => result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  }
  return chain
}

/**
 * Build a chain for a "count exact head" query — used by
 * `processMessage` to ask "how many customer messages does
 * this conversation have already?" Returns { count, error }
 * rather than { data, error }.
 */
function makeCountChain(count: number) {
  return {
    eq: vi.fn(() => ({
      eq: vi.fn(() => Promise.resolve({ count, error: null })),
    })),
  }
}

// ============================================================
// Tests
// ============================================================

const ACCOUNT = 'account-1'
const USER = 'user-1'
const CTX = { accountId: ACCOUNT, configOwnerUserId: USER }

beforeEach(() => {
  fromMock.mockReset()
  vi.mocked(findExistingContact).mockReset()
  vi.mocked(dispatchInboundToFlows).mockReset()
  vi.mocked(runAutomationsForTrigger).mockReset()
  vi.mocked(handleTemplateWebhookChange).mockReset()
  vi.mocked(isTemplateWebhookField).mockClear()
  // Sensible defaults
  vi.mocked(findExistingContact).mockResolvedValue(null)
  vi.mocked(dispatchInboundToFlows).mockResolvedValue({ consumed: false })
  vi.mocked(runAutomationsForTrigger).mockResolvedValue(undefined)
  vi.mocked(handleTemplateWebhookChange).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ============================================================
// message kind
// ============================================================

describe('processInboundEvents — message kind', () => {
  it('creates a contact, conversation, and message for a new inbound text', async () => {
    vi.mocked(findExistingContact).mockResolvedValue(null)

    let contactInsertCalled = false
    let convInsertCalled = false
    let msgInsertCalled = false

    fromMock.mockImplementation((table: string) => {
      if (table === 'contacts') {
        return {
          ...makeChain({ data: { id: 'contact-1' }, error: null }),
          insert: vi.fn(() => {
            contactInsertCalled = true
            return {
              select: () => ({
                single: async () => ({ data: { id: 'contact-1' }, error: null }),
              }),
            }
          }),
        }
      }
      if (table === 'conversations') {
        return {
          ...makeChain({ data: null, error: { message: 'no rows' } }),
          insert: vi.fn(() => {
            convInsertCalled = true
            return {
              select: () => ({
                single: async () => ({ data: { id: 'conv-1', unread_count: 0 }, error: null }),
              }),
            }
          }),
        }
      }
      if (table === 'messages') {
        // The processor makes two queries against messages:
        //   (a) the head-count for first-inbound detection
        //   (b) the actual insert
        return {
          ...makeChain(),
          insert: vi.fn(() => {
            msgInsertCalled = true
            return {
              select: () => ({
                single: async () => ({ data: { id: 'msg-1' }, error: null }),
              }),
            }
          }),
          // (a) the head-count call: select('id', { count, head }) → eq.eq()
          select: vi.fn((_cols: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.head) return makeCountChain(0)
            return makeChain()
          }),
        }
      }
      return makeChain()
    })

    const events = [
      {
        kind: 'message' as const,
        message: {
          id: 'wamid-1',
          from: '15555550100',
          timestamp: '1700000000',
          type: 'text' as const,
          text: { body: 'hello' },
        },
        contact: { phone: '15555550100', name: 'Alice' },
      },
    ]
    await processInboundEvents(events, CTX)
    expect(contactInsertCalled).toBe(true)
    expect(convInsertCalled).toBe(true)
    expect(msgInsertCalled).toBe(true)
  })

  it('reuses an existing contact when one matches by phone', async () => {
    vi.mocked(findExistingContact).mockResolvedValue({
      id: 'contact-existing',
      name: 'Alice',
      phone: '15555550100',
    } as any)

    let contactInsertCalled = false
    fromMock.mockImplementation((table: string) => {
      if (table === 'contacts') {
        return {
          ...makeChain(),
          insert: vi.fn(() => {
            contactInsertCalled = true
            return makeChain()
          }),
        }
      }
      if (table === 'conversations') {
        return makeChain({ data: { id: 'conv-1', unread_count: 0 }, error: null })
      }
      if (table === 'messages') {
        return {
          ...makeChain(),
          insert: () => ({
            select: () => ({ single: async () => ({ data: null, error: null }) }),
          }),
          select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.head) return makeCountChain(0)
            return makeChain()
          },
        }
      }
      return makeChain()
    })

    const events = [
      {
        kind: 'message' as const,
        message: {
          id: 'wamid-2',
          from: '15555550100',
          timestamp: '1700000000',
          type: 'text' as const,
          text: { body: 'again' },
        },
        contact: { phone: '15555550100', name: 'Alice' },
      },
    ]
    await processInboundEvents(events, CTX)
    expect(contactInsertCalled).toBe(false)
  })
})

// ============================================================
// reaction kind
// ============================================================

describe('processInboundEvents — reaction kind', () => {
  it('upserts into message_reactions and skips the messages insert', async () => {
    // Reaction is short-circuited — but only AFTER the
    // contact + conversation find-or-create runs. So we need
    // those to return rows (mocked). The `messages` table
    // must satisfy two distinct calls:
    //   (a) lookupInternalIdByMetaId → select('id').eq().eq().maybeSingle()
    //   (b) the regular message insert — should NOT be called.
    vi.mocked(findExistingContact).mockResolvedValue({
      id: 'contact-existing',
      name: 'Alice',
      phone: '15555550100',
    } as any)

    let msgInsertCalled = false
    let reactionUpsertCalled = false

    fromMock.mockImplementation((table: string) => {
      if (table === 'contacts') {
        return makeChain({ data: { id: 'contact-existing' }, error: null })
      }
      if (table === 'conversations') {
        return makeChain({ data: { id: 'conv-1', unread_count: 0 }, error: null })
      }
      if (table === 'messages') {
        // Track eq calls so the lookup can return a target id
        // after two .eq()s. The lookup path is the ONLY thing
        // that touches messages for a reaction event.
        const chain: any = {
          insert: vi.fn(() => {
            msgInsertCalled = true
            return makeChain()
          }),
          select: vi.fn(() => chain),
          eq: vi.fn(() => chain),
          maybeSingle: vi.fn(async () => ({ data: { id: 'msg-target' }, error: null })),
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: { id: 'msg-target' }, error: null }),
        }
        return chain
      }
      if (table === 'message_reactions') {
        return {
          ...makeChain(),
          upsert: vi.fn(() => {
            reactionUpsertCalled = true
            return makeChain()
          }),
        }
      }
      return makeChain()
    })

    const events = [
      {
        kind: 'message' as const,
        message: {
          id: 'wamid-r',
          from: '15555550100',
          timestamp: '1700000000',
          type: 'reaction' as const,
          reaction: { message_id: 'wamid-target', emoji: '❤️' },
        },
        contact: { phone: '15555550100', name: 'Alice' },
      },
    ]
    await processInboundEvents(events, CTX)
    expect(reactionUpsertCalled).toBe(true)
    expect(msgInsertCalled).toBe(false)
  })
})

// ============================================================
// status kind
// ============================================================

describe('processInboundEvents — status kind (ladder)', () => {
  it('updates messages.status and skips stale updates on broadcast_recipients', async () => {
    const updateCalls: Array<{ table: string; patch: any }> = []

    fromMock.mockImplementation((table: string) => {
      if (table === 'messages') {
        return {
          ...makeChain({ error: null }),
          update: (patch: any) => {
            updateCalls.push({ table, patch })
            return { eq: () => makeChain() }
          },
        }
      }
      if (table === 'broadcast_recipients') {
        return {
          ...makeChain({ data: { id: 'r-1', status: 'replied' }, error: null }),
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: 'r-1', status: 'replied' }, error: null }),
            }),
          }),
          update: (patch: any) => {
            updateCalls.push({ table, patch })
            return { eq: () => makeChain() }
          },
        }
      }
      return makeChain()
    })

    const events = [
      {
        kind: 'status' as const,
        status: {
          id: 'wamid-target',
          status: 'read' as const,
          timestamp: 1700000000,
          recipient_id: '15555550100',
        },
      },
    ]
    await processInboundEvents(events, CTX)
    // messages table is always updated (legacy mirror). The
    // broadcast_recipients table must NOT be touched — the
    // recipient is already at `replied` and the ladder forbids
    // a backwards move.
    const recipientUpdates = updateCalls.filter((c) => c.table === 'broadcast_recipients')
    expect(recipientUpdates).toEqual([])
  })

  it('updates broadcast_recipients for a forward transition', async () => {
    const updateCalls: Array<{ table: string; patch: any }> = []

    fromMock.mockImplementation((table: string) => {
      if (table === 'messages') {
        return {
          ...makeChain({ error: null }),
          update: (patch: any) => {
            updateCalls.push({ table, patch })
            return { eq: () => makeChain() }
          },
        }
      }
      if (table === 'broadcast_recipients') {
        return {
          ...makeChain({ data: { id: 'r-1', status: 'sent' }, error: null }),
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: 'r-1', status: 'sent' }, error: null }),
            }),
          }),
          update: (patch: any) => {
            updateCalls.push({ table, patch })
            return { eq: () => makeChain() }
          },
        }
      }
      return makeChain()
    })

    const events = [
      {
        kind: 'status' as const,
        status: {
          id: 'wamid-target',
          status: 'delivered' as const,
          timestamp: 1700000000,
          recipient_id: '15555550100',
        },
      },
    ]
    await processInboundEvents(events, CTX)
    const recipientUpdates = updateCalls.filter((c) => c.table === 'broadcast_recipients')
    expect(recipientUpdates.length).toBe(1)
    expect(recipientUpdates[0].patch.status).toBe('delivered')
  })
})

// ============================================================
// template_change kind
// ============================================================

describe('processInboundEvents — template_change kind', () => {
  it('forwards to handleTemplateWebhookChange with the field + value', async () => {
    const events = [
      {
        kind: 'template_change' as const,
        field: 'message_template_status_update',
        value: { message_template_id: '987', event: 'APPROVED' },
      },
    ]
    await processInboundEvents(events, CTX)
    expect(handleTemplateWebhookChange).toHaveBeenCalledTimes(1)
    expect(handleTemplateWebhookChange).toHaveBeenCalledWith(
      { field: 'message_template_status_update', value: { message_template_id: '987', event: 'APPROVED' } },
      expect.anything(),
    )
  })
})

// ============================================================
// connection_update kind
// ============================================================

describe('processInboundEvents — connection_update kind', () => {
  it('persists the new state on the Evolution config row', async () => {
    let updateCalled = false
    fromMock.mockImplementation((table: string) => {
      if (table === 'whatsapp_config') {
        return {
          ...makeChain(),
          update: (patch: any) => {
            updateCalled = true
            expect(patch.evolution_connection_state).toBe('connected')
            return { eq: () => makeChain() }
          },
        }
      }
      return makeChain()
    })

    const events = [
      {
        kind: 'connection_update' as const,
        state: 'connected' as const,
      },
    ]
    await processInboundEvents(events, CTX)
    expect(updateCalled).toBe(true)
  })

  it('records the disconnect reason when state is disconnected', async () => {
    let updateCalled = false
    fromMock.mockImplementation((table: string) => {
      if (table === 'whatsapp_config') {
        return {
          ...makeChain(),
          update: (patch: any) => {
            updateCalled = true
            expect(patch.evolution_connection_state).toBe('disconnected')
            expect(patch.evolution_last_disconnect_reason).toBe('logged out')
            return { eq: () => makeChain() }
          },
        }
      }
      return makeChain()
    })

    const events = [
      {
        kind: 'connection_update' as const,
        state: 'disconnected' as const,
        reason: 'logged out',
      },
    ]
    await processInboundEvents(events, CTX)
    expect(updateCalled).toBe(true)
  })
})

// ============================================================
// error isolation
// ============================================================

describe('processInboundEvents — error isolation', () => {
  it('continues processing subsequent events when one throws', async () => {
    // First event throws via a select that errors badly, second
    // event should still be processed.
    let secondMsgInsertCalled = false
    let callCount = 0

    fromMock.mockImplementation((table: string) => {
      if (table === 'contacts') {
        return {
          ...makeChain({ data: { id: 'c1', name: 'A', phone: '1' }, error: null }),
        }
      }
      if (table === 'conversations') {
        return makeChain({ data: { id: 'conv-1', unread_count: 0 }, error: null })
      }
      if (table === 'messages') {
        // First call: select throws. Second call: succeeds.
        callCount++
        if (callCount === 1) {
          return {
            ...makeChain(),
            select: () => {
              throw new Error('boom')
            },
          }
        }
        return {
          ...makeChain(),
          insert: () => {
            secondMsgInsertCalled = true
            return {
              select: () => ({ single: async () => ({ data: null, error: null }) }),
            }
          },
          select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.head) return makeCountChain(0)
            return makeChain()
          },
        }
      }
      return makeChain()
    })

    const ev = {
      kind: 'message' as const,
      message: {
        id: 'a',
        from: '1',
        timestamp: '1700000000',
        type: 'text' as const,
        text: { body: 'x' },
      },
      contact: { phone: '1', name: 'A' },
    }
    await processInboundEvents([ev, ev], CTX)
    // The first event hit the throwing select; the dispatcher
    // should have caught and moved on to the second event.
    expect(secondMsgInsertCalled).toBe(true)
  })
})
