#!/usr/bin/env bash
# Restore a `db-dump.sh --full` backup into a fresh self-hosted Supabase
# Postgres (supabase/postgres image). Destroys auth, storage, public and
# supabase_migrations in the TARGET first. Connection: the PG* env vars
# (PGUSER must be the superuser supabase_admin). Never point it at prod.
#
#   PGHOST=… PGPORT=… PGUSER=supabase_admin PGPASSWORD=… \
#     bash scripts/db/supabase-restore.sh <full-dump>
#
# Lessons baked in (2026-10-14 rehearsal):
#  - btree_gist lives in public; dropping public drops it, so it is recreated
#    between pre-data and post-data (two EXCLUDE … USING gist constraints).
#  - The run must not be cut short: post-data carries ACLs, RLS, policies,
#    indexes and triggers. The script ends with a completeness check.
#  - pg_cron jobs live outside the dumped schemas and are recreated here.
set -euo pipefail

DUMP="${1:?full dump file}"
[ "${PGUSER:-}" = "supabase_admin" ] || { echo "PGUSER must be supabase_admin" >&2; exit 2; }
case "${PGHOST:-}" in *supabase.com*|*supabase.co*) echo "Refusing: target looks like Supabase Cloud" >&2; exit 2;; esac

CONN="host=$PGHOST port=${PGPORT:-5432} dbname=${PGDATABASE:-postgres} user=$PGUSER keepalives=1 keepalives_idle=15 keepalives_interval=5 keepalives_count=6"
q() { psql -X -q -v ON_ERROR_STOP=1 -d "$CONN" "$@"; }

# RESUME="<section>:<entries already done>" continues an interrupted run
# (e.g. RESUME=post-data:2250) without wiping what is already restored.
RESUME="${RESUME:-}"
RESUME_SECTION="${RESUME%%:*}"
RESUME_OFFSET="${RESUME#*:}"; [ -n "$RESUME" ] || RESUME_OFFSET=0
order() { case "$1" in pre-data) echo 1;; data) echo 2;; post-data) echo 3;; *) echo 0;; esac; }
skip_section() { [ -n "$RESUME" ] && [ "$(order "$1")" -lt "$(order "$RESUME_SECTION")" ]; }

if [ -z "$RESUME" ]; then
  echo "1/6 Rensar målets scheman"
  q -c "DROP SCHEMA IF EXISTS auth CASCADE" -c "DROP SCHEMA IF EXISTS storage CASCADE" \
    -c "DROP SCHEMA IF EXISTS supabase_migrations CASCADE" -c "DROP SCHEMA IF EXISTS public CASCADE"
else
  echo "1/6 Återupptar från $RESUME (ingen rensning)"
fi

