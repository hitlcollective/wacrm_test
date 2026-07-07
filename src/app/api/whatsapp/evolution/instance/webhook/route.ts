import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  EvolutionLifecycleClient,
  EvolutionLifecycleError,
} from '@/lib/whatsapp/evolution/instance-client'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * POST /api/whatsapp/evolution/instance/webhook
 *
 * Re-registers the inbound webhook URL on the caller's existing
 * Evolution instance. This is the recovery path for the silent-skip
 * case in `/api/whatsapp/evolution/instance` POST: when
 * `NEXT_PUBLIC_APP_URL` was empty at original pair time, the
 * instance was created on Evolution and the row was persisted, but
 * the `webhook/set` call was skipped (no URL to register). The
 * customer sees "Connected" in the UI but Evolution never POSTs
 * anything to us, so the inbox is silent.
 *
 * The fix is to call this route AFTER setting `NEXT_PUBLIC_APP_URL`
 * (and restarting the server). The route:
 *   1. Loads the encrypted `evolution_webhook_url_secret` from the
 *      row, decrypts it, and re-uses the same secret — rotating
 *      here would break the inbound route's check until the next
 *      pair, which is a worse failure mode than re-registering
 *      with the existing secret.
 *   2. Reconstructs the URL from `NEXT_PUBLIC_APP_URL` + the
 *      standard path + the decrypted secret.
 *   3. Calls Evolution's `POST /webhook/set/{name}` with the
 *      default event list (MESSAGES_UPSERT, MESSAGES_UPDATE,
 *      CONNECTION_UPDATE) and `webhook_by_events: false`.
 *
 * We deliberately do NOT touch the row. The row is already
 * consistent — the problem was purely on the Evolution side, so
 * the fix is purely on the Evolution side. A successful response
 * here is sufficient evidence that inbound is wired up.
 *
 * Response shape (200):
 *   { webhookRegistered: true, url: string }
 *
 * Error model matches `instance/route.ts` and `qr/route.ts`:
 *   401 — unauth
 *   403 — no account
 *   404 — no Evolution instance for this account
 *   409 — incomplete config (apikey / base URL / instance name missing)
 *   422 — `NEXT_PUBLIC_APP_URL` is unset on the server
 *   500 — stored secret could not be decrypted
 *   502 — Evolution rejected the call
 *   503 — `EVOLUTION_GLOBAL_APIKEY` env var is unset
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

export async function POST() {
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
      .select(
        'id, provider, evolution_base_url, evolution_instance_name, evolution_apikey, evolution_webhook_url_secret',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error(
        '[evolution/instance/webhook POST] failed to read config:',
        configError,
      )
      return NextResponse.json(
        { error: 'Failed to read configuration' },
        { status: 500 },
      )
    }

    if (!config || config.provider !== 'evolution') {
      return NextResponse.json(
        { error: 'No Evolution instance to register a webhook for.' },
        { status: 404 },
      )
    }

    const baseUrl = config.evolution_base_url
    const instanceName = config.evolution_instance_name
    const encryptedSecret = config.evolution_webhook_url_secret
    if (!baseUrl || !instanceName || !encryptedSecret) {
      return NextResponse.json(
        { error: 'Evolution configuration is incomplete.' },
        { status: 409 },
      )
    }

    const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? ''
    if (!origin) {
      return NextResponse.json(
        {
          error:
            'NEXT_PUBLIC_APP_URL is not set on the server. Set it to the public URL of this wacrm install and restart, then try again.',
        },
        { status: 422 },
      )
    }

    let secret: string
    try {
      secret = decrypt(encryptedSecret)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'unknown decryption error'
      console.error(
        '[evolution/instance/webhook POST] failed to decrypt stored webhook secret:',
        message,
      )
      return NextResponse.json(
        {
          error:
            'Stored webhook secret could not be decrypted. Check that ENCRYPTION_KEY matches the value used at original pair time.',
        },
        { status: 500 },
      )
    }

    const globalApiKey = process.env.EVOLUTION_GLOBAL_APIKEY
    if (!globalApiKey) {
      console.error(
        'EVOLUTION_GLOBAL_APIKEY is not set on the server.',
      )
      return NextResponse.json(
        { error: 'Evolution is not configured on this server.' },
        { status: 503 },
      )
    }

    const webhookUrl = `${origin}/api/whatsapp/evolution/webhook?secret=${encodeURIComponent(secret)}`
    const client = new EvolutionLifecycleClient({ baseUrl, globalApiKey })
    try {
      await client.registerWebhook({
        instanceName,
        url: webhookUrl,
        secret,
      })
    } catch (err) {
      const message =
        err instanceof EvolutionLifecycleError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'webhook registration failed'
      console.warn(
        '[evolution/instance/webhook POST] registerWebhook failed:',
        message,
      )
      return NextResponse.json(
        { error: `Evolution rejected the webhook registration: ${message}` },
        { status: 502 },
      )
    }

    return NextResponse.json({ webhookRegistered: true, url: webhookUrl })
  } catch (err) {
    console.error('evolution/instance/webhook POST unexpected error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
