#!/usr/bin/env bash
# Full backup of the production Supabase database with pg_dump (read-only).
#
#   bash scripts/db/db-dump.sh                  # → ../HT_Bok_backups/accounted-<timestamp>.dump
#   bash scripts/db/db-dump.sh <out-dir>
#   bash scripts/db/db-dump.sh --full [out-dir] # keep owners + GRANTs (for moving to another
#                                               # Supabase-shaped Postgres: RLS needs the
#                                               # anon/authenticated/service_role grants)
#
# Custom format (-Fc) so it can be restored selectively with pg_restore.
# Dumps public + storage/auth schemas the app depends on; the backup lands
# OUTSIDE the repo so it can never be committed.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_conn.sh"

FLAGS=(--no-owner --no-privileges)
SUFFIX=""
if [ "${1:-}" = "--full" ]; then
  FLAGS=()
  SUFFIX="-full"
  shift
fi

OUT_DIR="${1:-$ROOT/../HT_Bok_backups}"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/accounted-$(date +%Y%m%d-%H%M%S)$SUFFIX.dump"

export PGOPTIONS="-c default_transaction_read_only=on"
pg_dump -Fc ${FLAGS[@]+"${FLAGS[@]}"} \
  --schema=public --schema=auth --schema=storage --schema=supabase_migrations \
  -f "$OUT"

echo "Backup: $OUT ($(du -h "$OUT" | cut -f1))"
pg_restore --list "$OUT" | grep -cE " TABLE DATA " | xargs echo "Tabeller med data:"
