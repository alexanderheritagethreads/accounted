import type { SupabaseClient } from '@supabase/supabase-js'
import { upsertWebshopOrders } from '@/lib/webshop-orders/ingest'
import type { WebshopOrderUpsert } from '@/lib/webshop-orders/types'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre as round } from '@/lib/money'
import { resolveWindowStartMs } from '@/lib/feed-sync/cursor-window'
import type { WebshopOrderLineItem, WebshopVatBreakdownLine } from '@/types'
import { credentialsOf } from './credentials'
import { isRevokedCredentialsError, listOrdersPage, MEDUSA_PAGE_SIZE } from './api-client'
import type { MedusaConnection, MedusaOrder } from '../types'

const defaultLog = createLogger('medusa/order-sync')

/**
 * Medusa order sync: the store's paid orders as rows in public.webshop_orders
 * (the Orders page), same feed-only doctrine as the WooCommerce/Shopify/
 * Zettle syncs: nothing is auto-booked, the user books each row from the
 * Orders page.
 *
 * v1 scope, deliberately narrower than the WooCommerce/Shopify syncs:
 *
 *   - ORDERS ONLY, no refund rows. Medusa v2 tracks refunds at the payment
 *     level (payment.refunds), a different shape from the order-level
 *     refunds array WooCommerce/Shopify expose, and this was not verified
 *     against a live Medusa instance (no Medusa/Postgres available in this
 *     environment). Shipping a wrong refund mapping risks a silently wrong
 *     negative row; shipping none is an honest, visible gap instead. Follow-
 *     up once the real payload shape is confirmed against a live store.
 *   - SINGLE-BUCKET VAT, not the per-rate reconstruction the Shopify/
 *     WooCommerce syncs do. Medusa v2 does expose per-line tax_lines (see
 *     types.ts), but the field names were not confirmed live either; a
 *     single bucket derived from order.tax_total/order.item_total is a
 *     correct total (it has to balance, see buildVatBreakdown below) even
 *     if it does not split mixed-rate orders into separate buckets. The
 *     booking dialog already supports editing/splitting a prefilled bucket
 *     (same fallback the WooCommerce sync uses for hardened stores).
 *
 * Money fields arrive as MINOR-UNIT integers (öre for SEK), not decimal
 * strings like Shopify/WooCommerce — see MedusaMinorAmount in types.ts.
 *
 * Pagination: Medusa's Admin API is offset/limit, not cursor-based. One
 * fixed updated_at window per run, walked by offset until the page is short
 * of a full page (the store has nothing further matching the window) or the
 * returned count is exhausted. The persisted cursor is
 * medusa_connections.last_order_synced_at: per page, the max updated_at
 * processed, and after a fully-listed window the run's start time (same
 * watermark-advance reasoning as the WooCommerce sync, so a quiet store
 * does not permanently stall the cron's oldest-first selection). Re-polled
 * with a 24h overlap; upsert-on-(company_id, external_id) makes overlaps
 * idempotent.
 */

export const MEDUSA_IMPORT_SOURCE = 'medusa'
const CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1000
const MAX_ORDERS_PER_RUN = 10_000

/**
 * ⚠️ STORED-KEY FORMAT. Persisted to webshop_orders.external_id. Changing it
 * silently orphans every prior row and re-imports the whole feed on the next
 * sync. The scope is the store's normalized https origin, not the
 * connection id, so a disconnect/reconnect of the same store keeps every
 * previously imported row deduped (same convention as the other feeds).
 */
export function medusaStoreScope(storeUrl: string): string {
  return storeUrl
}

export function medusaOrderExternalId(storeScope: string, orderId: string): string {
  return `medusa_${storeScope}_order_${orderId}`
}

export interface MedusaSyncSummary {
  fetched: number
  inserted: number
  updated: number
  unchanged: number
  frozenFlagged: number
  crossMarked: number
  errors: number
  deadlineReached?: boolean
  revoked?: boolean
}

/** Whether the order has at least one payment that actually captured funds. */
export function orderQualifies(order: Pick<MedusaOrder, 'canceled_at' | 'payment_collections'>): boolean {
  if (order.canceled_at) return false
  return (order.payment_collections ?? []).some(
    (pc) => (pc.captured_amount ?? 0) > 0 || pc.status === 'captured' || pc.status === 'partially_captured',
  )
}

