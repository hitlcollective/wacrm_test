/**
 * Pure-function state machine for the Evolution connect card.
 *
 * Why a reducer, not `useState<State>`:
 *   The previous code used `useState<ConnectionState>` with a
 *   hand-maintained `setState(...)` call at every transition
 *   point. That's a string-state machine — easy to introduce
 *   illegal transitions (e.g. `pairing` -> `connected` directly,
 *   skipping the saveConfig step) and hard to verify in tests.
 *
 *   This module replaces those with an explicit transition table.
 *   Each `Action` is only honoured from the states that should
 *   accept it; every other case returns the current state
 *   unchanged AND logs a warning, so a future refactor that
 *   accidentally triggers a bad transition is loud, not silent.
 *
 * The reducer is a pure function — no React, no DOM, no network.
 * All transitions are testable in isolation (see
 * `evolution-connect-card-state.test.ts`).
 */

/**
 * Connection state machine for the Evolution connect flow.
 *
 *   idle      -> user hasn't started; the form is shown
 *   creating  -> POST /api/whatsapp/evolution/instance in flight
 *   pairing   -> instance exists, waiting for phone scan
 *   saving    -> phone paired, POST /api/whatsapp/config in flight
 *   connected -> all persisted; card switches to the "connected" view
 *   error     -> something blew up; card shows the error + retry
 */
export type ConnectionState =
  | 'idle'
  | 'creating'
  | 'pairing'
  | 'saving'
  | 'connected'
  | 'error';

/**
 * Discriminated-union actions the card dispatches.
 *
 *   CREATE_START  — operator clicked "Create + Pair"
 *   CREATE_OK     — instance POST returned 200 with the createResp
 *   CREATE_FAIL   — instance POST returned non-2xx or threw
 *   POLL_OPEN     — status poll reports state === 'open' (phone paired)
 *   SAVE_OK       — config POST returned 200
 *   SAVE_FAIL     — config POST returned non-2xx or threw
 *   CANCEL        — operator clicked "Cancel" in the pairing card
 *   DISCONNECT    — operator confirmed disconnect; the local
 *                   state should reset regardless of what step
 *                   we were on
 *   RETRY         — operator clicked "Try again" on the error banner
 *   RESET         — defensive: clear to idle from any state
 *                   (used when the connect card unmounts/re-mounts)
 */
export type ConnectionAction =
  | { type: 'CREATE_START' }
  | { type: 'CREATE_OK' }
  | { type: 'CREATE_FAIL' }
  | { type: 'POLL_OPEN' }
  | { type: 'SAVE_OK' }
  | { type: 'SAVE_FAIL' }
  | { type: 'CANCEL' }
  | { type: 'DISCONNECT' }
  | { type: 'RETRY' }
  | { type: 'RESET' };

/**
 * The transition table. `null` means "this action is illegal in
 * this state — return current state unchanged + warn". Anything
 * else is the next state.
 *
 * Encoded as a 2D map (state × action -> nextState | null) so the
 * table reads as a single block and is exhaustive over the
 * (state, action) product — TypeScript enforces the keys match
 * the union types.
 */