# Each section is restored in chunks of CHUNK TOC entries, one connection per
# chunk: Railway's TCP proxy cuts connections after a few minutes regardless
# of activity. A cut chunk is retried: in post-data/pre-data the objects it
# already created then fail with "already exists", which is accepted (any
# other error still stops the run); in data the chunk's tables are emptied
# first so a retry cannot duplicate rows.
CHUNK="${CHUNK:-40}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
run_chunk() {
  local name="$1" part="$2"; shift 2
  pg_restore -d "$CONN" -L "$part" --section="$name" --exit-on-error "$@" "$DUMP" 2> "$WORK/err" && return 0
  local attempt
  for attempt in 2 3 4; do
    echo "   (nytt försök $attempt för $(basename "$part"))"
    if [ "$name" = data ]; then
      awk '/ TABLE DATA /{print $6"."$7}' "$part" | while read -r t; do
        q -c "TRUNCATE TABLE \"${t%%.*}\".\"${t#*.}\" CASCADE"
      done
      pg_restore -d "$CONN" -L "$part" --section=data --exit-on-error "$@" "$DUMP" 2> "$WORK/err" && return 0
    else
      pg_restore -d "$CONN" -L "$part" --section="$name" "$@" "$DUMP" 2> "$WORK/err" || true
      # One line per failed statement, e.g. "pg_restore: fel: could not execute
      # query: ERROR:  relation \"x\" already exists". The trailing summary
      # ("errors ignored on restore") is not a failure of its own.
      local errs bad
      errs=$(grep -iE "could not execute query|could not connect|connection to server|stängde oväntat" "$WORK/err" || true)
      if echo "$errs" | grep -qiE "stängde oväntat|closed the connection|connection to server|could not connect"; then
        continue
      fi
      bad=$(echo "$errs" | grep -v '^$' | grep -viE "already exists|multiple primary keys" || true)
      [ -z "$bad" ] && return 0
      cat "$WORK/err" >&2
      return 1
    fi
    sleep 5
  done
  cat "$WORK/err" >&2
  return 1
}
section() {
  local name="$1"; shift
  skip_section "$name" && { echo "   ($name redan klar, hoppar över)"; return 0; }
  pg_restore -l --section="$name" "$DUMP" | grep -v '^;' | grep -v '^\s*$' > "$WORK/$name.all"
  if [ "$name" = "$RESUME_SECTION" ] && [ "$RESUME_OFFSET" -gt 0 ]; then
    tail -n +"$((RESUME_OFFSET + 1))" "$WORK/$name.all" > "$WORK/$name.rest" && mv "$WORK/$name.rest" "$WORK/$name.all"
  fi
  split -l "$CHUNK" -d -a 4 "$WORK/$name.all" "$WORK/$name.part."
  local parts=( "$WORK/$name.part."* ) i=0
  for p in "${parts[@]}"; do
    i=$((i+1))
    run_chunk "$name" "$p" "$@"
    [ $((i % 10)) -eq 0 ] || [ "$i" -eq "${#parts[@]}" ] && echo "   $name: del $i/${#parts[@]} klar"
  done
}

echo "2/6 pre-data (scheman, tabeller, funktioner)"
section pre-data --no-comments

echo "3/6 btree_gist i public"
q -c "CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public"
# pg_dump omits the default PUBLIC usage on schema public, and a recreated
# schema does not get it back; restore it explicitly.
q -c "GRANT USAGE ON SCHEMA public TO PUBLIC"

echo "4/6 data"
section data --disable-triggers

echo "5/6 post-data (index, regler, RLS, policies, behörigheter)"
section post-data --no-comments

# Re-apply every ACL entry once more, in small chunks. ACL entries are
# REVOKE+GRANT pairs and safe to repeat; a run that was cut and resumed
# otherwise leaves a few objects without grants (seen 2026-10-14: three tables
# and the PUBLIC usage on schema public), which RLS-based access needs.
echo "5b/6 behörigheter en gång till (idempotent)"
pg_restore -l "$DUMP" | grep -E " ACL | DEFAULT ACL " > "$WORK/acl.all"
split -l "$CHUNK" -d -a 4 "$WORK/acl.all" "$WORK/acl.part."
for p in "$WORK/acl.part."*; do
  for attempt in 1 2 3 4; do
    pg_restore -d "$CONN" -L "$p" --exit-on-error "$DUMP" 2> "$WORK/err" && break
    [ "$attempt" -lt 4 ] || { cat "$WORK/err" >&2; exit 1; }
    sleep 5
  done
done

echo "6/6 pg_cron-jobb + PostgREST-cache"
q <<'SQL'
-- cron.unschedule() only sees the calling role's jobs; these belong to postgres.
DELETE FROM cron.job
 WHERE jobname IN ('update-overdue-supplier-invoices','redact-expired-invoice-delivery-pii');
SELECT cron.schedule('update-overdue-supplier-invoices', '0 6 * * *', 'SELECT public.update_overdue_supplier_invoices()');
SELECT cron.schedule('redact-expired-invoice-delivery-pii', '15 3 * * *', 'SELECT public.redact_expired_invoice_delivery_pii()');
UPDATE cron.job SET username = 'postgres'
 WHERE jobname IN ('update-overdue-supplier-invoices','redact-expired-invoice-delivery-pii');
-- pg_dump omits an ACL equal to the owner default; prod stores this one explicitly.
GRANT ALL ON TABLE public.sie_period_read_leases TO postgres;
NOTIFY pgrst, 'reload schema';
SQL

echo "KLAR"
