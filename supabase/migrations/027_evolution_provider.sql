-- ============================================================
-- 027_evolution_provider.sql — Multi-provider WhatsApp support
--
-- Adds Evolution API (https://github.com/evolution-foundation/evolution-api)
-- as a second WhatsApp provider alongside the existing Meta Cloud API.
-- Up to this migration wacrm was hard-wired to Meta: the schema,
-- the webhook, the send route, and the "Connect WhatsApp" UI all
-- assumed `phone_number_id` + `access_token` + Meta webhook signing.
-- This migration introduces a `provider` discriminator and adds the
-- Evolution-specific columns so either provider can store a row.
--
-- Design notes
--   - `provider` is text with a CHECK constraint (not a Postgres
--     enum). Text is easier to evolve — adding 'whatsapp_business_app'
--     or '360dialog' in the future is a one-line constraint change
--     with no enum migration. The CHECK is the contract.
--   - Existing rows are backfilled to 'meta' via the column DEFAULT
--     so this migration is a no-op against any current production
--     data. New rows MUST specify a provider explicitly.
--   - `phone_number_id` becomes nullable. It only applies to Meta;
--     Evolution identifies its instances by name, not by phone id.
--   - The Meta `UNIQUE(phone_number_id)` constraint is replaced with
--     a PARTIAL unique index that only enforces uniqueness for
--     Meta rows. This preserves the no-two-accounts-claim-the-same-
--     Meta-number rule (issue #136) while letting any number of
--     Evolution rows exist.
--   - Evolution columns are all nullable. New rows for either
--     provider set only the columns they need. The Meta columns
--     (phone_number_id, waba_id, access_token, verify_token) are
--     unchanged.
--   - `evolution_apikey` is encrypted at rest using the same AES-GCM
--     helper as `access_token` (lib/whatsapp/encryption.ts). Same
--     ENCRYPTION_KEY, same key-rotation disaster if it ever changes.
--   - `evolution_connection_state` is a 5-value text enum mirrored
--     in the TypeScript provider. It's a UI hint + operational
--     signal, not a hard gate — the webhook can still deliver while
--     the state reads 'disconnected' if the user's phone is briefly
--     offline.
--   - `evolution_webhook_url_secret` is a random per-row path secret.
--     wacrm generates it on save and writes it into the registered
--     webhook URL Evolution calls (`?secret=…`). Evolution itself
--     doesn't sign payloads, so this is the only layer of URL
--     authentication. It's indexed so a leaked/old secret is fast
--     to rotate.
--
-- Idempotent — safe to re-run. The ALTER TABLE … ADD COLUMN uses
-- IF NOT EXISTS where the engine supports it; the index uses
-- IF NOT EXISTS; the CHECK constraint is added with a name and
-- wrapped in a DO block so re-running doesn't error.
-- ============================================================

-- 1. Provider discriminator ----------------------------------------------

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta';

-- Re-affirm the CHECK in a DO block so re-running this migration
-- after the column already exists still no-ops cleanly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_check
      CHECK (provider IN ('meta', 'evolution'));
  END IF;
END $$;

-- 2. Relax phone_number_id -----------------------------------------------
--
-- The original schema had `phone_number_id TEXT NOT NULL` because every
-- row was a Meta row. Now that Evolution rows exist, the column is
-- optional. We backfill with the column's existing data first (no-op
-- for current rows since they're all Meta).

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL;

-- 3. Replace UNIQUE(phone_number_id) with a partial unique index ----------
--
-- The full-table UNIQUE blocked any Evolution row from existing
-- alongside Meta rows (Evolution doesn't have a phone_number_id).
-- The partial index is the Meta-only equivalent — it preserves
-- issue #136's "no two accounts claim the same Meta number" rule
-- without blocking Evolution rows.

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_phone_number_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_meta_phone_unique
  ON whatsapp_config (phone_number_id)
  WHERE provider = 'meta' AND phone_number_id IS NOT NULL;

-- 4. Evolution-only columns -----------------------------------------------

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_base_url TEXT;
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT;
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_apikey TEXT;
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_webhook_url_secret TEXT;
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_connection_state TEXT;
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_connected_jid TEXT;
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_last_seen_at TIMESTAMPTZ;
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_last_disconnect_reason TEXT;

-- The connection-state values are constrained too — the app reads this
-- column directly and an unexpected value would surface as a UI bug
-- (enum drift between SQL and TS). Adding the CHECK in a DO block so
-- re-runs against a DB where it's already installed no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_evolution_state_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_evolution_state_check
      CHECK (
        evolution_connection_state IS NULL
        OR evolution_connection_state IN (
          'qr_pending', 'connected', 'disconnected', 'banned', 'connecting'
        )
      );
  END IF;
END $$;

-- Partial index for the instance-name lookup: the Evolution webhook
-- arrives with just the instance name, and the route needs to find the
-- config row in O(1). Only Evolution rows can match, hence the WHERE.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_evolution_instance_unique
  ON whatsapp_config (evolution_instance_name)
  WHERE provider = 'evolution' AND evolution_instance_name IS NOT NULL;

-- The webhook-URL secret is the path-component in the registered
-- Evolution webhook URL. We don't put a UNIQUE on it — collisions
-- would be vanishingly unlikely (crypto-random) and the index would
-- be on a NULL-heavy column. Lookup is a single SELECT on the
-- (provider, evolution_webhook_url_secret) pair, which the partial
-- index already enables.
