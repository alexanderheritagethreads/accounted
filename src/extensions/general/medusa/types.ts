/**
 * How far back an explicit backfill (POST /backfill) may reach, same bound
 * as the WooCommerce/Zettle feeds (see MAX_BACKFILL_YEARS there).
 */
export const MAX_BACKFILL_YEARS = 3

/** Row shape of public.medusa_connections. */
export interface MedusaConnection {
  id: string
  company_id: string
  user_id: string
  /** Normalized https origin of the merchant's Medusa backend, no trailing slash. */
  store_url: string
  store_name: string | null
  admin_api_key_encrypted: string | null
  status: 'active' | 'revoked' | 'error'
  currency: string | null
  /** Opt-in: nightly order-feed cron (the manual sync button ignores it). */
  transaction_sync_enabled: boolean
  /** Order-polling cursor (max updated_at processed). */
  last_order_synced_at: string | null
  error_message: string | null
  connected_at: string | null
  disconnected_at: string | null
  created_at: string
  updated_at: string
}

/** Connection fields safe for the browser (never the encrypted API key). */
export type MedusaConnectionStatus = Pick<
  MedusaConnection,
  | 'id'
  | 'status'
  | 'store_url'
  | 'store_name'
  | 'currency'
  | 'error_message'
  | 'connected_at'
  | 'transaction_sync_enabled'
  | 'last_order_synced_at'
>

/** Status payload returned by GET /api/extensions/ext/medusa/status. */
export interface MedusaStatusResponse {
  configured: boolean
  /** First entry of `connections`; kept for callers expecting one store. */
  connection: MedusaConnectionStatus | null
  connections: MedusaConnectionStatus[]
}

/**
 * Minor-unit money field shared by Medusa v2's order/item/tax-line
 * payloads (the Admin API returns integers in the currency's minor unit,
 * e.g. öre for SEK, not decimal strings like Shopify/WooCommerce).
 */
export type MedusaMinorAmount = number

/** One tax line on an order item or shipping method (Medusa v2). */
export interface MedusaTaxLine {
  rate: number
  code: string | null
  total: MedusaMinorAmount
}

export interface MedusaOrderItem {
  id: string
  title: string
  quantity: number
  /** Line total actually charged, tax included (Medusa's `item.total`). */
  total: MedusaMinorAmount
  tax_total: MedusaMinorAmount
  tax_lines?: MedusaTaxLine[]
}

export interface MedusaShippingMethod {
  name: string
  total: MedusaMinorAmount
  tax_total: MedusaMinorAmount
  tax_lines?: MedusaTaxLine[]
}

export interface MedusaPaymentCollection {
  status: string
  amount: MedusaMinorAmount
  captured_amount?: MedusaMinorAmount
}

/**
 * Minimal Medusa v2 Admin API order shape consumed by the feed. Money
 * fields are MINOR-UNIT integers (see MedusaMinorAmount), unlike the
 * decimal-string amounts the Shopify/WooCommerce feeds parse.
 *
 * ⚠️ Field names follow Medusa v2's documented Admin API order object as
 * understood at the time of writing; not verified against a live Medusa
 * instance in this environment (no Medusa/Postgres available here). Shapes
 * that do not match a real deployment will surface as sync errors (unparsed
 * fields fail closed, see lib/order-sync.ts), not as corrupted bookings.
 */
export interface MedusaOrder {
  id: string
  display_id: number
  status: string
  currency_code: string
  email: string | null
  region_id: string | null
  created_at: string
  updated_at: string
  total: MedusaMinorAmount
  tax_total: MedusaMinorAmount
  item_total: MedusaMinorAmount
  shipping_total: MedusaMinorAmount
  items: MedusaOrderItem[]
  shipping_methods: MedusaShippingMethod[]
  payment_collections?: MedusaPaymentCollection[]
  shipping_address?: {
    first_name?: string | null
    last_name?: string | null
    company?: string | null
    country_code?: string | null
  } | null
  /** Set when canceled; a canceled order is never bookable revenue. */
  canceled_at?: string | null
}

/** Store metadata read at connect time (GET /admin/store). */
export interface MedusaStoreInfo {
  name: string | null
  currency: string | null
}
