# HT: nightly backup of the self-hosted Supabase (Postgres + Storage files)
# to an S3 bucket. Runs as a Railway cron service (one run, then exits).
# The image holds tools only; every credential comes from env at runtime.
# pg_dump must not be older than the server (supabase/postgres 17.6).
FROM postgres:17-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends rclone ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY docker/ht/db-backup/backup.sh /usr/local/bin/backup.sh
COPY docker/ht/db-backup/migrate-from-cloud.sh /usr/local/bin/migrate-from-cloud.sh
COPY scripts/db/supabase-restore.sh /usr/local/bin/supabase-restore.sh
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/migrate-from-cloud.sh /usr/local/bin/supabase-restore.sh
USER postgres
CMD ["/usr/local/bin/backup.sh"]
