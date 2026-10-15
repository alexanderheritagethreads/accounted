# Accounted med egen Supabase på Railway

Driftbok från Heritage Threads flytt (2026-10-13–15). Gäller varje kund som
kör sin Accounted-fork på Railway utan Supabase Cloud.

## Varför inte bara en Postgres

Accounted använder Supabase mer än databasen: databas-API:t (PostgREST,
~4 300 `.from()` + 254 `.rpc()`), inloggningen (GoTrue), fillagringen
(underlag/bilagor) och RLS som bygger på `auth.uid()`. Hela stacken behövs.

## Stacken (officiella images, ingen mall)

Railway-mallen `supabase` lägger en tredjepartsbinär från ett privat repo
(`@main`, opinnad) som startpunkt framför alla tjänster och hanterar alla
hemligheter. Använd i stället:

| Tjänst | Image | Måste-inställningar |
|---|---|---|
| supabase-db | `supabase/postgres:17.6.1.x` | volym på **`/var/lib/postgresql`** (inte `/data`: Supabase-konfen pekar ut datakatalogen), startCommand `docker-entrypoint.sh postgres -D /etc/postgresql -c max_connections=60 …` |
| supabase-auth | `supabase/gotrue:v2.x` | `GOTRUE_API_HOST=::`, `GOTRUE_MAILER_URLPATHS_{INVITE,CONFIRMATION,RECOVERY,EMAIL_CHANGE}=/auth/v1/verify` (annars pekar mejllänkar på `/verify` → 404), SMTP via Resend (`smtp.resend.com:465`, user `resend`, send-only-nyckel) |
| supabase-rest | `postgrest/postgrest:v14.x` | **`PGRST_SERVER_HOST=!6`** (`*` binder bara IPv4; Railways privatnät är IPv6), `PGRST_DB_MAX_ROWS=1000`, `PGRST_DB_SCHEMAS=public,graphql_public`, `PGRST_DB_EXTRA_SEARCH_PATH=public,extensions`, `PGRST_DB_POOL=5` |
| supabase-storage | `supabase/storage-api:v1.x` | `STORAGE_BACKEND=s3` mot en Railway-bucket (`ams`), `SERVER_HOST=::`, `NODE_OPTIONS=--max-old-space-size=192` |
| supabase-kong | `kong:2.8.x` | `KONG_DECLARATIVE_CONFIG_STRING` (Supabases kong.yml som JSON), **`KONG_PROXY_LISTEN=0.0.0.0:8000`** (dual-stack gav ~500 ms extra per anrop via Railways edge), **`KONG_NGINX_WORKER_PROCESSES=1`** (annars en worker per CPU → 4–8 GB RAM), `KONG_DNS_ORDER=LAST,AAAA,A,CNAME` |
| db-backup | `docker/ht/db-backup` | cron `0 2 * * *`, restart `NEVER` |

Efter tuning: hela Supabase-stacken ~370 MB RAM.

**Region:** sätt `multiRegionConfig` till EU **innan** volymen skapas, och skapa
volymen via GraphQL `volumeCreate` med `region` (CLI:ns `volume add` hamnar i
standardregionen `sfo`). Kontrollera efteråt:
`environment.volumeInstances.region`. En databas i fel region gav 600 ms per
transaktion, och bokföringsdata hör hemma i EU.

## Flytt från Supabase Cloud

1. Bygg stacken, kör init-SQL (rollösenord för authenticator/pgbouncer/
   supabase_auth_admin/supabase_storage_admin, `app.settings.jwt_secret`,
   tilläggen `btree_gist`(public), `vector`(extensions), `pg_cron`).
2. Pausa appens cron och synkjobb.
3. Engångstjänst med db-backup-imagen och startCommand
   `/usr/local/bin/migrate-from-cloud.sh` (`SRC_PG*` = Cloud, `PG*` = mål,
   restart `NEVER`). Den dumpar i containern, låser GoTrue/Storage-rollerna,
   kör `scripts/db/supabase-restore.sh` och låser upp. ~2 min. **Radera
   tjänsten direkt efteråt** (den bär Cloud-lösenordet; en variabeländring
   startar om den och kör igen).
4. `scripts/db/storage-copy.mjs` (efter DB-restore: objektversionerna kommer
   från dumpen).
5. `scripts/db/compare-with-prod.sh`: rader per tabell, regler, index,
   policies, triggers, funktioner, RLS, ACL. Kräv 0 skillnader.
6. Peka om appens `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` /
   `SUPABASE_SERVICE_ROLE_KEY`, starta om, starta cron och synk.

Fällor som `supabase-restore.sh` redan hanterar: Railways TCP-proxy kapar
anslutningar efter några minuter (återställ i bitar, återupptagbart med
`RESUME=`), `DROP SCHEMA public` tar med `btree_gist`, `pg_dump --schema`
tappar `PUBLIC` USAGE på public och en ägar-ACL, ACL kan saknas efter avbrott
(körs om), `cron.unschedule` ser bara egen rolls jobb.

## AI

Gemini gratisnivå = 20 anrop/dygn per modell, och upstreams bakgrundsjobb
(`documents/classify` var 5:e min) tömmer den. Kör utan AI eller med betald
nyckel/EU-leverantör med kostnadstak (`AI_PROVIDER=openai-compatible`,
`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`).
