#!/usr/bin/env bash
# Compare a restored target database with production, object by object.
# Prod is read through db-ro-query.sh (read-only); the target through the
# TARGET_* env vars. Exit 0 only when everything that matters is identical.
#
#   TARGET_HOST=… TARGET_PORT=… TARGET_PASSWORD=… bash scripts/db/compare-with-prod.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT_DIR:-$HERE/../../../HT_Bok_backups}/compare"
mkdir -p "$OUT"

SCHEMAS="'public','auth','storage','supabase_migrations'"
declare -A Q
Q[rows]="select table_schema||'.'||table_name||'='||(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text from information_schema.tables where table_schema in ($SCHEMAS) and table_type='BASE TABLE' order by 1"
Q[constraints]="select n.nspname||':'||c.contype::text||'='||count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ($SCHEMAS) group by n.nspname, c.contype order by 1"
Q[indexes]="select schemaname||'.'||indexname from pg_indexes where schemaname in ($SCHEMAS) order by 1"
Q[policies]="select schemaname||'.'||tablename||'.'||policyname||':'||cmd||':'||array_to_string(roles,',') from pg_policies where schemaname in ($SCHEMAS) order by 1"
Q[triggers]="select n.nspname||'.'||c.relname||'.'||t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ($SCHEMAS) order by 1"
Q[functions]="select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ($SCHEMAS) order by 1"
Q[rls]="select n.nspname||'.'||c.relname||'='||c.relrowsecurity||'/'||c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ($SCHEMAS) order by 1"
Q[acl]="select n.nspname||'.'||c.relname||'='||coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a),'-') from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','v','m','S') and n.nspname in ($SCHEMAS) order by 1"
Q[schema_acl]="select nspname||'='||coalesce((select string_agg(a::text, ',' order by a::text) from unnest(nspacl) a),'-') from pg_namespace where nspname in ($SCHEMAS) order by 1"

clean() { tr -d '\r' | sed 's/^ *//; s/ *$//' | grep -vE '^(BEGIN|ROLLBACK|\(.* rad(er)?\)|-+|)$' | grep -v '?column?' | sort; }

fail=0
for k in rows constraints indexes policies triggers functions rls acl schema_acl; do
  env -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD bash "$HERE/db-ro-query.sh" "${Q[$k]}" | clean > "$OUT/$k.prod"
  PGHOST="$TARGET_HOST" PGPORT="$TARGET_PORT" PGUSER="${TARGET_USER:-supabase_admin}" PGPASSWORD="$TARGET_PASSWORD" PGDATABASE=postgres \
    psql -X -tA -c "${Q[$k]}" | clean > "$OUT/$k.target"
  d=$(diff "$OUT/$k.prod" "$OUT/$k.target" | grep -cE '^[<>]' || true)
  printf "%-12s prod %5s  mål %5s  skillnader %s\n" "$k" "$(wc -l < "$OUT/$k.prod")" "$(wc -l < "$OUT/$k.target")" "$d"
  [ "$d" -eq 0 ] || fail=1
done
exit $fail
