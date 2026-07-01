import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  EvolutionLifecycleClient,
  EvolutionLifecycleError,
} from '@/lib/whatsapp/evolution/instance-client'

/**
 * GET /api/whatsapp/evolution/instance/status
 *
 * Returns the current connection state for the caller's Evolution
 * instance. Polled by the Settings card while the QR is shown
 * (every ~3s). The poll stops the moment the state is `open` —
 * the UI then persists the apikey via /api/whatsapp/config
 * (provider=evolution) and switches to the connected view.
 *
 * Response shape (200):
 *   { state: 'open' | 'close' | 'connecting' | string | null,
 *     ownerJid: string | null }
 *
 * We also write the state to the whatsapp_config row so the rest
 * of the app (e.g. the connection-status banner) can read it
 * without re-querying Evolution. This is best-effort — a failed
 * update doesn't fail the request, the next poll will retry.
 *
 * Error model matches qr/route.ts: 401 unauth, 403 no account,
 * 404 no Evolution instance, 409 incomplete config, 503 missing
 * global apikey, 502 Evolution rejected the call.
 */

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('provider, evolution_base_url, evolution_instance_name')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error(
        '[evolution/status GET] failed to read config:',
        configError,
      )
      return NextResponse.json(
        { error: 'Failed to read configuration' },
        { status: 500 },
      )
    }

    if (!config || config.provider !== 'evolution') {
      return NextResponse.json(
        { error: 'No Evolution instance to check status for.' },
        { status: 404 },
      )
    }

    const baseUrl = config.evolution_base_url
    const instanceName = config.evolution_instance_name
    if (!baseUrl || !instanceName) {
      return NextResponse.json(
        { error: 'Evolution configuration is incomplete.' },
        { status: 409 },
      )
    }

    const globalApiKey = process.env.EVOLUTION_GLOBAL_APIKEY
    if (!globalApiKey) {
      return NextResponse.json(
        { error: 'Evolution is not configured on this server.' },
        { status: 503 },
      )
    }

    const client = new EvolutionLifecycleClient({ baseUrl, globalApiKey })
    let status
    try {
      status = await client.getStatus(instanceName)
    } catch (err) {
      if (err instanceof EvolutionLifecycleError) {
        if (err.status === 404) {
          return NextResponse.json(
            { error: 'Instance not found on Evolution server.' },
            { status: 502 },
          )
        }
        return NextResponse.json(
          { error: err.message },
          { status: 502 },
        )
      }
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[evolution/status GET] unexpected error:', message)
      return NextResponse.json(
        { error: `Failed to fetch status: ${message}` },
        { status: 502 },
      )
    }

    // Best-effort persistence: write the new state so other parts
    // of the app (e.g. the connection-status banner) can see it
    // without re-querying Evolution. A failed update doesn't fail
    // the request; the next poll will retry.
    const stateForDb = status.state === 'open' ? 'connected' : status.state === 'connecting' ? 'connecting' : status.state === 'close' || status.state === 'refused' || status.state === 'disconnected' ? 'disconnected' : status.state
    const isOpen = status.state === 'open'
    try {
      await supabase
        .from('whatsapp_config')
        .update({
          evolution_connection_state: stateForDb,
          evolution_connected_jid: status.ownerJid ?? null,
          evolution_last_seen_at: isOpen ? new Date().toISOString() : null,
          status: isOpen ? 'connected' : 'disconnected',
          connected_at: isOpen ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', accountId)
    } catch (err) {
      console.warn(
        '[evolution/status GET] failed to persist state (non-fatal):',
        err,
      )
    }

    return NextResponse.json({
      state: status.state,
      ownerJid: status.ownerJid ?? null,
    })
  } catch (err) {
    console.error('evolution/status GET unexpected error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
