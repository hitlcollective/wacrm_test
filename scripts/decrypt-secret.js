// One-off: decrypts a GCM ciphertext with ENCRYPTION_KEY and prints
// the plaintext. Inverse of scripts/encrypt-secret.js.

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
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}

loadEnvLocal()
const key = process.env.ENCRYPTION_KEY
const input = process.env.CIPHERTEXT
if (!key || !input) {
  console.error('Set ENCRYPTION_KEY (auto-loaded from .env.local) and CIPHERTEXT')
  process.exit(1)
}
const parts = input.split(':')
const iv = Buffer.from(parts[0], 'hex')
const tag = Buffer.from(parts[2], 'hex')
const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv)
decipher.setAuthTag(tag)
let pt = decipher.update(parts[1], 'hex', 'utf8')
pt += decipher.final('utf8')
console.log(pt)
