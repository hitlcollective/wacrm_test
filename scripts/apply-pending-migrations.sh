#!/usr/bin/env bash
# apply-pending-migrations.sh — apply only the migrations your
# database is missing.
#
# Usage:
#   ./scripts/apply-pending-migrations.sh [--dry-run]
#
# Reads $SUPABASE_DB_URL (or $DATABASE_URL) and the migration
# list under supabase/migrations/, then for each migration whose
# name is not yet recorded in the public._migrations table, runs
# it through psql with ON_ERROR_STOP=1.
#
# Self-hosted and Supabase-CLI users can run this against their
# remote db. The script is idempotent on already-applied
# migrations because we use IF NOT EXISTS / IF EXISTS guards in
# every migration file.
#
# Why this exists: wacrm ships a long sequence of migrations
# and the "your profile is not linked" error an operator sees
# when they're missing a middle one is misleading — the page
# looks broken, the database is actually fine, only the schema
# cache is out of date. A one-shot script that applies only
# the missing gap is the fastest way to recover.

set -euo pipefail

# ---------------------------------------------------------------------------
# 1. Locate the migrations directory and psql.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$ROOT_DIR/supabase/migrations"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "ERROR: migrations directory not found at $MIGRATIONS_DIR" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found. Install Postgres client tools first:" >&2
  echo "  brew install libpq && echo 'export PATH=\"/opt/homebrew/opt/libpq/bin:\$PATH\"' >> ~/.zshrc" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Pick up the connection string.
# ---------------------------------------------------------------------------
DB_URL="${SUPABASE_DB_URL:-${DATABASE_URL:-}}"
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: neither SUPABASE_DB_URL nor DATABASE_URL is set." >&2
  echo "  export DATABASE_URL='postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres'" >&2
  echo "  (or copy the connection string from your Supabase dashboard:" >&2
  echo "   Project Settings → Database → Connection string → URI)" >&2
  exit 1
fi

# Light-touch connection check.
if ! psql "$DB_URL" -c "select 1" >/dev/null 2>&1; then
  echo "ERROR: cannot reach $DB_URL. Check the connection string." >&2
  exit 1
fi

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  echo "== Dry run: no SQL will be executed =="
fi

# ---------------------------------------------------------------------------
# 3. List migrations in order. The migration list is the source
#    of truth — we don't try to be clever about it, we just
#    run every file with a higher number than the highest
#    already-applied one. The list is globbed so a developer
#    can drop a new file in and the script picks it up.
# ---------------------------------------------------------------------------
# Ensure the public._migrations ledger exists. We use a small
# ad-hoc table rather than supabase_migrations (which is owned
# by the Supabase CLI) so this script works on plain-Postgres
# self-hosted installs too.
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
CREATE TABLE IF NOT EXISTS public._wacrm_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

APPLIED=$(psql "$DB_URL" -t -A -c "select name from public._wacrm_migrations order by name;")

# All migration files in order.
mapfile -t ALL < <(cd "$MIGRATIONS_DIR" && ls -1 *.sql | sort)

# Determine the highest-numbered already-applied migration so
# the dry-run summary is meaningful.
HIGHEST_APPLIED_NUM=0
HIGHEST_APPLIED_NAME=""
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  num=$(echo "$name" | grep -oE '^[0-9]+' || echo "0")
  if (( 10#$num > HIGHEST_APPLIED_NUM )); then
    HIGHEST_APPLIED_NUM=$((10#$num))
    HIGHEST_APPLIED_NAME="$name"
  fi
done <<< "$APPLIED"

# ---------------------------------------------------------------------------
# 4. Walk every file, run the ones we haven't seen.
# ---------------------------------------------------------------------------
COUNT_APPLIED=0
COUNT_SKIPPED=0
COUNT_FAILED=0
LAST_APPLIED=""

printf "%-50s %-10s\n" "Migration" "Status"
printf "%-50s %-10s\n" "----------------------------------------------" "----------"

for f in "${ALL[@]}"; do
  full="$MIGRATIONS_DIR/$f"
  if echo "$APPLIED" | grep -qx "$f"; then
    printf "%-50s %-10s\n" "$f" "skip"
    COUNT_SKIPPED=$((COUNT_SKIPPED + 1))
    continue
  fi

  printf "%-50s %-10s" "$f" "apply"

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "(dry-run)"
    COUNT_APPLIED=$((COUNT_APPLIED + 1))
    continue
  fi

  if psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$full" >/dev/null 2>&1; then
    psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO public._wacrm_migrations(name) VALUES ('$f');" >/dev/null
    echo "ok"
    COUNT_APPLIED=$((COUNT_APPLIED + 1))
    LAST_APPLIED="$f"
  else
    echo "FAILED"
    echo "" >&2
    echo "ERROR: $f did not apply cleanly. Re-run with the file" >&2
    echo "directly to see the error:" >&2
    echo "  psql \"\$DATABASE_URL\" -f \"$full\"" >&2
    COUNT_FAILED=$((COUNT_FAILED + 1))
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# 5. Tell PostgREST to refresh its schema cache so the next
#    request from the app sees the new columns. Supabase
#    auto-refreshes within a few seconds on hosted; for
#    self-hosted PostgREST you may need to call
#    `NOTIFY pgrst, 'reload schema'` manually.
# ---------------------------------------------------------------------------
if [[ $COUNT_APPLIED -gt 0 && $DRY_RUN -eq 0 ]]; then
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "NOTIFY pgrst, 'reload schema';" >/dev/null 2>&1 || true
  echo ""
  echo "Applied $COUNT_APPLIED migration(s); last: $LAST_APPLIED"
  echo "Notified PostgREST to reload its schema cache."
  echo "Restart the dev server (npm run dev) and refresh the browser."
else
  echo ""
  if [[ $COUNT_FAILED -eq 0 ]]; then
    echo "Database is up to date (highest applied: $(printf '%03d' "$HIGHEST_APPLIED_NUM")_$HIGHEST_APPLIED_NAME)."
  fi
fi
