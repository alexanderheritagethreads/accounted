#!/usr/bin/env bash
# Nightly backup. Env:
#   PGHOST PGPORT PGPASSWORD                       database (user supabase_admin)
#   SRC_S3_ENDPOINT SRC_S3_BUCKET SRC_S3_KEY SRC_S3_SECRET   Storage bucket (files)
#   DST_S3_ENDPOINT DST_S3_BUCKET DST_S3_KEY DST_S3_SECRET   backup bucket
#   RETENTION_DAYS (default 30)
# Layout in the backup bucket:
#   db/accounted-<UTC timestamp>-full.dump   (same format as scripts/db/db-dump.sh --full,
#                                             restorable with scripts/db/supabase-restore.sh)
#   files/current/…                          mirror of the Storage bucket
#   files/deleted/<date>/…                   files removed or replaced since the last run
set -euo pipefail
: "${PGHOST:?}" "${PGPASSWORD:?}" "${SRC_S3_BUCKET:?}" "${DST_S3_BUCKET:?}"
export PGUSER=supabase_admin PGDATABASE=postgres PGPORT="${PGPORT:-5432}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TODAY="$(date -u +%Y-%m-%d)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

s3() { # name endpoint key secret
  export "RCLONE_CONFIG_$1_TYPE=s3" "RCLONE_CONFIG_$1_PROVIDER=Other" \
         "RCLONE_CONFIG_$1_ENDPOINT=$2" "RCLONE_CONFIG_$1_ACCESS_KEY_ID=$3" \
         "RCLONE_CONFIG_$1_SECRET_ACCESS_KEY=$4" "RCLONE_CONFIG_$1_REGION=auto"
}
s3 SRC "$SRC_S3_ENDPOINT" "$SRC_S3_KEY" "$SRC_S3_SECRET"
s3 DST "$DST_S3_ENDPOINT" "$DST_S3_KEY" "$DST_S3_SECRET"

echo "1/4 pg_dump"
PGOPTIONS="-c default_transaction_read_only=on" pg_dump -Fc \
  --schema=public --schema=auth --schema=storage --schema=supabase_migrations \
  -f "$WORK/db.dump"
TABLES=$(pg_restore --list "$WORK/db.dump" | grep -c " TABLE DATA ")
[ "$TABLES" -gt 100 ] || { echo "Misstänkt liten dump ($TABLES tabeller), avbryter"; exit 1; }
echo "   $(du -h "$WORK/db.dump" | cut -f1), $TABLES tabeller"

echo "2/4 laddar upp dumpen"
rclone copyto "$WORK/db.dump" "DST:$DST_S3_BUCKET/db/accounted-$STAMP-full.dump" --s3-no-check-bucket
rclone lsf "DST:$DST_S3_BUCKET/db/accounted-$STAMP-full.dump" --s3-no-check-bucket | grep -q . \
  || { echo "Uppladdad dump syns inte i bucketen"; exit 1; }

echo "3/4 speglar filerna"
rclone sync "SRC:$SRC_S3_BUCKET" "DST:$DST_S3_BUCKET/files/current" \
  --backup-dir "DST:$DST_S3_BUCKET/files/deleted/$TODAY" --s3-no-check-bucket --checksum
echo "   $(rclone size "DST:$DST_S3_BUCKET/files/current" --s3-no-check-bucket | tr '\n' ' ')"

echo "4/4 gallrar äldre än $RETENTION_DAYS dagar"
rclone delete "DST:$DST_S3_BUCKET/db" --min-age "${RETENTION_DAYS}d" --s3-no-check-bucket
rclone delete "DST:$DST_S3_BUCKET/files/deleted" --min-age "${RETENTION_DAYS}d" --s3-no-check-bucket
echo "BACKUP-OK $STAMP"
