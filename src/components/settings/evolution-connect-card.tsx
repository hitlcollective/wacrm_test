'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  QrCode,
  PowerOff,
  RefreshCw,
  Smartphone,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';
import { reducer as connectionReducer } from './evolution-connect-card-state';

/**
 * Evolution API connect card.
 *
 * Replaces the Meta form (in spirit) when the operator toggles
 * the WhatsApp section to "Evolution". The flow is:
 *
 *   1. User types or confirms a Base URL (pre-filled from
 *      NEXT_PUBLIC_EVOLUTION_DEFAULT_BASE_URL when set).
 *   2. Clicks "Create + Pair" → POST /api/whatsapp/evolution/instance.
 *      The server creates the instance, mints a per-account
 *      webhook secret, registers the inbound URL, and returns
 *      the per-instance apikey + secret.
 *   3. The card shows a QR (poll every ~5s, the code rotates
 *      while unpaired) and a status badge (poll every ~3s).
 *   4. When the status reports `state === 'open'` (phone paired),
 *      the card auto-saves via POST /api/whatsapp/config with
 *      `provider: 'evolution'` and switches to the "connected"
 *      view.
 *   5. "Disconnect" calls DELETE /api/whatsapp/evolution/instance,
 *      which deletes the instance on Evolution AND clears the
 *      evolution_* columns on the whatsapp_config row.
 *
 * The card has no opinion on the wider app — it only talks to
 * the four /api/whatsapp/evolution/* routes. The Settings →
 * WhatsApp section wraps the provider toggle (Meta vs Evolution)
 * around this card + the existing Meta form.
 *
 * State machine: see ./evolution-connect-card-state.ts. Every
 * transition is explicit; illegal transitions log a warning
 * and return the current state unchanged.
 */

interface CreateResponse {
  instanceName: string;
  apikey: string;
  webhookSecret: string;
  baseUrl: string;
  webhookRegistered: boolean;
  warning?: string;
}

interface StatusResponse {
  state: string | null;
  ownerJid: string | null;
}

const DEFAULT_BASE_URL =
  process.env.NEXT_PUBLIC_EVOLUTION_DEFAULT_BASE_URL ?? '';

const POLL_STATUS_MS = 3000;
const POLL_QR_MS = 5000;

