#!/usr/bin/env bash
# show-gap.sh — diagnose which migrations the database is missing.
#
# Reads the supabase/migrations/ directory, queries the connected
# database for the public._wacrm_migrations ledger, and prints a
# clear list of which migrations are still missing.
#
# Run from the project root:
#   export DATABASE_URL='postgresql://...'
#   ./scripts/show-gap.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$ROOT_DIR/supabase/migrations"

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found. Install Postgres client tools." >&2
  exit 1
fi

DB_URL="${SUPABASE_DB_URL:-${DATABASE_URL:-}}"
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: neither SUPABASE_DB_URL nor DATABASE_URL is set." >&2
  echo "  export DATABASE_URL='postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres'" >&2
  exit 1
fi

# Ensure the ledger exists.
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
CREATE TABLE IF NOT EXISTS public._wacrm_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

APPLIED=$(psql "$DB_URL" -t -A -c "select name from public._wacrm_migrations order by name;")

mapfile -t ALL < <(cd "$MIGRATIONS_DIR" && ls -1 *.sql | sort)

printf "\n%-40s %-10s\n" "Migration" "Status"
printf "%-40s %-10s\n" "----------------------------------------" "----------"

PENDING_COUNT=0
for f in "${ALL[@]}"; do
  if echo "$APPLIED" | grep -qx "$f"; then
    printf "%-40s %-10s\n" "$f" "applied"
  else
    printf "%-40s %-10s\n" "$f" "PENDING"
    PENDING_COUNT=$((PENDING_COUNT + 1))
  fi
done

echo ""
if [[ $PENDING_COUNT -eq 0 ]]; then
  echo "✅ All migrations applied."
else
  echo "⚠ $PENDING_COUNT migration(s) pending. Apply with:"
  echo "    ./scripts/apply-pending-migrations.sh"
  echo "  Or run the bundled SQL files in Supabase SQL Editor:"
  echo "    scripts/pending-012-to-017.sql   (current gap)"
  echo "    scripts/pending-018-to-026.sql"
  echo "    scripts/pending-001-to-016.sql  (full reset, only if no migrations applied)"
fi
