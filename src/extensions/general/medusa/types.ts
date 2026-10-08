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
 * Money field in Medusa v2's Admin API: a number in the currency's MAJOR unit
 * (kronor/euro), with decimals — e.g. 199, 547.9726, 5.059362549800797. Verified
 * against a live Medusa 2.15 store (2026-10-08); the first version of this
 * extension assumed minor units (öre) and divided by 100, which would have
 * booked a 447 kr order as 4.47 kr. Amounts are rounded to öre with roundOre
 * where they become bookkeeping values.
 */
export type MedusaAmount = number

/** One tax line on an order item or shipping method. `rate` is a percentage (25, 25.5). */
export interface MedusaTaxLine {
  rate: number
  code: string | null
  total: MedusaAmount
}

export interface MedusaOrderItem {
  id: string
  title: string
  quantity: number
  /** Line total actually charged: tax INCLUDED, discounts applied. */
  total: MedusaAmount
  tax_total: MedusaAmount
  tax_lines?: MedusaTaxLine[]
}

export interface MedusaShippingMethod {
  name: string
  /** Tax included, discounts applied. */
  total: MedusaAmount
  tax_total: MedusaAmount
  tax_lines?: MedusaTaxLine[]
}

/** A refund of a captured payment. Medusa records refunds per payment, not per order. */
export interface MedusaRefund {
  id: string
  amount: MedusaAmount
  created_at: string
  note?: string | null
}

export interface MedusaPayment {
  id: string
  amount: MedusaAmount
  captured_at?: string | null
  refunds?: MedusaRefund[]
}

export interface MedusaPaymentCollection {
  status: string
  amount: MedusaAmount
  captured_amount?: MedusaAmount
  refunded_amount?: MedusaAmount
  payments?: MedusaPayment[]
}

/**
 * The Admin API order shape the feed consumes, as returned for the field list
 * in lib/api-client.ts (ORDER_FIELDS). Verified against a live Medusa 2.15
 * store, including a partly refunded, a fully refunded EUR and a discounted
 * order (see __tests__/fixtures/medusa-orders-live.json).
 *
 * ⚠️ order.total is the CURRENT total — a refund lowers it through a credit
 * line — and order.original_total is the total BEFORE discounts. Neither is
 * the amount sold, so the feed derives the sale from the item and shipping
 * lines instead (see lib/order-sync.ts).
 */
export interface MedusaOrder {
  id: string
  display_id: number
  status: string
  currency_code: string
  email: string | null
  created_at: string
  updated_at: string
  total: MedusaAmount
  tax_total: MedusaAmount
  original_total?: MedusaAmount
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