export function EvolutionConnectCard() {
  const supabase = createClient();
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  // Idle form state
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [existing, setExisting] = useState<WhatsAppConfigType | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(true);

  // Pairing state
  const [createResp, setCreateResp] = useState<CreateResponse | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  // Connection state machine — every transition is validated
  // against the table in ./evolution-connect-card-state.ts.
  // Illegal transitions log a warning and keep the current
  // state, so a stray dispatch can never put the card in a
  // state the rest of the code doesn't know how to render.
  const [state, dispatch] = useReducer(connectionReducer, 'idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reRegistering, setReRegistering] = useState(false);

  // Refs to manage the polling loops and cancellation
  const qrTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  // ============================================================
  // Initial load — read existing config so we can show the
  // "connected" view on re-entry without re-pairing.
  // ============================================================
  const loadExisting = useCallback(
    async (acctId: string) => {
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', acctId)
        .maybeSingle();
      if (error) {
        console.error('Failed to load existing config:', error);
      }
      setExisting(data);
      setLoadingExisting(false);
    },
    [supabase]
  );

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      setLoadingExisting(false);
      return;
    }
    loadExisting(accountId);
  }, [authLoading, profileLoading, user, accountId, loadExisting]);

  // ============================================================
  // Polling: status (3s) + QR (5s) while pairing
  // ============================================================
  const stopPolling = useCallback(() => {
    if (qrTimerRef.current) {
      clearTimeout(qrTimerRef.current);
      qrTimerRef.current = null;
    }
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  }, []);

  const pollStatus = useCallback(async () => {
    if (cancelledRef.current) return;
    if (!createResp) return;
    try {
      const res = await fetch(`/api/whatsapp/evolution/instance/status`);
      const payload = (await res.json()) as
        | { state: string | null; ownerJid: string | null }
        | { error: string };
      if ('error' in payload) {
        // Status endpoint failed — could be 404 (instance gone),
        // 502 (Evolution unreachable), etc. We surface the error
        // in the card and let the operator retry / disconnect.
        setErrorMsg(payload.error);
        return;
      }
      setStatus(payload);
      // When the phone is paired, save the config and stop
      // polling. The card switches to the "connected" view.
      //
      // Guard with `state !== 'saving' && state !== 'connected'`
      // so we don't re-enter saveConfig on every subsequent
      // poll. Once we start saving (or finish connected / fail
      // into error), the effect's cleanup in stopPolling()
      // tears down the timer; the guard here is belt-and-braces
      // for any future refactor that removes that cleanup.
      if (
        payload.state === 'open' &&
        state !== 'saving' &&
        state !== 'connected' &&
        state !== 'error'
      ) {
        await saveConfig(createResp);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'status poll failed';
      console.error('status poll failed:', message);
      // Don't surface transient network errors as fatal — just
      // keep polling. The next tick will retry.
    } finally {
      if (!cancelledRef.current && state !== 'connected') {
        statusTimerRef.current = setTimeout(pollStatus, POLL_STATUS_MS);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createResp, state]);

  const pollQr = useCallback(async () => {
    if (cancelledRef.current) return;
    if (!createResp) return;
    try {
      const res = await fetch(`/api/whatsapp/evolution/instance/qr`);
      const payload = (await res.json()) as
        | { pairingCode: string | null; count?: number }
        | { error: string };
      if ('error' in payload) {
        // 502 here likely means the instance is gone (operator
        // deleted it on the Evolution side). Keep the old QR
        // on screen and let the status poll notice.
        return;
      }
      setQr(payload.pairingCode);
    } catch (err) {
      console.error('qr poll failed:', err);
    } finally {
      if (!cancelledRef.current) {
        qrTimerRef.current = setTimeout(pollQr, POLL_QR_MS);
      }
    }
  }, [createResp]);

  // Kick off both polls whenever we enter the `pairing` state.
  useEffect(() => {
    if (state === 'pairing' && createResp) {
      cancelledRef.current = false;
      // Fire one immediately, then schedule.
      void pollStatus();
      void pollQr();
      return () => {
        cancelledRef.current = true;
        stopPolling();
      };
    }
    return () => {
      cancelledRef.current = true;
      stopPolling();
    };
  }, [state, createResp, pollStatus, pollQr, stopPolling]);

  // ============================================================
  // Save the per-instance apikey to whatsapp_config.
  // Called automatically when status reports state === open.
  // ============================================================
  async function saveConfig(createRespArg: CreateResponse) {
    // Transition pairing -> saving. The reducer's table makes
    // this legal only from `pairing`; if a poll fires after
    // we've already started saving (e.g. slow network), the
    // reducer logs a warning and keeps us in `saving` instead
    // of double-saving.
    dispatch({ type: 'POLL_OPEN' });
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'evolution',
          base_url: createRespArg.baseUrl,
          instance_name: createRespArg.instanceName,
          apikey: createRespArg.apikey,
          webhook_secret: createRespArg.webhookSecret,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? 'Failed to save Evolution configuration');
        dispatch({ type: 'SAVE_FAIL' });
        return;
      }
      stopPolling();
      dispatch({ type: 'SAVE_OK' });
      // Refresh the existing row so subsequent re-entries show
      // the connected state immediately.
      if (accountId) {
        await loadExisting(accountId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'save failed';
      setErrorMsg(message);
      dispatch({ type: 'SAVE_FAIL' });
    }
  }

  // ============================================================
  // Create + Pair
  // ============================================================
  async function handleCreate() {
    if (!baseUrl.trim()) {
      toast.error('Base URL is required');
      return;
    }
    setErrorMsg(null);
    // The reducer accepts CREATE_START from both `idle` (fresh
    // form) and `error` (re-click after a failed attempt). From
    // `pairing` / `creating` / `saving` it's rejected as a
    // double-submit — exactly what we want.
    dispatch({ type: 'CREATE_START' });
    try {
      const res = await fetch('/api/whatsapp/evolution/instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: baseUrl.trim() }),
      });
      const data = (await res.json()) as CreateResponse | { error: string };
      if (!res.ok || 'error' in data) {
        const message =
          'error' in data ? data.error : 'Failed to create Evolution instance';
        setErrorMsg(message);
        dispatch({ type: 'CREATE_FAIL' });
        return;
      }
      setCreateResp(data);
      if (data.warning) {
        toast.warning(data.warning, { duration: 10000 });
      }
      dispatch({ type: 'CREATE_OK' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'create failed';
      setErrorMsg(message);
      dispatch({ type: 'CREATE_FAIL' });
    }
  }

  // ============================================================
  // Disconnect
  // ============================================================
  async function handleDisconnect() {
    if (
      !confirm(
        'This will delete the Evolution instance and disconnect your WhatsApp number. Continue?'
      )
    ) {
      return;
    }
    try {
      const res = await fetch('/api/whatsapp/evolution/instance', {
        method: 'DELETE',
      });
      const data = (await res.json()) as
        | { success: true; warning?: string }
        | { error: string };
      if (!res.ok || 'error' in data) {
        const message = 'error' in data ? data.error : 'Failed to disconnect';
        toast.error(message);
        return;
      }
      if ('warning' in data && data.warning) {
        toast.warning(data.warning, { duration: 10000 });
      } else {
        toast.success('Disconnected from Evolution.');
      }
      stopPolling();
      setCreateResp(null);
      setQr(null);
      setStatus(null);
      // DISCONNECT is legal from every state — the reducer
      // accepts it as a no-op when there's nothing to tear
      // down. The cleanup of the other React state above is
      // intentionally NOT in the reducer; the reducer only
      // governs the connection lifecycle.
      dispatch({ type: 'DISCONNECT' });
      if (accountId) {
        await loadExisting(accountId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'disconnect failed';
      toast.error(message);
    }
  }

  // ============================================================
  // Re-register webhook
  //
  // The connect flow silently skips Evolution's `webhook/set` call
  // when NEXT_PUBLIC_APP_URL is unset at pair time — the instance
  // is created and the row is saved, but Evolution is never told
  // where to POST events, so the inbox stays silent. Setting the
  // env var + restarting does NOT auto-heal: Evolution still has
  // the old (empty) webhook URL. This button calls the recovery
  // endpoint to push the current NEXT_PUBLIC_APP_URL + the
  // already-persisted secret back to Evolution.
  // ============================================================
  async function handleReregisterWebhook() {
    setReRegistering(true);
    try {
      const res = await fetch('/api/whatsapp/evolution/instance/webhook', {
        method: 'POST',
      });
      const data = (await res.json()) as
        | { webhookRegistered: true; url: string }
        | { error: string };
      if (!res.ok || 'error' in data) {
        const message =
          'error' in data
            ? data.error
            : 'Failed to re-register Evolution webhook';
        toast.error(message, { duration: 10000 });
        return;
      }
      toast.success(
        'Evolution webhook re-registered. Inbound events should resume shortly.',
        { duration: 10000 }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 're-register failed';
      toast.error(message, { duration: 10000 });
    } finally {
      setReRegistering(false);
    }
  }

  // ============================================================
  // Render
  // ============================================================

  // Already connected — show the connected view, no input.
  //
  // The `any` casts here are for the *evolution-specific*
  // columns that the shared WhatsAppConfigType doesn't expose.
  // The migration 027_evolution_provider.sql added these
  // columns to whatsapp_config but they're not in the typed
  // shape yet (that's a follow-up).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  if (existing && (existing as any).provider === 'evolution') {
    const evolutionState = (existing as any).evolution_connection_state as
      | string
      | null;
    const evolutionJid = (existing as any).evolution_connected_jid as
      | string
      | null;
    const instanceName = (existing as any).evolution_instance_name as
      | string
      | null;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return (
      <div className="space-y-6">
        <Alert className="border-emerald-700/50 bg-emerald-950/30">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-4 text-emerald-400" />
            <AlertTitle className="mb-0 text-emerald-200">
              Connected via Evolution
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground text-sm">
            {evolutionJid
              ? `Paired with ${evolutionJid}.`
              : 'Evolution instance is configured.'}{' '}
            {instanceName ? `Instance: ${instanceName}.` : ''}
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Connection status</CardTitle>
            <CardDescription className="text-muted-foreground">
              {evolutionState === 'connected'
                ? 'WhatsApp is paired and receiving events.'
                : evolutionState === 'connecting'
                  ? 'Instance is connecting. Reload in a few seconds.'
                  : evolutionState === 'disconnected'
                    ? 'Instance is currently disconnected. Refresh to see if it reconnects.'
                    : 'Connection state is unknown. Click Test to refresh.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={handleReregisterWebhook}
                disabled={reRegistering}
                className="border-border text-foreground"
              >
                {reRegistering ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {reRegistering ? 'Re-registering…' : 'Re-register webhook'}
              </Button>
              <Button
                variant="outline"
                onClick={handleDisconnect}
                className="border-red-900 text-red-400 hover:bg-red-950/40 hover:text-red-300"
              >
                <PowerOff className="size-4" />
                Disconnect Evolution
              </Button>
            </div>
            <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
              If inbound messages stopped arriving after a server move or env
              change, re-registering the webhook re-points Evolution at this
              wacrm install.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loadingExisting) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top-level error banner (only when state is 'error') */}
      {state === 'error' && errorMsg && (
        <Alert className="border-red-600/40 bg-red-950/40">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-400" />
            <div className="flex-1">
              <AlertTitle className="mb-1 text-red-200">
                Something went wrong
              </AlertTitle>
              <AlertDescription className="text-sm text-red-100/80">
                {errorMsg}
              </AlertDescription>
              <Button
                onClick={() => {
                  setErrorMsg(null);
                  // RETRY is the explicit "Try again" action;
                  // the reducer only accepts it from `error`.
                  dispatch({ type: 'RETRY' });
                }}
                size="sm"
                variant="outline"
                className="mt-3 border-red-800 text-red-200 hover:bg-red-900/30"
              >
                Try again
              </Button>
            </div>
          </div>
        </Alert>
      )}

      {/* Idle form — base URL + Create + Pair */}
      {(state === 'idle' || state === 'error') && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">
              Connect with Evolution
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Evolution is a self-hosted WhatsApp gateway. Point wacrm at your
              Evolution server, scan the QR code with your phone, and the
              integration is live.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Base URL</Label>
              <Input
                placeholder="https://evolution.example.com"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground font-mono"
              />
              <p className="text-muted-foreground text-xs leading-relaxed">
                The URL of your Evolution server. We POST to{' '}
                <code className="text-foreground">
                  {baseUrl || 'https://evolution.example.com'}/instance/create
                </code>
                . Must be reachable from this wacrm instance.
              </p>
            </div>

            <Button
              onClick={handleCreate}
              disabled={!baseUrl.trim()}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              <>
                <QrCode className="size-4" />
                Create + Pair
              </>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Pairing — QR + status */}
      {(state === 'creating' || state === 'pairing' || state === 'saving') && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground flex items-center gap-2">
                <Smartphone className="text-primary size-4" />
                Scan with your phone
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Open WhatsApp on your phone → Linked Devices → Link a Device →
                point at this code.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {qr ? (
                <div className="flex flex-col items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`data:image/png;base64,${qr}`}
                    alt="Evolution pairing QR code"
                    className="border-border size-72 rounded-lg border bg-white p-3"
                  />
                  <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <RefreshCw className="size-3 animate-spin" />
                    Refreshes automatically every {POLL_QR_MS / 1000}s
                  </p>
                </div>
              ) : (
                <div className="text-muted-foreground flex h-72 items-center justify-center">
                  <Loader2 className="size-6 animate-spin" />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">
                Connection status
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {state === 'saving'
                  ? 'Phone is paired — saving configuration…'
                  : 'Waiting for your phone to scan the QR.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="border-border bg-muted/40 rounded-lg border p-3 text-sm">
                <div className="text-muted-foreground font-mono text-xs">
                  State
                </div>
                <div className="text-foreground font-mono text-sm">
                  {status?.state ?? 'pending…'}
                </div>
              </div>
              {status?.ownerJid && (
                <div className="border-border bg-muted/40 rounded-lg border p-3 text-sm">
                  <div className="text-muted-foreground font-mono text-xs">
                    JID
                  </div>
                  <div className="text-foreground font-mono text-sm">
                    {status.ownerJid}
                  </div>
                </div>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  stopPolling();
                  // CANCEL is only legal from `pairing`; the
                  // reducer logs + no-ops from any other state
                  // (which is fine — the button isn't shown
                  // outside the pairing card anyway).
                  dispatch({ type: 'CANCEL' });
                  setCreateResp(null);
                }}
                className="border-border text-muted-foreground"
              >
                <XCircle className="size-4" />
                Cancel
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