const TRANSITIONS: {
  [S in ConnectionState]: {
    [A in ConnectionAction['type']]: ConnectionState | null;
  };
} = {
  idle: {
    CREATE_START: 'creating',
    CREATE_OK: null, // can't be in idle and receive a successful create
    CREATE_FAIL: null,
    POLL_OPEN: null,
    SAVE_OK: null,
    SAVE_FAIL: null,
    CANCEL: null, // nothing to cancel
    DISCONNECT: 'idle', // no-op (we're already idle) but legal
    RETRY: 'idle', // no-op (we're already idle) but legal
    RESET: 'idle',
  },
  creating: {
    CREATE_START: null, // already creating — re-click is a no-op
    CREATE_OK: 'pairing',
    CREATE_FAIL: 'error',
    POLL_OPEN: null, // polls shouldn't fire while creating
    SAVE_OK: null, // can't save before creating
    SAVE_FAIL: null,
    CANCEL: null, // can't cancel mid-create; the operator must wait
    DISCONNECT: 'idle', // abandoning mid-create is legal
    RETRY: 'idle', // abandoning mid-create is legal
    RESET: 'idle',
  },
  pairing: {
    CREATE_START: null, // don't re-create while pairing
    CREATE_OK: null, // we already have a createResp
    CREATE_FAIL: null, // pairing implies a successful create
    POLL_OPEN: 'saving',
    SAVE_OK: null, // save only happens after the POLL_OPEN -> saving
    SAVE_FAIL: null,
    CANCEL: 'idle',
    DISCONNECT: 'idle', // disconnect is always legal
    RETRY: 'idle', // give up on the current pairing attempt
    RESET: 'idle',
  },
  saving: {
    CREATE_START: null,
    CREATE_OK: null,
    CREATE_FAIL: null,
    POLL_OPEN: null, // already past the open-event — polls should stop
    SAVE_OK: 'connected',
    SAVE_FAIL: 'error',
    CANCEL: null, // can't cancel mid-save (the row is being written)
    DISCONNECT: 'idle', // operator wants out at any cost
    RETRY: 'idle', // operator wants out
    RESET: 'idle',
  },
  connected: {
    CREATE_START: null, // must disconnect before re-pairing
    CREATE_OK: null,
    CREATE_FAIL: null,
    POLL_OPEN: null,
    SAVE_OK: null,
    SAVE_FAIL: null,
    CANCEL: null,
    DISCONNECT: 'idle',
    RETRY: null, // doesn't make sense from connected
    RESET: 'idle',
  },
  error: {
    CREATE_START: 'creating', // re-click Create from error
    CREATE_OK: null,
    CREATE_FAIL: null,
    POLL_OPEN: null,
    SAVE_OK: null,
    SAVE_FAIL: null,
    CANCEL: 'idle', // dismiss the error without retrying
    DISCONNECT: 'idle',
    RETRY: 'idle', // operator clicked "Try again" — back to idle so they can re-submit
    RESET: 'idle',
  },
};

/**
 * Apply an action to the current state.
 *
 * If the action is illegal in the current state, the current
 * state is returned unchanged AND a warning is logged via
 * `console.warn`. The warning is the only side effect; the
 * reducer remains pure enough to test.
 */
export function reducer(
  state: ConnectionState,
  action: ConnectionAction
): ConnectionState {
  const next = TRANSITIONS[state][action.type];
  if (next === null) {
    // Illegal transition. Loud, not silent — the whole point of
    // the reducer is to make these impossible to ignore.
    if (typeof console !== 'undefined') {
      console.warn(
        `[evolution-connect-card] ignored illegal action ${action.type} in state ${state}`
      );
    }
    return state;
  }
  return next;
}

/**
 * Pure helpers used by the component. Kept in this module so the
 * state machine + its test file live in one place.
 */

/** All ConnectionState values, in display order (used for tests). */
export const ALL_STATES: readonly ConnectionState[] = [
  'idle',
  'creating',
  'pairing',
  'saving',
  'connected',
  'error',
] as const;

/** All ConnectionAction types. */
export const ALL_ACTION_TYPES: readonly ConnectionAction['type'][] = [
  'CREATE_START',
  'CREATE_OK',
  'CREATE_FAIL',
  'POLL_OPEN',
  'SAVE_OK',
  'SAVE_FAIL',
  'CANCEL',
  'DISCONNECT',
  'RETRY',
  'RESET',
] as const;

/**
 * Predicate: is `action` legal from `state`? Useful for the
 * component to short-circuit an async handler when a poll fires
 * after the user has already cancelled.
 */
export function isLegalAction(
  state: ConnectionState,
  action: ConnectionAction['type']
): boolean {
  return TRANSITIONS[state][action] !== null;
}
