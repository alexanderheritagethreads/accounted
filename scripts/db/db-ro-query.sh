#!/usr/bin/env bash
# Run SQL against the production Supabase database in READ-ONLY mode.
#
#   bash scripts/db/db-ro-query.sh "select count(*) from journal_entries"
#
# Three layers keep this read-only:
#   1. default_transaction_read_only=on for the whole session (PGOPTIONS),
#   2. the SQL runs inside BEGIN READ ONLY … ROLLBACK,
#   3. statements that could leave or loosen that transaction are refused.
# Postgres itself rejects any write (ERROR: cannot execute … in a read-only
# transaction), so this is safe to allow without a prompt.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_conn.sh"

SQL="${1:-$(cat)}"
[ -n "$SQL" ] || { echo "Usage: db-ro-query.sh \"<sql>\"" >&2; exit 2; }

if echo "$SQL" | grep -qiE '\b(commit|end|rollback|abort|begin|start[[:space:]]+transaction|set|reset|savepoint|release|prepare|do|call|copy|vacuum|analyze|lock|listen|notify|discard)\b|read[[:space:]]+write'; then
  echo "Refused: only plain read queries are allowed here." >&2
  exit 3
fi

export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=60000"
psql -X -v ON_ERROR_STOP=1 -P pager=off -c "BEGIN TRANSACTION READ ONLY" -c "$SQL" -c "ROLLBACK"
