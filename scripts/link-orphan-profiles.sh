#!/usr/bin/env bash
# link-orphan-profiles.sh — link any profiles whose account_id is
# NULL to a freshly-created account. This is the recovery for
# the case where migration 017's backfill didn't fully run (e.g.
# a partial apply, a sign-up that happened mid-migration, or a
# row in auth.users that the backfill missed).
#
# Idempotent: only touches rows where account_id IS NULL.
#
# Usage:
#   ./scripts/link-orphan-profiles.sh [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DB_URL="${SUPABASE_DB_URL:-${DATABASE_URL:-}}"
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: neither SUPABASE_DB_URL nor DATABASE_URL is set." >&2
  echo "  export DATABASE_URL='postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres'" >&2
  exit 1
fi

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  echo "== Dry run: no SQL will be executed =="
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found. Install Postgres client tools." >&2
  exit 1
fi

# Diagnostic: list orphan profiles.
echo "=== Orphan profiles (account_id IS NULL) ==="
psql "$DB_URL" -t -A -F'|' -c "
  select p.id, p.user_id, p.email, p.full_name
  from profiles p
  where p.account_id is null
  order by p.created_at desc nulls last
  limit 20;
"

# Diagnostic: do they have any accounts at all?
echo ""
echo "=== Accounts already in this db ==="
psql "$DB_URL" -t -A -F'|' -c "
  select a.id, a.name, a.owner_user_id
  from accounts a
  order by a.created_at desc nulls last
  limit 20;
"

if [[ $DRY_RUN -eq 1 ]]; then
  echo ""
  echo "== Dry run: would now create one account per orphan profile,"
  echo "   link the profile, and propagate account_id to domain rows."
  echo "   Re-run without --dry-run to apply."
  exit 0
fi

# Fix: create one account per orphan, link the profile as 'owner',
# propagate account_id to any domain rows owned by that user_id.
#
# This mirrors migration 017's backfill exactly, scoped to the
# rows that are still NULL after that backfill ran. We do it
# per-row inside a single transaction so either everything
# links up or nothing does.
echo ""
echo "=== Linking orphan profiles... ==="
psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  r record;
  v_account_id uuid;
  v_tables text[] := array[
    'contacts','conversations','messages','broadcasts','broadcast_recipients',
    'automations','flows','flow_steps','pipelines','pipeline_stages','deals',
    'tags','contact_tags','message_templates','templates','notes',
    'whatsapp_config','invitations','sessions','api_keys',
    'member_presence','custom_field_defs'
  ];
  v_table text;
  v_propagated int := 0;
  v_accounts_created int := 0;
BEGIN
  FOR r IN
    SELECT p.id AS profile_id, p.user_id, p.email, p.full_name
    FROM profiles p
    WHERE p.account_id IS NULL
  LOOP
    -- (1) Create an account for them, named after the profile.
    INSERT INTO accounts (name, owner_user_id)
    VALUES (
      COALESCE(NULLIF(r.full_name, ''), r.email, 'My account'),
      r.user_id
    )
    RETURNING id INTO v_account_id;
    v_accounts_created := v_accounts_created + 1;
    RAISE NOTICE 'Created account % for user %', v_account_id, r.user_id;

    -- (2) Link the profile as 'owner'.
    UPDATE profiles
    SET account_id = v_account_id, account_role = 'owner'
    WHERE id = r.profile_id;

    -- (3) Propagate account_id to any domain tables that have
    -- a user_id column referencing the same auth.users row.
    FOREACH v_table IN ARRAY v_tables LOOP
      BEGIN
        EXECUTE format(
          'UPDATE %I SET account_id = $1 WHERE user_id = $2 AND account_id IS NULL',
          v_table
        )
        USING v_account_id, r.user_id;
      EXCEPTION WHEN undefined_column THEN
        -- table doesn't have user_id (or no account_id column) — skip.
        NULL;
      WHEN undefined_table THEN
        NULL;
      END;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Done. Created % account(s).', v_accounts_created;
END $$;
SQL

# Tell PostgREST to refresh its schema cache.
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "NOTIFY pgrst, 'reload schema';" >/dev/null 2>&1 || true

echo ""
echo "Done. PostgREST schema cache notified. Restart the dev server (npm run dev)"
echo "and refresh the browser. The Evolution card should now be functional."
