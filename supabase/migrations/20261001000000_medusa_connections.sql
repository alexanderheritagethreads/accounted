-- Medusa store connections: per-company Medusa Admin API credentials for the
-- order/refund feed (extensions/general/medusa), modeled directly on
-- woocommerce_connections (20260806170000).
--
-- Medusa has no OAuth handshake comparable to WooCommerce's wc-auth: a
-- merchant creates a secret API key in their own Medusa admin (Settings >
-- API Key Management) and pastes it in, so this connection is manual-entry
-- only (no oauth_state, no pending/callback lifecycle). Encrypted at rest
-- with a dedicated server-side key (MEDUSA_CREDENTIALS_ENCRYPTION_KEY),
-- mirroring the WooCommerce/Shopify credential stores.

create table public.medusa_connections (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  -- Normalized https origin of the merchant's Medusa backend, no trailing
  -- slash. Set at connect time; every API call re-normalises and uses this
  -- stored value (see lib/api-client.ts), never a value carried on the request.
  store_url             text not null,
  -- Store display name, read from the Medusa store settings at connect time.
  store_name            text,
  -- AES-256-GCM encrypted Medusa secret API key (sk_...).
  admin_api_key_encrypted text,
  status                text not null default 'active'
                          check (status in ('active', 'revoked', 'error')),
  -- Store currency read at connect time; cosmetic (the feed reads each
  -- order's own currency_code), kept for the settings panel.
  currency              text,
  -- Opt-in for the nightly order feed cron (the manual sync button ignores it).
  transaction_sync_enabled boolean not null default false,
  -- Order-polling cursor: max updated_at processed. Re-polled with overlap
  -- by the sync (see lib/order-sync.ts); (company_id, external_id) dedup
  -- makes overlaps no-ops.
  last_order_synced_at  timestamptz,
  error_message         text,
  connected_at          timestamptz,
  disconnected_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- One active connection per company.
create unique index medusa_connections_one_active_per_company
  on public.medusa_connections (company_id) where (status = 'active');

-- A store may be actively connected to at most one company: two companies
-- importing the same order stream would double-book it.
create unique index medusa_connections_store_active_uniq
  on public.medusa_connections (store_url) where (status = 'active');

create index idx_medusa_connections_company_id
  on public.medusa_connections (company_id);

alter table public.medusa_connections enable row level security;

-- Members read their company's connection. Insert/update are member-scoped
-- so the connect/disconnect routes can run on the user's cookie session; the
-- nightly sync cron uses the service role (bypasses RLS).
-- No DELETE policy: connections are revoked (status flip), never deleted,
-- for audit (same doctrine as woocommerce_connections/stripe_connections).
create policy "members read medusa_connections"
  on public.medusa_connections for select
  using (company_id in (select public.user_company_ids()));

create policy "members insert medusa_connections"
  on public.medusa_connections for insert
  with check (
    company_id in (select public.user_company_ids())
    and user_id = auth.uid()
  );

create policy "members update medusa_connections"
  on public.medusa_connections for update
  using (company_id in (select public.user_company_ids()))
  with check (company_id in (select public.user_company_ids()));

create trigger set_updated_at_medusa_connections
  before update on public.medusa_connections
  for each row execute function public.update_updated_at_column();

-- Writer-role gate: only members with write access may insert/update/delete
-- a connection row (same guard as every other integration's connections
-- table; see 20260902093000 and the Zettle parity fix 20260909100400, which
-- is the exact gap this migration deliberately does not repeat).
create trigger aa_enforce_company_writer_role
  before insert or update or delete on public.medusa_connections
  for each row execute function public.enforce_company_writer_role();

comment on table public.medusa_connections is
  'Medusa store connections per company. Secret API key stored AES-256-GCM encrypted; decryption requires the server-side MEDUSA_CREDENTIALS_ENCRYPTION_KEY.';

-- Grants: new table, no privileges for the Data API roles by default since
-- 20260929220000_own_default_privileges. service_role needs full DML (the
-- sync cron and connect/disconnect routes that use the service client);
-- authenticated gets what the policies above allow (no delete policy, so no
-- DELETE grant). anon: not a public table.
grant select, insert, update on table public.medusa_connections to service_role;
grant select, insert, update on table public.medusa_connections to authenticated;
-- no-grant: anon on public.medusa_connections (tenant-scoped integration credentials, never public)

-- Platform CHECK parity: webshop_orders/webshop_store_settings must accept
-- platform = 'medusa' or every upsert from the medusa sync is refused at the
-- database (the exact gap 20260909100400 fixed for Zettle).

alter table public.webshop_orders
  drop constraint if exists webshop_orders_platform_check;
alter table public.webshop_orders
  add constraint webshop_orders_platform_check
    check (platform in ('woocommerce', 'shopify', 'zettle', 'medusa'));

alter table public.webshop_store_settings
  drop constraint if exists webshop_store_settings_platform_check;
alter table public.webshop_store_settings
  add constraint webshop_store_settings_platform_check
    check (platform in ('woocommerce', 'shopify', 'zettle', 'medusa'));

-- NOTE (known gap, same shape as the one 20260909100400 fixed for Zettle):
-- company_migration_reset_snapshot()/reset_company_for_migration() do not
-- yet know about medusa_connections, so an active Medusa connection will not
-- block a company data reset the way it should. Not fixed in this migration
-- because the function has been renamed/replaced by later migrations
-- (20260920190800 is the newest at the time of writing) and rewiring it
-- blind, without a live database to verify the rename chain against, is
-- exactly the kind of change that must be checked before it ships. Follow-up
-- migration required before this extension is considered done; track it the
-- same way 20260909100400 tracked the Zettle gap.

NOTIFY pgrst, 'reload schema';