/**
 * Single VAT bucket for the whole order, rate derived from tax_total versus
 * the pre-tax total. Always balances to the order total by construction
 * (net + tax = item_total + shipping_total + tax_total, i.e. order.total),
 * so a malformed rate never produces an unbalanced booking, only an
 * imprecise one for mixed-rate orders (documented limitation above).
 */
export function buildVatBreakdown(
  order: Pick<MedusaOrder, 'item_total' | 'shipping_total' | 'tax_total'>,
): WebshopVatBreakdownLine[] {
  const net = round((order.item_total + order.shipping_total) / 100)
  const tax = round(order.tax_total / 100)
  if (net === 0 && tax === 0) return []
  const rate = net > 0 ? Math.round((tax / net) * 100) : 0
  return [{ rate, net, tax }]
}

/**
 * The stored line snapshot covers EVERYTHING inside order.total (product
 * lines + shipping) or nothing, same invariant the WooCommerce/Shopify
 * syncs enforce: the invoice conversion builds its rows from this snapshot,
 * so a diverging one would silently bill the wrong amount. Checked with an
 * öre-exact sum against order.total.
 */
export function mapLineItems(order: MedusaOrder): WebshopOrderLineItem[] {
  const items: WebshopOrderLineItem[] = []
  for (const item of order.items) {
    items.push({
      name: item.title,
      quantity: item.quantity,
      total: round((item.total - item.tax_total) / 100),
      total_tax: round(item.tax_total / 100),
      vat_rate: item.tax_lines?.[0]?.rate ?? null,
    })
  }
  for (const method of order.shipping_methods) {
    if (method.total === 0 && method.tax_total === 0) continue
    items.push({
      name: method.name || 'Frakt',
      quantity: 1,
      total: round((method.total - method.tax_total) / 100),
      total_tax: round(method.tax_total / 100),
      vat_rate: method.tax_lines?.[0]?.rate ?? null,
    })
  }

  const total = round(order.total / 100)
  const covered = round(items.reduce((sum, i) => sum + i.total + i.total_tax, 0))
  if (Math.abs(covered - total) > 0.005) return []
  return items
}

function customerName(order: MedusaOrder): string | null {
  const addr = order.shipping_address
  const name = [addr?.first_name, addr?.last_name].filter(Boolean).join(' ')
  return name || null
}

/** Map one paid order to its webshop_orders upsert row. */
export function mapOrderToWebshopRow(
  connection: Pick<MedusaConnection, 'id' | 'store_name'>,
  storeScope: string,
  order: MedusaOrder,
): WebshopOrderUpsert[] {
  if (!orderQualifies(order)) return []
  const total = round(order.total / 100)
  // Zero-total orders (100% discount) carry no bookable money event; the
  // engine refuses zero-sum entries, so importing them would strand an
  // unbookable row (same guard as the WooCommerce/Shopify syncs).
  if (total === 0) return []
  return [
    {
      platform: 'medusa',
      store_scope: storeScope,
      store_label: connection.store_name,
      connection_id: connection.id,
      row_type: 'order',
      parent_external_id: null,
      external_id: medusaOrderExternalId(storeScope, order.id),
      platform_order_id: order.id,
      order_number: String(order.display_id),
      status: order.status,
      is_paid: true,
      order_date: order.created_at.slice(0, 10),
      paid_date: order.created_at.slice(0, 10),
      currency: order.currency_code.toUpperCase(),
      total,
      total_tax: round(order.tax_total / 100),
      vat_breakdown: buildVatBreakdown(order),
      line_items: mapLineItems(order),
      customer_name: customerName(order),
      customer_company: order.shipping_address?.company ?? null,
      customer_email: order.email,
      customer_orgnr: null,
      customer_country: order.shipping_address?.country_code?.toUpperCase() ?? null,
      payment_method: null,
      payment_method_title: null,
      gateway_reference: null,
      refunded_total: 0,
    },
  ]
}

/**
 * Window start (ISO, UTC) for the updated_at filter. Same cursor-minus-
 * overlap logic as the WooCommerce/Shopify syncs (lib/feed-sync/cursor-window),
 * so a null cursor falls back to the connection's own connect moment, never
 * to a fixed number of days.
 */
export function resolveWindowStartIso(connection: MedusaConnection): string {
  return new Date(
    resolveWindowStartMs(
      {
        cursor: connection.last_order_synced_at,
        connectedAt: connection.connected_at,
        createdAt: connection.created_at,
      },
      CURSOR_OVERLAP_MS,
    ),
  ).toISOString()
}

