/**
 * Provider factory + config row shape.
 *
 * `getProvider(row, env)` returns a `WhatsAppProvider` for the row's
 * configured `provider`. The route handlers (send, webhook, config)
 * call this once per request and then dispatch through the
 * returned object. They never branch on `row.provider` directly.
 *
 * Config-row shape
 * ----------------
 * `WhatsAppConfigRow` is intentionally a structural superset of every
 * column a provider might need. The factory picks the relevant
 * fields per provider and ignores the rest. This keeps the routes
 * dumb: they just SELECT * and hand the row to the factory.
 *
 * The route decrypts `access_token` and `evolution_apikey` before
 * calling the factory — the provider must NEVER receive ciphertext.
 * Storing the decrypted value in a closure / process memory for
 * the duration of one request is fine; the value is gone the
 * moment the request ends.
 *
 * Env shape
 * ---------
 * `ProviderEnv` carries the env-derived secrets the providers
 * need. META_APP_SECRET is read here so `verifyWebhookSignature`
 * can fail closed when the env is missing. Add new fields here
 * rather than reading env deep inside providers — that way
 * the test path can pass a fully-mocked env in one place.
 *
 * Defensive default: the `provider` column was added in migration
 * 027 and is NOT NULL in production. We still accept `undefined`
 * from `DecryptedConfig` and treat it as `'meta'` so old test
 * fixtures and any stragglers from before the migration don't
 * 500. The schema's CHECK constraint will reject a missing
 * `provider` on insert, so this is a no-op in production code.
 */

import { MetaProvider, type MetaProviderConfig } from './meta'
import {
  EvolutionProvider,
  type EvolutionProviderConfig,
} from './evolution'
import type { WhatsAppProvider, WhatsAppProviderId } from './types'

/**
 * Supabase row from `whatsapp_config`. Every column the schema
 * can hold, regardless of provider — the factory picks what it
 * needs. Optional/nullable columns are typed as such; the route
 * is responsible for handling the null cases (and does — see
 * `config/route.ts` for the 200-on-missing-config behaviour).
 */
export interface WhatsAppConfigRow {
  id: string
  account_id: string
  user_id: string
  provider: WhatsAppProviderId
  // Meta-only
  phone_number_id: string | null
  waba_id: string | null
  access_token: string | null
  verify_token: string | null
  status: 'connected' | 'disconnected' | null
  connected_at: string | null
  registered_at: string | null
  // Evolution-only
  evolution_base_url: string | null
  evolution_instance_name: string | null
  evolution_apikey: string | null
  evolution_webhook_url_secret: string | null
  evolution_connection_state:
    | 'qr_pending'
    | 'connected'
    | 'disconnected'
    | 'banned'
    | 'connecting'
    | null
  evolution_connected_jid: string | null
  evolution_last_seen_at: string | null
  evolution_last_disconnect_reason: string | null
  // Timestamps
  created_at: string
  updated_at: string
}

/**
 * Env-derived secrets the providers need at runtime. The route
 * builds this from `process.env` so the providers stay testable
 * without env stubbing at the provider layer.
 */
export interface ProviderEnv {
  /** META_APP_SECRET. The Meta signature helper fails closed if
   *  this is null. */
  metaAppSecret: string | null
}

/**
 * The decrypted view of a row. The route decrypts `access_token`
 * and `evolution_apikey` and builds this; the factory then hands
 * the relevant fields to the matching provider constructor.
 *
 * Tokens MUST arrive here already decrypted. The factory does no
 * decryption of its own — keeping the encryption boundary in the
 * route layer (which is the only place that knows about both
 * the request and the env) means a future refactor (e.g. a token
 * vault) only changes one site.
 *
 * `provider` is optional so test fixtures that predate migration
 * 027 (or rows that haven't been migrated) don't crash the
 * factory. The factory defaults to `'meta'` for any missing/
 * unknown value. Real production rows will always have the
 * column set after migration 027 runs.
 */
export interface DecryptedConfig {
  provider?: WhatsAppProviderId
  accountId: string
  userId: string
  // Meta
  phoneNumberId: string | null
  accessToken: string | null
  wabaId: string | null
  // Evolution
  evolutionBaseUrl: string | null
  evolutionInstanceName: string | null
  evolutionApiKey: string | null
}

/**
 * Build a `DecryptedConfig` from a raw `WhatsAppConfigRow` and a
 * token-decryptor. Kept in this file (not in the route) so any
 * future caller — e.g. an admin CLI, a background reconciliation
 * job, a test — can build the same shape.
 */
export function decryptConfigRow(
  row: WhatsAppConfigRow,
  decrypt: (ciphertext: string) => string,
): DecryptedConfig {
  return {
    provider: row.provider,
    accountId: row.account_id,
    userId: row.user_id,
    phoneNumberId: row.phone_number_id,
    accessToken: row.access_token ? decrypt(row.access_token) : null,
    wabaId: row.waba_id,
    evolutionBaseUrl: row.evolution_base_url,
    evolutionInstanceName: row.evolution_instance_name,
    evolutionApiKey: row.evolution_apikey ? decrypt(row.evolution_apikey) : null,
  }
}

/**
 * Return a provider instance for the row's configured provider.
 * Throws on an unknown provider (which the schema's CHECK
 * constraint should make unreachable) or on a misconfigured row
 * (missing required fields for the chosen provider).
 *
 * The returned object is bound to the row's already-decrypted
 * secrets and the env. Route handlers use it for a single request
 * and discard.
 */
export function getProvider(
  config: DecryptedConfig,
  env: ProviderEnv,
): WhatsAppProvider {
  // Default to 'meta' when provider is undefined or unrecognised.
  // This handles (a) old test fixtures that predate migration 027,
  // (b) any stragglers in production pre-migration, and (c) any
  // future provider enum drift where the schema accepts a value
  // we don't yet implement — defaulting to Meta is the safest
  // fail-soft behaviour since Meta is the only provider with
  // backward-compat requirements.
  const providerId: WhatsAppProviderId = config.provider ?? 'meta'

  switch (providerId) {
    case 'meta': {
      if (!config.phoneNumberId) {
        throw new Error(
          'whatsapp_config row is provider=meta but phone_number_id is null',
        )
      }
      if (!config.accessToken) {
        throw new Error(
          'whatsapp_config row is provider=meta but access_token is null',
        )
      }
      const metaConfig: MetaProviderConfig = {
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        wabaId: config.wabaId,
      }
      void env // META_APP_SECRET is read inside verifyMetaWebhookSignature
      return new MetaProvider(metaConfig)
    }
    case 'evolution': {
      if (!config.evolutionBaseUrl) {
        throw new Error(
          'whatsapp_config row is provider=evolution but evolution_base_url is null',
        )
      }
      if (!config.evolutionInstanceName) {
        throw new Error(
          'whatsapp_config row is provider=evolution but evolution_instance_name is null',
        )
      }
      if (!config.evolutionApiKey) {
        throw new Error(
          'whatsapp_config row is provider=evolution but evolution_apikey is null',
        )
      }
      const evolutionConfig: EvolutionProviderConfig = {
        baseUrl: config.evolutionBaseUrl,
        instanceName: config.evolutionInstanceName,
        apiKey: config.evolutionApiKey,
      }
      return new EvolutionProvider(evolutionConfig)
    }
  }
}
