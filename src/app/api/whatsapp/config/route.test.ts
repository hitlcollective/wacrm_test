/**
 * Tests for the Evolution branch of GET /api/whatsapp/config —
 * specifically the JID-race fix in `handleEvolutionGet`.
 *
 * Race we are guarding against: Evolution's `state` flips to 'open'
 * BEFORE Baileys has assigned the JID (typically a few hundred ms
 * gap). The previous code wrote `evolution_connected_jid: null` and
 * `status: 'connected'` on that first poll, which made the UI
 * briefly show "Connected" with no JID — and any outbound send
 * keyed on the JID would fail.
 *
 * Tests cover the three observable states the route must now
 * produce for Evolution:
 *   1. state=open, JID present       → fully_connected=true, row.status='connected', row gets the JID + connected_at
 *   2. state=open, JID null (race)   → fully_connected=false, row.status='disconnected', row does NOT get a null JID
 *   3. state=close                   → fully_connected=false, row.status='disconnected', JID unchanged
 *
 * Plus the two negative cases the route always had to handle:
 *   4. missing baseUrl / instanceName → 'incomplete_config' 200
 *   5. evolutionUnreachable           → 'evolution_unreachable' 200
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================
// Module mocks
// ============================================================

// Supabase — we only need a tiny mock for what handleEvolutionGet
// touches: getUser, profiles.select, whatsapp_config.select,
// whatsapp_config.update. (handleMetaGet is a separate path that
// we don't exercise here.)
const getUserMock = vi.fn();
const profileSelectMock = vi.fn();
const profileEqMock = vi.fn();
const profileMaybeSingleMock = vi.fn();
const configSelectMock = vi.fn();
const configEqMock = vi.fn();
const configMaybeSingleMock = vi.fn();
const configUpdateEqMock = vi.fn();
const configUpdateMock = vi.fn();

function makeSupabaseClient() {
  profileSelectMock.mockReturnValue({ eq: profileEqMock });
  profileEqMock.mockReturnValue({ maybeSingle: profileMaybeSingleMock });
  configSelectMock.mockReturnValue({ eq: configEqMock });
  configEqMock.mockReturnValue({ maybeSingle: configMaybeSingleMock });
  configUpdateEqMock.mockReturnValue({}); // thenable — ignored
  configUpdateMock.mockReturnValue({ eq: configUpdateEqMock });

  // The mock chain has to return a wide contract because we model
  // Supabase's fluent API — select/eq/insert/update etc. all chain
  // off `from()`. A `any` is the cleanest expression of that here
  // (a real type would either be a 50-line union or a near-empty
  // intersection that TS would still widen).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    auth: { getUser: getUserMock },
    from: (table: string) => {
      if (table === 'profiles') {
        return { select: profileSelectMock };
      }
      if (table === 'whatsapp_config') {
        return {
          select: configSelectMock,
          update: configUpdateMock,
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeSupabaseClient(),
}));

// The admin-client helper is only used by the Meta path; supply a
// noop so importing the route doesn't fail.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => ({ data: null, error: null }) }),
      }),
    }),
  }),
}));

const { getStatusMock, EvolutionLifecycleClientMock } = (() => {
  // We need a `new`-able mock of EvolutionLifecycleClient because
  // the route does `new EvolutionLifecycleClient(...)`. A plain
  // vi.fn().mockImplementation(...) returns an arrow function
  // which can't be `new`'d (Vitest throws 'is not a constructor'),
  // so we use a real class below. The class is hoisted in the
  // factory closure so it survives vi.mock's module substitution.
  const getStatusMock = vi.fn();
  class EvolutionLifecycleClientMock {
    getStatus = getStatusMock;
  }
  return { getStatusMock, EvolutionLifecycleClientMock };
})();

vi.mock('@/lib/whatsapp/evolution/instance-client', () => ({
  EvolutionLifecycleClient: EvolutionLifecycleClientMock,
  EvolutionLifecycleError: class extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.name = 'EvolutionLifecycleError';
      this.status = status;
      this.body = body;
    }
  },
}));

// ============================================================
// Imports (after mocks)
// ============================================================

const { GET } = await import('./route');

// ============================================================
// Helpers
// ============================================================

const USER_ID = 'user-1';
const ACCOUNT_ID = 'acc-1';

function setAuth(userId: string | null) {
  if (userId === null) {
    getUserMock.mockResolvedValue({
      data: { user: null },
      error: { message: 'unauthorized' },
    });
  } else {
    getUserMock.mockResolvedValue({
      data: { user: { id: userId } },
      error: null,
    });
  }
}

function setAccountId(accountId: string | null) {
  if (accountId === null) {
    profileMaybeSingleMock.mockResolvedValue({ data: null, error: null });
  } else {
    profileMaybeSingleMock.mockResolvedValue({
      data: { account_id: accountId },
      error: null,
    });
  }
}

/**
 * Set up the config row that the GET handler will read. The handler
 * always reads `provider, phone_number_id, access_token, status,
 * evolution_base_url, evolution_instance_name, evolution_apikey,
 * evolution_connection_state, evolution_connected_jid`. We only
 * need to set the evolution_* fields; the others are read but not
 * touched for the Evolution branch.
 */
function setConfigRow(overrides: Record<string, unknown> = {}) {
  configMaybeSingleMock.mockResolvedValue({
    data: {
      provider: 'evolution',
      phone_number_id: null,
      access_token: '',
      status: 'disconnected',
      evolution_base_url: 'https://evo.example.com',
      evolution_instance_name: 'inst-1',
      evolution_apikey: 'encrypted-apikey',
      evolution_connection_state: 'connecting',
      evolution_connected_jid: null,
      ...overrides,
    },
    error: null,
  });
}

