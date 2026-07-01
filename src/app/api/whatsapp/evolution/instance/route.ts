import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  EvolutionLifecycleClient,
  EvolutionLifecycleError,
} from '@/lib/whatsapp/evolution/instance-client'
import crypto from 'crypto'

/**
 * POST /api/whatsapp/evolution/instance
 *
 * Creates a new Evolution instance for the caller's account and
 * registers the wacrm inbound webhook URL with Evolution. The
 * response carries the per-instance apikey; the UI then persists
 * it via /api/whatsapp/config (provider=evolution).
 *
 * Why a separate config step: storing the apikey on the
 * whatsapp_config row is the source of truth, and the same
 * upsert path is shared with Meta. Keeps the contract uniform.
 *
 * Why register the webhook here (not in the config route): the
 * webhook URL needs the apikey for the webhook secret lookup,
 * and the apikey is the thing the user is in the middle of
 * creating. Bundling the two keeps the UI flow to a single
 * "Create + Pair" click.
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

export async function POST(request: Request) {
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

    const body = (await request.json().catch(() => ({}))) as {
      baseUrl?: string
      number?: string
    }
    const baseUrl = (body.baseUrl ?? process.env.EVOLUTION_DEFAULT_BASE_URL ?? '').trim()
    if (!baseUrl) {
      return NextResponse.json(
        { error: 'baseUrl is required (or set EVOLUTION_DEFAULT_BASE_URL).' },
        { status: 400 },
      )
    }

    const globalApiKey = process.env.EVOLUTION_GLOBAL_APIKEY
    if (!globalApiKey) {
      console.error('EVOLUTION_GLOBAL_APIKEY is not set on the server.')
      return NextResponse.json(
        { error: 'Evolution is not configured on this server.' },
        { status: 503 },
      )
    }

    const client = new EvolutionLifecycleClient({ baseUrl, globalApiKey })
    let created
    try {
      created = await client.createInstance({
        ...(body.number ? { number: body.number } : {}),
      })
    } catch (err) {
      const message =
        err instanceof EvolutionLifecycleError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to create Evolution instance'
      console.error('[evolution/instance POST] create failed:', message)
      return NextResponse.json({ error: message }, { status: 502 })
    }

    // Register the inbound webhook URL. The path uses a per-account
    // secret that we mint and persist; the inbound route checks
    // `?secret=…` against this. The secret is stored encrypted
    // alongside the apikey.
    const webhookSecret = crypto.randomBytes(24).toString('base64url')
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? ''
    const webhookUrl = origin
      ? `${origin.replace(/\/$/, '')}/api/whatsapp/evolution/webhook`
      : ''

    if (webhookUrl) {
      try {
        await client.registerWebhook({
          instanceName: created.instanceName,
          url: webhookUrl,
          secret: webhookSecret,
        })
      } catch (err) {
        // Non-fatal — the instance was created, the user can pair
        // the phone, and wacrm will just not receive events until
        // the webhook is re-registered. Surface the failure so the
        // UI can call it out.
        const message =
          err instanceof EvolutionLifecycleError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'webhook registration failed'
        console.warn(
          '[evolution/instance POST] webhook register failed:',
          message,
        )
        return NextResponse.json({
          instanceName: created.instanceName,
          apikey: created.apikey,
          webhookSecret,
          baseUrl,
          webhookRegistered: false,
          warning: `Instance created but webhook could not be registered: ${message}. Re-save the configuration after the operator checks the Evolution server URL.`,
        })
      }
    }

    return NextResponse.json({
      instanceName: created.instanceName,
      apikey: created.apikey,
      webhookSecret,
      baseUrl,
      webhookRegistered: Boolean(webhookUrl),
    })
  } catch (err) {
    console.error('evolution/instance POST unexpected error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

/**
 * DELETE /api/whatsapp/evolution/instance
 *
 * Removes the Evolution instance for the caller's account. The
 * route looks up the stored base URL + instance name, asks
 * Evolution to delete the instance, and clears the evolution_*
 * columns on the whatsapp_config row (so the next "Connect"
 * starts fresh). Errors from Evolution are reported back but
 * still clear the local row — the operator is in a recovery
 * posture and needs the local state reset.
 */
export async function DELETE() {
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
        'id, evolution_base_url, evolution_instance_name, evolution_apikey, evolution_webhook_url_secret, provider',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error(
        '[evolution/instance DELETE] failed to read config:',
        configError,
      )
      return NextResponse.json(
        { error: 'Failed to read configuration' },
        { status: 500 },
      )
    }

    if (!config || config.provider !== 'evolution') {
      return NextResponse.json(
        { error: 'No Evolution instance to disconnect.' },
        { status: 404 },
      )
    }

    const baseUrl = config.evolution_base_url
    const instanceName = config.evolution_instance_name
    const globalApiKey = process.env.EVOLUTION_GLOBAL_APIKEY

    let deleteWarning: string | null = null
    if (baseUrl && instanceName && globalApiKey) {
      const client = new EvolutionLifecycleClient({ baseUrl, globalApiKey })
      try {
        await client.deleteInstance(instanceName)
      } catch (err) {
        const message =
          err instanceof EvolutionLifecycleError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'delete failed'
        console.warn(
          '[evolution/instance DELETE] Evolution delete failed:',
          message,
        )
        deleteWarning = `Evolution rejected the disconnect request: ${message}. Local state has been reset.`
      }
    }

    // Clear the evolution_* columns on the row. We keep the row
    // itself (account_id is the tenancy key) so the user can
    // reconnect without recreating it.
    const { error: updateError } = await supabase
      .from('whatsapp_config')
      .update({
        provider: 'meta',
        evolution_base_url: null,
        evolution_instance_name: null,
        evolution_apikey: null,
        evolution_webhook_url_secret: null,
        evolution_connection_state: null,
        evolution_connected_jid: null,
        evolution_last_seen_at: null,
        evolution_last_disconnect_reason: null,
        status: 'disconnected',
        connected_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)

    if (updateError) {
      console.error(
        '[evolution/instance DELETE] failed to clear row:',
        updateError,
      )
      return NextResponse.json(
        { error: 'Failed to reset configuration' },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      ...(deleteWarning ? { warning: deleteWarning } : {}),
    })
  } catch (err) {
    console.error('evolution/instance DELETE unexpected error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
