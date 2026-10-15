#!/usr/bin/env bash
# Supabase migration history + push, against the local rehearsal DB or prod.
#
#   bash scripts/db/migrate.sh <local|prod> baseline <versions-file>   # mark versions as applied
#   bash scripts/db/migrate.sh <local|prod> revert <version>           # drop a stray history row
#   bash scripts/db/migrate.sh <local|prod> list                       # local vs remote history
#   bash scripts/db/migrate.sh <local|prod> dry-run                    # what push would apply
#   bash scripts/db/migrate.sh <local|prod> push                       # apply pending migrations
#
# The connection string is built from .env (prod) or HT's backend .env
# (local) and never printed. Always: backup (db-dump.sh) → rehearse on local →
# dry-run on prod → push on prod.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TARGET="${1:?local|prod}"; CMD="${2:?baseline|revert|list|dry-run|push}"

enc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }

case "$TARGET" in
  prod)
    source "$HERE/_conn.sh"
    DB_URL="postgresql://$(enc "$PGUSER"):$(enc "$PGPASSWORD")@$PGHOST:$PGPORT/$PGDATABASE?sslmode=require"
    ;;
  local)
    url="$(grep -E '^DATABASE_URL=' "$ROOT/../HT/backend/apps/backend/.env" | head -1 | cut -d= -f2-)"
    [[ "$url" =~ ^postgres(ql)?://([^:]+):([^@]*)@(localhost|127\.0\.0\.1)(:([0-9]+))?/ ]] || { echo "local DATABASE_URL is not localhost" >&2; exit 2; }
    DB_URL="postgresql://$(enc "${BASH_REMATCH[2]}"):$(enc "${BASH_REMATCH[3]}")@localhost:${BASH_REMATCH[6]:-5432}/accounted_upgrade_test?sslmode=disable"
    ;;
  *) echo "target must be local or prod" >&2; exit 2;;
esac

sb() { (cd "$ROOT" && npx --yes supabase@2.120.0 "$@" --db-url "$DB_URL"); }

case "$CMD" in
  baseline)
    FILE="${3:?versions file}"
    # Batches keep the command line short; repair is idempotent.
    xargs -n 100 < "$FILE" | while read -r batch; do sb migration repair --status applied $batch; done
    ;;
  revert)   sb migration repair --status reverted "${3:?version}" ;;
  list)     sb migration list ;;
  dry-run)  sb db push --include-all --dry-run ;;
  push)     echo y | sb db push --include-all ;;
  *) echo "unknown command $CMD" >&2; exit 2;;
esac