/** Read what the route tried to UPDATE on the row. */
function getLastUpdate() {
  expect(configUpdateMock).toHaveBeenCalled();
  return configUpdateMock.mock.calls.at(-1)![0] as Record<string, unknown>;
}

beforeEach(() => {
  getUserMock.mockReset();
  profileSelectMock.mockReset();
  profileEqMock.mockReset();
  profileMaybeSingleMock.mockReset();
  configSelectMock.mockReset();
  configEqMock.mockReset();
  configMaybeSingleMock.mockReset();
  configUpdateEqMock.mockReset();
  configUpdateMock.mockReset();
  getStatusMock.mockReset();
  // process.env.EVOLUTION_GLOBAL_APIKEY is read in the route, set it here.
  process.env.EVOLUTION_GLOBAL_APIKEY = 'global-key';
  setAuth(USER_ID);
  setAccountId(ACCOUNT_ID);
  setConfigRow();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// Auth + validation
// ============================================================

describe('GET /api/whatsapp/config — Evolution auth + validation', () => {
  it('returns 401 when there is no session', async () => {
    setAuth(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns 200 with reason=no_account when the user has no profile', async () => {
    // The route deliberately returns 200 (not 4xx) for "no account"
    // so the UI can render the right remediation message instead of
    // showing a generic 5xx toast. The `reason` field tells the
    // client what to do (e.g. show "Your profile is not linked").
    setAccountId(null);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reason: 'no_account' });
  });

  it('returns 200 with reason=incomplete_config when baseUrl is missing', async () => {
    setConfigRow({ evolution_base_url: null });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      provider: 'evolution',
      connected: false,
      reason: 'incomplete_config',
    });
  });

  it('returns 200 with reason=server_misconfigured when EVOLUTION_GLOBAL_APIKEY is unset', async () => {
    delete process.env.EVOLUTION_GLOBAL_APIKEY;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      provider: 'evolution',
      connected: false,
      reason: 'server_misconfigured',
    });
  });
});

// ============================================================
// JID race fix — the three observable states
// ============================================================

describe('GET /api/whatsapp/config — Evolution JID race', () => {
  it('marks fully_connected=true and writes connected row when state=open AND JID is present', async () => {
    getStatusMock.mockResolvedValueOnce({
      state: 'open',
      ownerJid: '15555550100@s.whatsapp.net',
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      provider: 'evolution',
      connected: true,
      evolution: {
        state: 'open',
        ownerJid: '15555550100@s.whatsapp.net',
        fully_connected: true,
        instance_name: 'inst-1',
      },
    });

    const update = getLastUpdate();
    expect(update.status).toBe('connected');
    expect(update.evolution_connection_state).toBe('connected');
    expect(update.evolution_connected_jid).toBe('15555550100@s.whatsapp.net');
    expect(typeof update.connected_at).toBe('string');
    expect(typeof update.evolution_last_seen_at).toBe('string');
  });

  it('marks fully_connected=false and does NOT write a null JID when state=open but JID is null', async () => {
    // This is the JID race: state flipped to 'open' before Baileys
    // assigned a JID. The previous behaviour wrote a null JID
    // and status='connected'; the fix defers that until the JID
    // appears.
    getStatusMock.mockResolvedValueOnce({
      state: 'open',
      ownerJid: null,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      provider: 'evolution',
      // `connected` still keys on the live Evolution state — the
      // existing UI's "Connected" badge works the same way.
      connected: true,
      evolution: {
        state: 'open',
        ownerJid: null,
        fully_connected: false,
      },
    });

    const update = getLastUpdate();
    // Critical assertions — the bug we're fixing:
    expect(update.status).toBe('disconnected'); // NOT 'connected'
    expect(update.evolution_connection_state).toBe('connecting'); // NOT 'connected'
    // The fix never writes `evolution_connected_jid: null` — it
    // omits the field entirely so the existing value (if any) is
    // preserved.
    expect('evolution_connected_jid' in update).toBe(false);
    expect('connected_at' in update).toBe(false);
    // last_seen_at also stays null during the race window.
    expect(update.evolution_last_seen_at).toBeNull();
  });

  it('marks connected=false and writes disconnected row when state=close', async () => {
    getStatusMock.mockResolvedValueOnce({
      state: 'close',
      ownerJid: null,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      provider: 'evolution',
      connected: false,
      evolution: {
        state: 'close',
        ownerJid: null,
        fully_connected: false,
      },
    });

    const update = getLastUpdate();
    expect(update.status).toBe('disconnected');
    expect(update.evolution_connection_state).toBe('close');
    expect('evolution_connected_jid' in update).toBe(false);
    expect('connected_at' in update).toBe(false);
  });

  it('preserves a previously-stored JID across the race window (does not overwrite with null)', async () => {
    // The row already has a JID (from a previous successful poll).
    // The next poll returns state=open but no JID (race). The fix
    // must NOT clobber the stored JID with null.
    setConfigRow({ evolution_connected_jid: 'previous-jid@old.example' });
    getStatusMock.mockResolvedValueOnce({
      state: 'open',
      ownerJid: null,
    });

    await GET();
    const update = getLastUpdate();
    expect('evolution_connected_jid' in update).toBe(false);
  });
});

// ============================================================
// Unreachable / network errors
// ============================================================

describe('GET /api/whatsapp/config — Evolution unreachable', () => {
  it('returns 200 with reason=evolution_unreachable when getStatus throws', async () => {
    // Re-mock the lifecycle client to throw (the per-test reset
    // in beforeEach clears the implementation, so we re-stub here).
    getStatusMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      provider: 'evolution',
      connected: false,
      reason: 'evolution_unreachable',
    });
  });
});
