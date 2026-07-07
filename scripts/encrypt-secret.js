// One-off: encrypts a plaintext secret with ENCRYPTION_KEY and prints the
// GCM ciphertext in the same format wacrm stores in
// whatsapp_config.evolution_webhook_url_secret.
//
// Usage:
//   ENCRYPTION_KEY=... PLAINTEXT=foo node scripts/encrypt-secret.js
//
// Reads .env.local automatically if ENCRYPTION_KEY is not set in the env.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

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

function main() {
  loadEnvLocal()
  const key = process.env.ENCRYPTION_KEY
  if (!key) {
    console.error('ENCRYPTION_KEY not set (either export it or add to .env.local)')
    process.exit(1)
  }
  const plaintext = process.env.PLAINTEXT
  if (!plaintext) {
    console.error('PLAINTEXT env var is required (the secret to encrypt)')
    process.exit(1)
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv)
  let ct = cipher.update(plaintext, 'utf8', 'hex')
  ct += cipher.final('hex')
  const tag = cipher.getAuthTag()
  const ciphertext = iv.toString('hex') + ':' + ct + ':' + tag.toString('hex')
  console.log(ciphertext)
}

main()
