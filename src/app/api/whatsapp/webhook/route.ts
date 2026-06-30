import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import {
  getProvider,
  decryptConfigRow,
  type WhatsAppConfigRow,
} from '@/lib/whatsapp/providers'
import { MetaProvider } from '@/lib/whatsapp/providers/meta'
import { processInboundEvents } from '@/lib/whatsapp/inbound-processor'
import type { NormalisedEvent } from '@/lib/whatsapp/providers/types'

// The `after()` callback in POST runs within this route's max
// duration. Inbound processing can fan out to per-media Meta
// verification calls, so give it headroom beyond the platform
// default (Vercel clamps this to the plan's ceiling). Tune as
// needed.
export const maxDuration = 60

// Lazy-initialised service-role client. We need it for the GET
// verify-token loop and the per-phone_id config lookup in POST.
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

export const dynamic = 'force-dynamic'

// ============================================================
// GET — webhook verification (Meta `hub.mode` challenge)
// ============================================================
//
// Meta's webhook registration flow requires a GET endpoint that
// echoes back a `hub.challenge` value when the `hub.verify_token`
// matches the one we registered. The GET handler iterates every
// `whatsapp_config` row, decrypts its `verify_token`, and returns
// the challenge on the first match. Only Meta configs have a
// `verify_token` (Evolution trusts a `?secret=…` URL parameter
// instead), so a v1 Evolution row is naturally skipped.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 },
      )
    }

    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')
      .eq('provider', 'meta')
      .not('verify_token', 'is', null)

    if (configError || !configs) {
      console.error('[whatsapp/webhook GET] Error fetching configs:', configError)
      return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
    }

    let matchedConfigId: string | null = null
    let matchedToken: string | null = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfigId = config.id
          matchedToken = config.verify_token
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip and keep checking.
      }
    }

    if (matchedConfigId) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (matchedToken && isLegacyFormat(matchedToken)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfigId)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[whatsapp/webhook GET] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 },
    )
  } catch (error) {
    console.error('[whatsapp/webhook GET] Internal error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

// ============================================================
// POST — receive events
// ============================================================
//
// Flow:
//   1. Read raw body and verify the X-Hub-Signature-256 header
//      (Meta provider owns HMAC verification).
//   2. Parse via MetaProvider.parseWebhook → flat list of
//      NormalisedEvents.
//   3. Re-extract the per-change phone_number_id from the raw
//      body (it's webhook-shape metadata, not part of the
//      NormalisedEvent).
//   4. For each phone_number_id, look up the matching
//      whatsapp_config row and dispatch the events to the shared
//      processor with the right account context.
//
// The whole thing runs inside `after()` so we ack Meta within
// their ~20s timeout while still guaranteeing completion.

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  // Step 1: signature check. The provider's verifier reads
  // META_APP_SECRET from env internally, so we can use a
  // placeholder for the other config fields.
  const verifier = new MetaProvider({
    phoneNumberId: '_verifier',
    accessToken: '_unused',
  })
  if (!verifier.verifyWebhookSignature(rawBody, signature)) {
    console.warn('[whatsapp/webhook POST] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Step 2: parse. We use a placeholder access token for the
  // media-URL resolver; if the real account lookup happens after
  // this and finds a different config, the media-URL resolution
  // is the only thing that's wrong (we'll have undefined URLs for
  // that one request). On a normal happy path, the resolver
  // still hits Meta with the placeholder and fails open to
  // undefined — no different from a request that legitimately
  // had no media.
  const parser = new MetaProvider({
    phoneNumberId: '_parser',
    accessToken: '_placeholder',
  })
  const events = await parser.parseWebhook(rawBody)

  // Step 3: re-extract phone_number_ids from the raw body. The
  // NormalisedEvent shape doesn't carry the webhook-level
  // metadata, so a minimal second parse is the cleanest way to
  // get them. parseWebhook already swallowed any parse error
  // (returning []), so an exception here is genuinely impossible.
  const phoneIds: string[] = []
  try {
    const body = JSON.parse(rawBody) as {
      entry?: Array<{
        changes: Array<{
          value?: { metadata?: { phone_number_id?: string } }
        }>
      }>
    }
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const id = change.value?.metadata?.phone_number_id
        if (id) phoneIds.push(id)
      }
    }
  } catch {
    // No-op — parseWebhook already handled the error case.
  }

  // Step 4: dispatch. Wrapped in `after()` so we ack Meta within
  // their ~20s timeout regardless of how long the DB writes
  // take. See the long-standing comment block in the v0.2.0
  // version of this file for the serverless-freeze reason.
  after(async () => {
    try {
      await processEventsForAllConfigs(events, phoneIds)
    } catch (err) {
      console.error('[whatsapp/webhook POST] processing failed:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

// ============================================================
// Per-config dispatch
// ============================================================

async function processEventsForAllConfigs(
  events: NormalisedEvent[],
  phoneIds: string[],
): Promise<void> {
  // De-dupe — multiple changes can reference the same phone id
  // within a single POST (e.g. an inbound message + a status
  // update for an old send). One config lookup is enough.
  const uniquePhoneIds = Array.from(new Set(phoneIds))

  for (const phoneId of uniquePhoneIds) {
    const { data: rows, error } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('*')
      .eq('phone_number_id', phoneId)
      .eq('provider', 'meta')

    if (error) {
      console.error(
        '[whatsapp/webhook POST] config fetch error:',
        phoneId,
        error,
      )
      continue
    }
    if (!rows || rows.length === 0) {
      console.error(
        '[whatsapp/webhook POST] no config for phone_number_id:',
        phoneId,
      )
      continue
    }
    if (rows.length > 1) {
      console.error(
        `[whatsapp/webhook POST] multiple configs (${rows.length}) for phone_number_id:`,
        phoneId,
        '— inbound dropped. Resolve duplicates so each number maps to a single account.',
      )
      continue
    }

    const row = rows[0] as WhatsAppConfigRow
    const decrypted = decryptConfigRow(row, decrypt)
    if (decrypted.provider !== 'meta') {
      // Defensive: a config row with phone_number_id but
      // provider != 'meta' shouldn't exist post-migration 027
      // (the partial unique index excludes Evolution rows from
      // the phone_number_id check). If it does, skip.
      continue
    }
    await processInboundEvents(events, {
      accountId: decrypted.accountId,
      configOwnerUserId: decrypted.userId,
    })
  }
}
