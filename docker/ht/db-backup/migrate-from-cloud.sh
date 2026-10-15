#!/usr/bin/env bash
# One-shot cutover job: copy the database from Supabase Cloud into the
# self-hosted Supabase Postgres, entirely inside Railway (no TCP proxy, no
# dump persisted: it lives in this ephemeral container only).
#   SRC_PGHOST SRC_PGPORT SRC_PGUSER SRC_PGPASSWORD   Supabase Cloud (read-only use)
#   PGHOST PGPORT PGPASSWORD                          target (user supabase_admin)
# Then runs supabase-restore.sh (same script as the rehearsals) and prints
# MIGRATE-OK. Storage files are copied separately (scripts/db/storage-copy.mjs).
set -euo pipefail
: "${SRC_PGHOST:?}" "${SRC_PGUSER:?}" "${SRC_PGPASSWORD:?}" "${PGHOST:?}" "${PGPASSWORD:?}"
case "$PGHOST" in *supabase.com*|*supabase.co*) echo "Mål ser ut som Supabase Cloud, avbryter"; exit 2;; esac
DUMP="$(mktemp -d)/cloud-full.dump"

echo "A. pg_dump från Supabase Cloud (skrivskyddat)"
PGHOST="$SRC_PGHOST" PGPORT="${SRC_PGPORT:-5432}" PGUSER="$SRC_PGUSER" PGPASSWORD="$SRC_PGPASSWORD" \
PGDATABASE=postgres PGSSLMODE=require PGOPTIONS="-c default_transaction_read_only=on" \
  pg_dump -Fc --schema=public --schema=auth --schema=storage --schema=supabase_migrations -f "$DUMP"
echo "   $(du -h "$DUMP" | cut -f1), $(pg_restore --list "$DUMP" | grep -c ' TABLE DATA ') tabeller"

echo "B. låser GoTrue/Storage ute (de migrerar annars mot halvfärdiga scheman)"
export PGUSER=supabase_admin PGDATABASE=postgres PGPORT="${PGPORT:-5432}" CHUNK=100000
lock() {
  psql -X -q -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE supabase_auth_admin $1" -c "ALTER ROLE supabase_storage_admin $1" \
    -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename IN ('supabase_auth_admin','supabase_storage_admin','authenticator')" >/dev/null
}
lock NOLOGIN
trap 'lock LOGIN; echo "   rollerna upplåsta"' EXIT

echo "C. återställer i mål"
bash /usr/local/bin/supabase-restore.sh "$DUMP"
echo "MIGRATE-OK"
