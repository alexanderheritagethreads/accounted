#!/usr/bin/env bash
# Shared connection setup for the read-only DB helpers. Reads the Supabase
# connection from HT_Bok/.env without printing secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 2; }

env_val() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }

REF="$(env_val SUPABASE_PROJECT_REF)"
export PGHOST="$(env_val SUPABASE_DB_HOST)"
export PGPASSWORD="$(env_val SUPABASE_DB_PASSWORD)"
export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-postgres}"
export PGSSLMODE=require
# The shared pooler needs the project ref in the user name; the direct host does not.
if [[ "$PGHOST" == *pooler.supabase.com ]]; then export PGUSER="postgres.$REF"; else export PGUSER=postgres; fi

[ -n "$PGHOST" ] && [ -n "$PGPASSWORD" ] || { echo "SUPABASE_DB_HOST / SUPABASE_DB_PASSWORD missing in .env" >&2; exit 2; }
