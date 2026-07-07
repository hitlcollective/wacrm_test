import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  EvolutionLifecycleClient,
  EvolutionLifecycleError,
} from '@/lib/whatsapp/evolution/instance-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import crypto from 'crypto'

/**
 * POST /api/whatsapp/evolution/instance
 *
 * Creates a new Evolution instance for the caller's account,
 * registers the wacrm inbound webhook URL with Evolution, AND
 * upserts the whatsapp_config row so that the subsequent
 * /qr and /status polls have a config to read from.
 *
 * Why we persist here (not in /api/whatsapp/config): the
 * polling routes (qr + status) look up the config by
 * account_id and return 404 if no row exists. The previous
 * design deferred the save to a later step, which left the
 * UI in a permanent 404 loop until the phone was paired.
 * Saving here unblocks the polling immediately.
 *
 * Schema note: whatsapp_config still has `user_id NOT NULL`
 * and `access_token NOT NULL` (both legacy from migration 001).
 * The multi-tenant column is `account_id` (added in 017).
 * Evolution rows set:
 *   - user_id: same as the connecting user (RLS requirement)
 *   - account_id: the new multi-tenant key
 *   - access_token: empty string (the column is NOT NULL but
 *     meaningless for Evolution rows — the per-instance key
 *     is in `evolution_apikey`)
 *   - phone_number_id: NULL (nullable since migration 027)
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

/**
 * Upsert the Evolution config onto whatsapp_config.
 * The apikey and webhook secret are stored encrypted via
 * the shared encryption helper (matches the Meta path).
 */
async function persistEvolutionConfig(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  accountId: string,
  baseUrl: string,
  instanceName: string,
  apikey: string,
  webhookSecret: string,
): Promise<{ ok: boolean; error?: string }> {
  let encryptedApikey: string
  let encryptedSecret: string
  try {
    encryptedApikey = encrypt(apikey)
    encryptedSecret = encrypt(webhookSecret)
  } catch (e) {
    return {
      ok: false,
      error: `encryption failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // Read existing row to decide insert vs update.
  const { data: existing } = await supabase
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .maybeSingle()

  // `evolution_connection_state` is the rich 5-value Evolution
  // state machine (qr_pending / connecting / connected /
  // disconnected / banned). The legacy top-level `status`
  // column is binary ('connected' | 'disconnected') — its
  // CHECK constraint rejects anything else. Until /status is
  // polled and Evolution reports `state === 'open'`, the
  // binary is 'disconnected'.
  const patch = {
    provider: 'evolution',
    evolution_base_url: baseUrl,
    evolution_instance_name: instanceName,
    evolution_apikey: encryptedApikey,
    evolution_webhook_url_secret: encryptedSecret,
    evolution_connection_state: 'connecting',
    status: 'disconnected',
    updated_at: new Date().toISOString(),
  }

  const { error } = existing
    ? await supabase
        .from('whatsapp_config')
        .update(patch)
        .eq('account_id', accountId)
    : await supabase.from('whatsapp_config').insert({
        // Legacy NOT NULL columns (kept for backward compat with
        // the RLS policy `auth.uid() = user_id`).
        user_id: userId,
        access_token: '', // NOT NULL but meaningless for Evolution
        // New multi-tenant key (017).
        account_id: accountId,
        // phone_number_id is nullable since migration 027.
        ...patch,
      })

  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true }
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

    // Fail fast: if the lifecycle client could not extract an
    // apikey from the Evolution response, the UI will only
    // discover the problem three minutes later when the status
    // poll flips to 'open' and /api/whatsapp/config rejects the
    // empty apikey. Better to surface the error NOW, at Connect
    // time, so the operator can debug without scanning a QR
    // first. The lifecycle client already logs a diagnostic
    // line on the server side — the operator should look in
    // the dev-server terminal for "could not find an apikey".
    if (!created.apikey) {
      console.error(
        '[evolution/instance POST] Evolution returned no apikey. ' +
          'instanceName=' +
          created.instanceName,
      )
      // Delete the half-created instance so it doesn't sit
      // around as an orphan on the Evolution server.
      try {
        await client.deleteInstance(created.instanceName)
      } catch (cleanupErr) {
        console.warn(
          '[evolution/instance POST] cleanup delete failed:',
          cleanupErr,
        )
      }
      return NextResponse.json(
        {
          error:
            'Evolution did not return an apikey for the new instance. ' +
            'Check the wacrm server logs (search for "could not find an apikey") ' +
            'for the response shape — your Evolution version may need a newer wacrm release.',
        },
        { status: 502 },
      )
    }

    // Register the inbound webhook URL. The path uses a per-account
    // secret that we mint and persist; the inbound route checks
    // `?secret=…` against this. The secret is stored encrypted
    // alongside the apikey.
    const webhookSecret = crypto.randomBytes(24).toString('base64url')
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? ''
    // The secret MUST be in the URL — the wacrm inbound route
    // (`/api/whatsapp/evolution/webhook/route.ts`) reads
    // `?secret=…` and compares it (constant-time) against the
    // encrypted value on the matching whatsapp_config row.
    // Without it, Evolution's POSTs land in wacrm with no
    // auth and the route returns 401 to every event.
    const webhookUrl = origin
      ? `${origin.replace(/\/$/, '')}/api/whatsapp/evolution/webhook?secret=${webhookSecret}`
      : ''

    let webhookRegistered = false
    if (webhookUrl) {
      try {
        await client.registerWebhook({
          instanceName: created.instanceName,
          url: webhookUrl,
          secret: webhookSecret,
        })
        webhookRegistered = true
      } catch (err) {
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
        // Non-fatal — continue and persist config; the UI will
        // surface a warning so the operator can re-register.
      }
    }

    // Persist the config to whatsapp_config so the polling
    // routes (/qr, /status) can find it.
    const persistResult = await persistEvolutionConfig(
      supabase,
      user.id,
      accountId,
      baseUrl,
      created.instanceName,
      created.apikey,
      webhookSecret,
    )
    if (!persistResult.ok) {
      console.error(
        '[evolution/instance POST] failed to persist config:',
        persistResult.error,
      )
      return NextResponse.json(
        {
          error: `Instance was created on Evolution, but wacrm could not save the config: ${persistResult.error}. The instance is still active on Evolution — re-save the configuration in Settings to retry.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      instanceName: created.instanceName,
      apikey: created.apikey,
      webhookSecret,
      baseUrl,
      webhookRegistered,
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