export async function syncMedusaOrders(
  supabase: SupabaseClient,
  connection: MedusaConnection,
  log: Logger = defaultLog,
  /** Absolute deadline (epoch ms) from the caller's time budget. */
  deadlineMs?: number,
): Promise<MedusaSyncSummary> {
  const summary: MedusaSyncSummary = {
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    frozenFlagged: 0,
    crossMarked: 0,
    errors: 0,
  }
  if (connection.status !== 'active' || !connection.admin_api_key_encrypted) {
    return summary
  }

  const storeScope = medusaStoreScope(connection.store_url)
  const creds = credentialsOf(connection)

  const runStartMs = Date.now()
  const updatedAtMin = resolveWindowStartIso(connection)
  let offset = 0
  let prevCursorMs = connection.last_order_synced_at ? Date.parse(connection.last_order_synced_at) : 0
  let failureFloorMs = Number.POSITIVE_INFINITY
  let windowExhausted = false

  try {
    for (;;) {
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        summary.deadlineReached = true
        log.info('time budget exhausted; stopping order sync', {
          connectionId: connection.id,
          processed: summary.inserted + summary.updated + summary.unchanged,
        })
        break
      }

      const page = await listOrdersPage(creds, { updatedAtMin, offset })
      if (page.orders.length === 0) {
        // Quiet window: no orders at all, so there is no lastMs to anchor
        // the cursor on. Advance to "now" below so a store with no activity
        // does not stall the cron's oldest-first connection selection.
        windowExhausted = true
        break
      }
      summary.fetched += page.orders.length

      const rows: WebshopOrderUpsert[] = []
      for (const order of page.orders) {
        rows.push(...mapOrderToWebshopRow(connection, storeScope, order))
      }

      const firstMs = Date.parse(page.orders[0].updated_at)
      const lastMs = Date.parse(page.orders[page.orders.length - 1].updated_at)

      if (rows.length > 0) {
        const result = await upsertWebshopOrders(supabase, connection.company_id, connection.user_id, rows)
        summary.inserted += result.inserted
        summary.updated += result.updated
        summary.unchanged += result.unchanged
        summary.frozenFlagged += result.frozenFlagged
        summary.crossMarked += result.crossMarked
        summary.errors += result.errors
        if (result.errors > 0) {
          failureFloorMs = Math.min(failureFloorMs, firstMs - 1000)
        }
      }

      const candidateMs = Math.min(lastMs, failureFloorMs)
      if (candidateMs > prevCursorMs) {
        const cursorIso = new Date(candidateMs).toISOString()
        await supabase
          .from('medusa_connections')
          .update({ last_order_synced_at: cursorIso, error_message: null })
          .eq('id', connection.id)
        connection.last_order_synced_at = cursorIso
        prevCursorMs = candidateMs
      }

      offset += page.orders.length
      if (offset >= page.count || page.orders.length < MEDUSA_PAGE_SIZE) {
        // Last page of this window's results: the cursor already sits at
        // the true high-water mark (lastMs) from the write above, so there
        // is no need to also jump it to "now".
        break
      }

      if (summary.fetched >= MAX_ORDERS_PER_RUN) {
        log.warn('order cap reached; remaining orders resume next run', {
          connectionId: connection.id,
          cap: MAX_ORDERS_PER_RUN,
        })
        break
      }
    }

    if (windowExhausted) {
      const watermarkMs = Math.min(runStartMs, failureFloorMs)
      if (watermarkMs > prevCursorMs) {
        const cursorIso = new Date(watermarkMs).toISOString()
        await supabase
          .from('medusa_connections')
          .update({ last_order_synced_at: cursorIso, error_message: null })
          .eq('id', connection.id)
        connection.last_order_synced_at = cursorIso
        prevCursorMs = watermarkMs
      }
    }
  } catch (err) {
    if (isRevokedCredentialsError(err)) {
      summary.revoked = true
      await supabase
        .from('medusa_connections')
        .update({
          status: 'revoked',
          error_message: 'Butiken avvisade den sparade API-nyckeln. Anslut butiken igen.',
          admin_api_key_encrypted: null,
          disconnected_at: new Date().toISOString(),
        })
        .eq('id', connection.id)
        .eq('status', 'active')
      log.warn('credentials revoked upstream; connection flipped to revoked', {
        connectionId: connection.id,
      })
      return summary
    }
    throw err
  }

  log.info('medusa order sync done', { connectionId: connection.id, ...summary })
  return summary
}
