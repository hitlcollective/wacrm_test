import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  EvolutionLifecycleClient,
  EvolutionLifecycleError,
} from '@/lib/whatsapp/evolution/instance-client'

/**
 * GET /api/whatsapp/evolution/instance/qr
 *
 * Returns the current QR code for the caller's Evolution instance.
 * Called by the Settings card while the QR is being shown to the
 * user; the UI re-fetches every ~5s (the code rotates while it's
 * unpaired) and stops once the connection state is `open`.
 *
 * Response shape (200):
 *   { pairingCode: string | null, count?: number, state?: string }
 *
 * `pairingCode` is the base64 PNG. Render it directly in an <img>
 * via `data:image/png;base64,…`. The route returns 404 if the
 * caller's account has no Evolution instance, 502 if Evolution
 * is reachable but the instance doesn't exist (a leftover row
 * from a half-completed disconnect), and 503 if the global
 * apikey env var is unset.
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
      console.error('[evolution/qr GET] failed to read config:', configError)
      return NextResponse.json(
        { error: 'Failed to read configuration' },
        { status: 500 },
      )
    }

    if (!config || config.provider !== 'evolution') {
      return NextResponse.json(
        { error: 'No Evolution instance to fetch a QR for.' },
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
    try {
      const qr = await client.getQr(instanceName)
      return NextResponse.json({
        pairingCode: qr.pairingCode ?? qr.base64 ?? null,
        count: qr.count,
      })
    } catch (err) {
      if (err instanceof EvolutionLifecycleError) {
        // 404 from Evolution means the instance is gone (operator
        // deleted it on the Evolution side). Surface as 502 so the
        // UI can show "instance missing — disconnect to clean up".
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
      console.error('[evolution/qr GET] unexpected error:', message)
      return NextResponse.json(
        { error: `Failed to fetch QR: ${message}` },
        { status: 502 },
      )
    }
  } catch (err) {
    console.error('evolution/qr GET unexpected error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
