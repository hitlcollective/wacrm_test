import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getProvider, decryptConfigRow } from '@/lib/whatsapp/providers'
import { processInboundEvents } from '@/lib/whatsapp/inbound-processor'

/**
 * POST /api/whatsapp/evolution/webhook
 *
 * Inbound webhook for Evolution instances. Evolution is configured
 * (via the lifecycle client in `instance/route.ts`) to POST to:
 *
 *   {NEXT_PUBLIC_APP_URL}/api/whatsapp/evolution/webhook?secret=<per-account>
 *
 * The `?secret=…` value matches `whatsapp_config.evolution_webhook_url_secret`
 * (encrypted on the row). We:
 *   1. Compare secrets with `crypto.timingSafeEqual` (constant-time —
 *      string `===` leaks the secret via response-time differences).
 *   2. Read the raw body (not JSON-parsed) — the provider's
 *      `parseWebhook` operates on the unparsed string so it can
 *      reject malformed payloads cleanly.
 *   3. Build the provider via `getProvider()` and dispatch through
 *      the shared `processInboundEvents`.
 *   4. ALWAYS return 200 unless the secret is wrong. Evolution
 *      retries on non-2xx and will hammer us with the same
 *      malformed payload forever otherwise.
 *
 * Auth note: this route is unauthenticated (it's a webhook from
 * Evolution's servers, not from a browser). The secret in the URL
 * is the only auth. We use the service-role Supabase client to
 * read the config row because RLS scopes per-user, and this is a
 * server-to-server call.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

/**
 * Constant-time secret comparison. Buffers must be equal length;
 * the caller pads / shortens to match before calling.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    // Still run a compare of equal-length buffers so the failure
    // time doesn't reveal the length difference.
    crypto.timingSafeEqual(ab, ab)
    return false
  }
  return crypto.timingSafeEqual(ab, bb)
}

export async function POST(request: Request) {
  const url = new URL(request.url)
  const providedSecret = url.searchParams.get('secret') ?? ''

  if (!providedSecret) {
    return NextResponse.json({ error: 'Missing secret' }, { status: 401 })
  }

  // Read the raw body. We do NOT JSON.parse here — the provider
  // parser handles that and is responsible for distinguishing
  // malformed payloads.
  const rawBody = await request.text()

  // We don't know the account_id up front — Evolution POSTs to a
  // single configured URL. We DO know the secret is per-account,
  // so we have to look up the row that matches the secret.
  //
  // Strategy: every Evolution row has its own secret. We do a
  // service-role scan over the whatsapp_config rows where
  // provider='evolution', decrypt each, and find the match.
  // For a small tenant (handful of accounts on a single wacrm
  // install) this is fine; if the table grows large we add a
  // hashed-prefix index.
  const { data: rows, error: rowsError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select(
      'id, account_id, user_id, provider, evolution_base_url, evolution_instance_name, evolution_apikey, evolution_webhook_url_secret',
    )
    .eq('provider', 'evolution')
    .not('evolution_webhook_url_secret', 'is', null)

  if (rowsError) {
    console.error('[evolution/webhook POST] failed to scan configs:', rowsError)
    // Don't leak the error; Evolution will retry.
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  // Find the matching secret. We always check every row's secret
  // (instead of returning early on first non-match) to avoid a
  // timing oracle. `safeEqual` is constant-time per pair.
  let matchedRow: typeof rows[number] | null = null
  for (const row of rows ?? []) {
    if (!row.evolution_webhook_url_secret) continue
    let decrypted: string
    try {
      decrypted = decrypt(row.evolution_webhook_url_secret)
    } catch (err) {
      console.warn(
        '[evolution/webhook POST] failed to decrypt a row secret (skipping):',
        err,
      )
      continue
    }
    if (safeEqual(providedSecret, decrypted)) {
      matchedRow = row
      // Don't break — keep iterating to keep the loop time constant
      // regardless of where in the list the match is.
    }
  }

  if (!matchedRow) {
    console.warn(
      '[evolution/webhook POST] no whatsapp_config row matched the secret',
    )
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Build the provider from the matched row. decryptConfigRow
  // expects a partial row + a decrypt function; we already have
  // the cipher column values, so we hand them through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decrypted = decryptConfigRow(matchedRow as any, decrypt)

  // Reject rows that aren't actually configured (apikey missing).
  if (!decrypted.evolutionApiKey || !decrypted.evolutionBaseUrl || !decrypted.evolutionInstanceName) {
    console.warn(
      '[evolution/webhook POST] matched row is missing evolution config',
    )
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  const provider = getProvider(decrypted, { metaAppSecret: null })

  let events
  try {
    events = await provider.parseWebhook(rawBody)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'parse failed'
    console.error('[evolution/webhook POST] parseWebhook threw:', message)
    // 200 — malformed payload isn't worth retrying.
    return NextResponse.json({ ok: true, parseError: true }, { status: 200 })
  }

  if (events.length === 0) {
    // No events to process (the payload parsed cleanly but didn't
    // match any of the events we care about). Still 200.
    return NextResponse.json({ ok: true, processed: 0 }, { status: 200 })
  }

  try {
    await processInboundEvents(events, {
      accountId: matchedRow.account_id,
      configOwnerUserId: matchedRow.user_id,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'processing failed'
    console.error('[evolution/webhook POST] processInboundEvents threw:', message)
    // Still 200 — the per-event error isolation in
    // processInboundEvents should handle most failures, and we
    // don't want Evolution to retry a payload that already partially
    // landed.
    return NextResponse.json({ ok: true, processed: 'partial' }, { status: 200 })
  }

  return NextResponse.json({ ok: true, processed: events.length }, { status: 200 })
}
