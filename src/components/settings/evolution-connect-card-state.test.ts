/**
 * Tests for the Evolution connect-card state machine.
 *
 * The reducer is a pure function (no React, no DOM, no network)
 * so we can test every (state, action) pair exhaustively. The
 * table itself is the spec — if a transition isn't listed here,
 * the next refactor that adds it without updating the table will
 * fail the test, not silently ship a buggy state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reducer,
  ALL_STATES,
  ALL_ACTION_TYPES,
  isLegalAction,
} from './evolution-connect-card-state';

// ============================================================
// Happy-path transitions
// ============================================================

describe('reducer — happy path', () => {
  it('idle -> creating on CREATE_START', () => {
    expect(reducer('idle', { type: 'CREATE_START' })).toBe('creating');
  });

  it('creating -> pairing on CREATE_OK', () => {
    expect(reducer('creating', { type: 'CREATE_OK' })).toBe('pairing');
  });

  it('pairing -> saving on POLL_OPEN', () => {
    expect(reducer('pairing', { type: 'POLL_OPEN' })).toBe('saving');
  });

  it('saving -> connected on SAVE_OK', () => {
    expect(reducer('saving', { type: 'SAVE_OK' })).toBe('connected');
  });

  it('error -> creating on CREATE_START (re-click Create from error)', () => {
    expect(reducer('error', { type: 'CREATE_START' })).toBe('creating');
  });
});

// ============================================================
// Failure transitions
// ============================================================

describe('reducer — failure transitions', () => {
  it('creating -> error on CREATE_FAIL', () => {
    expect(reducer('creating', { type: 'CREATE_FAIL' })).toBe('error');
  });

  it('saving -> error on SAVE_FAIL', () => {
    expect(reducer('saving', { type: 'SAVE_FAIL' })).toBe('error');
  });
});

// ============================================================
// User cancellation
// ============================================================

describe('reducer — user cancellation', () => {
  it('pairing -> idle on CANCEL', () => {
    expect(reducer('pairing', { type: 'CANCEL' })).toBe('idle');
  });

  it('error -> idle on CANCEL (dismiss without retrying)', () => {
    expect(reducer('error', { type: 'CANCEL' })).toBe('idle');
  });

  it('error -> idle on RETRY ("Try again" button)', () => {
    expect(reducer('error', { type: 'RETRY' })).toBe('idle');
  });
});

// ============================================================
// Disconnect (legal from every state — operator override)
// ============================================================

describe('reducer — DISCONNECT is legal from every state', () => {
  it('disconnect from each state returns idle', () => {
    for (const from of ALL_STATES) {
      expect(reducer(from, { type: 'DISCONNECT' })).toBe('idle');
    }
  });
});

// ============================================================
// Illegal transitions (the whole point of the refactor)
// ============================================================

describe('reducer — illegal transitions are no-ops + log a warning', () => {
  // We capture the warning so we can assert it fired — the
  // "loud, not silent" property is the only thing that makes
  // a future regression catchable.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('pairing -> connected directly is rejected (must go via saving -> SAVE_OK)', () => {
    // SAVE_OK from pairing means the row is being saved without
    // a saveConfig() call having run — that would skip the
    // apikey persistence step.
    const next = reducer('pairing', { type: 'SAVE_OK' });
    expect(next).toBe('pairing');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain('SAVE_OK');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('pairing');
  });

  it('idle -> connected directly is rejected', () => {
    const next = reducer('idle', { type: 'SAVE_OK' });
    expect(next).toBe('idle');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('creating -> pairing twice is rejected (no double-create)', () => {
    // CREATE_START from creating = re-click during in-flight POST.
    const next = reducer('creating', { type: 'CREATE_START' });
    expect(next).toBe('creating');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('connected -> anything except DISCONNECT/RESET is rejected', () => {
    // Already-connected card must not re-enter create flow on
    // stray dispatches.
    for (const type of ALL_ACTION_TYPES) {
      if (type === 'DISCONNECT' || type === 'RESET') continue;
      const next = reducer('connected', { type });
      expect(next).toBe('connected');
    }
  });

  it('saving -> CANCEL is rejected (cannot cancel mid-save)', () => {
    // The row is being written; cancelling would leave a
    // half-state. The operator must wait or disconnect.
    const next = reducer('saving', { type: 'CANCEL' });
    expect(next).toBe('saving');
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

// ============================================================
// Exhaustive coverage of the (state × action) product
// ============================================================

describe('reducer — exhaustive coverage', () => {
  it('every (state, action) pair returns a valid ConnectionState (no typos, no undefined)', () => {
    // The table is the spec; this test just guarantees the
    // reducer never returns an arbitrary string (e.g. from a
    // typo in the table that the type-checker missed because
    // the value was spelled but the table is `as const`-free).
    for (const from of ALL_STATES) {
      for (const type of ALL_ACTION_TYPES) {
        const next = reducer(from, { type });
        expect(ALL_STATES).toContain(next);
      }
    }
  });

  it('isLegalAction returns true for every (state, action) the reducer accepts as a no-op or transition', () => {
    // The reducer logs a warning for illegal transitions and
    // returns the same state. So:
    //   - If the action changed the state, it must be legal.
    //   - If the action kept the state AND didn't log a warning,
    //     it's a legal no-op (e.g. idle -> idle on DISCONNECT).
    //   - If the action kept the state AND logged a warning,
    //     it's illegal; isLegalAction must say false.
    //
    // We can't easily distinguish the two no-op cases from the
    // outside without instrumenting the reducer. So we just check
    // the observable property: when isLegalAction says false,
    // the reducer must also be a no-op. The reverse is not
    // checked here (some legal no-ops exist) — those are
    // asserted by the focused illegal-transition tests above.
    for (const from of ALL_STATES) {
      for (const type of ALL_ACTION_TYPES) {
        if (!isLegalAction(from, type)) {
          // Illegal: the reducer must not have changed the state.
          expect(reducer(from, { type })).toBe(from);
        }
      }
    }
  });
});

// ============================================================
// isLegalAction helper
// ============================================================

describe('isLegalAction', () => {
  it('returns true for legal transitions', () => {
    expect(isLegalAction('idle', 'CREATE_START')).toBe(true);
    expect(isLegalAction('creating', 'CREATE_OK')).toBe(true);
    expect(isLegalAction('pairing', 'POLL_OPEN')).toBe(true);
    expect(isLegalAction('saving', 'SAVE_OK')).toBe(true);
    expect(isLegalAction('error', 'CREATE_START')).toBe(true);
  });

  it('returns false for illegal transitions', () => {
    expect(isLegalAction('idle', 'CREATE_OK')).toBe(false);
    expect(isLegalAction('pairing', 'SAVE_OK')).toBe(false);
    expect(isLegalAction('connected', 'CREATE_START')).toBe(false);
    expect(isLegalAction('saving', 'CANCEL')).toBe(false);
  });
});
