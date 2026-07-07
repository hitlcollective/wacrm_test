// One-off: updates whatsapp_config.evolution_webhook_url_secret for the
// Evolution provider row. Uses the service-role key from .env.local.
//
// Usage:
//   EVOLUTION_WEBHOOK_CIPHERTEXT=... node scripts/update-webhook-secret.js

const fs = require('fs')
const path = require('path')

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (!fs.existsSync(envPath)) return
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (!m) continue
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2]
    }
  }
}

async function main() {
  loadEnvLocal()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const ciphertext = process.env.EVOLUTION_WEBHOOK_CIPHERTEXT

  if (!url || !serviceKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(1)
  }
  if (!ciphertext) {
    console.error('Missing EVOLUTION_WEBHOOK_CIPHERTEXT env var')
    process.exit(1)
  }

  // Use the fetch-based REST API directly so we don't have to install
  // supabase-js as a dependency of this one-off script. Same auth
  // (service-role key in the Authorization header) bypasses RLS.
  const body = JSON.stringify({ evolution_webhook_url_secret: ciphertext })
  const res = await fetch(
    url + '/rest/v1/whatsapp_config?provider=eq.evolution',
    {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body,
    }
  )

  const text = await res.text()
  if (!res.ok) {
    console.error('Update failed:', res.status, text)
    process.exit(1)
  }
  console.log('OK, updated', JSON.parse(text).length, 'row(s)')
  const rows = JSON.parse(text)
  for (const r of rows) {
    console.log('  account_id =', r.account_id, ' instance =', r.evolution_instance_name)
  }
}

main().catch((e) => {
  console.error('Error:', e)
  process.exit(1)
})
