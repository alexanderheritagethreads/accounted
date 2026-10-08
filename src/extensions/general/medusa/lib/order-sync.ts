import type { SupabaseClient } from '@supabase/supabase-js'
import { upsertWebshopOrders } from '@/lib/webshop-orders/ingest'
import type { WebshopOrderUpsert } from '@/lib/webshop-orders/types'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre as round } from '@/lib/money'
import { resolveWindowStartMs } from '@/lib/feed-sync/cursor-window'
import type { WebshopOrderLineItem, WebshopVatBreakdownLine } from '@/types'
import { credentialsOf } from './credentials'
import { isRevokedCredentialsError, listOrdersPage, MEDUSA_PAGE_SIZE } from './api-client'
import type { MedusaConnection, MedusaOrder, MedusaRefund } from '../types'

const defaultLog = createLogger('medusa/order-sync')

/**
 * Medusa order sync: the store's paid orders and their refunds as rows in
 * public.webshop_orders (the Orders page), same feed-only doctrine as the
 * WooCommerce/Shopify/Zettle syncs: nothing is auto-booked, the user books
 * each row from the Orders page.
 *
 * Verified against a live Medusa 2.15 store (2026-10-08) with a partly
 * refunded SEK order, a fully refunded EUR order and a discounted order; the
 * payloads are the test fixture __tests__/fixtures/medusa-orders-live.json.
 * What that established, and what the mapping relies on:
 *
 *   - Amounts are MAJOR units with decimals (199, 547.9726), rounded to öre
 *     here. (The first version assumed minor units and divided by 100.)
 *   - The amount sold is the sum of the item and shipping lines (tax
 *     included, discounts applied). order.total drops when a refund is made
 *     (a credit line) and order.original_total is before discounts, so
 *     neither is used.
 *   - VAT is split per rate from each line's tax_lines (25, 25.5 ...).
 *   - Refunds live on the payments (payment_collections[].payments[].refunds[]
 *     with amount and created_at). Each becomes its own negative 'refund'
 *     row, like the WooCommerce sync, its VAT prorated from the order's mix
 *     since a Medusa refund carries no line allocation.
 *
 * Pagination: Medusa's Admin API is offset/limit, not cursor-based. One
 * fixed updated_at window per run, walked by offset until the page is short
 * of a full page (the store has nothing further matching the window) or the
 * returned count is exhausted. A refund bumps the order's updated_at, so a
 * refunded order re-enters the window and its refund row is picked up. The
 * persisted cursor is medusa_connections.last_order_synced_at: per page, the
 * max updated_at processed, and after a fully-listed window the run's start
 * time (same watermark-advance reasoning as the WooCommerce sync, so a quiet
 * store does not permanently stall the cron's oldest-first selection).
 * Re-polled with a 24h overlap; upsert-on-(company_id, external_id) makes
 * overlaps idempotent.
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

/** ⚠️ STORED-KEY FORMAT, same rule as the order id above. */
export function medusaRefundExternalId(storeScope: string, refundId: string): string {
  return `medusa_${storeScope}_refund_${refundId}`
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

interface SaleLine {
  name: string
  quantity: number
  /** Tax included, discounts applied, öre-rounded. */
  gross: number
  tax: number
  rate: number | null
}

type SaleSource = Pick<MedusaOrder, 'items' | 'shipping_methods'>

/** The item and shipping lines that make up the sale (zero shipping skipped). */
function saleLines(order: SaleSource): SaleLine[] {
  const lines: SaleLine[] = []
  for (const item of order.items ?? []) {
    lines.push({
      name: item.title,
      quantity: item.quantity,
      gross: round(item.total),
      tax: round(item.tax_total),
      rate: item.tax_lines?.[0]?.rate ?? null,
    })
  }
  for (const method of order.shipping_methods ?? []) {
    if (method.total === 0 && method.tax_total === 0) continue
    lines.push({
      name: method.name || 'Frakt',
      quantity: 1,
      gross: round(method.total),
      tax: round(method.tax_total),
      rate: method.tax_lines?.[0]?.rate ?? null,
    })
  }
  return lines
}

/** What was sold: the sum of the lines (tax included, after discounts) and its VAT. */
export function saleTotals(order: SaleSource): { total: number; tax: number } {
  const lines = saleLines(order)
  return {
    total: round(lines.reduce((sum, l) => sum + l.gross, 0)),
    tax: round(lines.reduce((sum, l) => sum + l.tax, 0)),
  }
}

/**
 * VAT per rate from the lines' tax_lines. If a taxed line lacks a rate, one
 * bucket derived from the totals instead. Either way net + tax equals the
 * sale total, so the booking always balances.
 */
export function buildVatBreakdown(order: SaleSource): WebshopVatBreakdownLine[] {
  const lines = saleLines(order)
  const { total, tax } = saleTotals(order)
  if (total === 0 && tax === 0) return []
  if (lines.some((l) => l.rate === null && l.tax !== 0)) {
    const net = round(total - tax)
    return [{ rate: net > 0 ? Math.round((tax / net) * 1000) / 10 : 0, net, tax }]
  }
  const buckets = new Map<number, { net: number; tax: number }>()
  for (const l of lines) {
    const rate = l.rate ?? 0
    const bucket = buckets.get(rate) ?? { net: 0, tax: 0 }
    bucket.net = round(bucket.net + l.gross - l.tax)
    bucket.tax = round(bucket.tax + l.tax)
    buckets.set(rate, bucket)
  }
  return Array.from(buckets.entries())
    .map(([rate, b]) => ({ rate, net: b.net, tax: b.tax }))
    .sort((x, y) => y.rate - x.rate)
}

/**
 * The stored line snapshot covers EVERYTHING in the sale (product lines +
 * shipping), same invariant the WooCommerce/Shopify syncs enforce: the
 * invoice conversion builds its rows from this snapshot. By construction it
 * sums to saleTotals().total.
 */
export function mapLineItems(order: SaleSource): WebshopOrderLineItem[] {
  return saleLines(order).map((l) => ({
    name: l.name,
    quantity: l.quantity,
    total: round(l.gross - l.tax),
    total_tax: l.tax,
    vat_rate: l.rate,
  }))
}

/** Every non-zero refund on the order's payments, oldest first. */
export function orderRefunds(order: Pick<MedusaOrder, 'payment_collections'>): MedusaRefund[] {
  return (order.payment_collections ?? [])
    .flatMap((pc) => (pc.payments ?? []).flatMap((p) => p.refunds ?? []))
    .filter((r) => round(r.amount) !== 0)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/**
 * A refund's VAT reversal, prorated from the order's mix (Medusa's refund has
 * no line allocation). Buckets hold positive magnitudes; row_type 'refund'
 * carries the direction, as in the WooCommerce sync. Per-bucket rounding
 * drift lands on the booking's residual line.
 */
export function buildRefundVatBreakdown(
  order: SaleSource,
  refundAmount: number,
): { breakdown: WebshopVatBreakdownLine[]; totalTax: number } {
  const { total } = saleTotals(order)
  const orderBreakdown = buildVatBreakdown(order)
  const amount = Math.abs(round(refundAmount))
  if (orderBreakdown.length === 0 || total === 0 || amount === 0) return { breakdown: [], totalTax: 0 }
  const ratio = Math.min(1, amount / total)
  const breakdown = orderBreakdown.map(({ rate, net, tax }) => ({ rate, net: round(net * ratio), tax: round(tax * ratio) }))
  return { breakdown, totalTax: round(breakdown.reduce((sum, b) => sum + b.tax, 0)) }
}

function customerName(order: MedusaOrder): string | null {
  const addr = order.shipping_address
  const name = [addr?.first_name, addr?.last_name].filter(Boolean).join(' ')
  return name || null
}

function customerFields(order: MedusaOrder) {
  return {
    customer_name: customerName(order),
    customer_company: order.shipping_address?.company ?? null,
    customer_email: order.email,
    customer_orgnr: null,
    customer_country: order.shipping_address?.country_code?.toUpperCase() ?? null,
    payment_method: null,
    payment_method_title: null,
    gateway_reference: null,
  }
}

/** Map one paid order to its webshop_orders upsert row. */
export function mapOrderToWebshopRow(
  connection: Pick<MedusaConnection, 'id' | 'store_name'>,
  storeScope: string,
  order: MedusaOrder,
): WebshopOrderUpsert[] {
  if (!orderQualifies(order)) return []
  const { total, tax } = saleTotals(order)
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
      total_tax: tax,
      vat_breakdown: buildVatBreakdown(order),
      line_items: mapLineItems(order),
      ...customerFields(order),
      refunded_total: round(orderRefunds(order).reduce((sum, r) => sum + r.amount, 0)),
    },
  ]
}

/** One negative 'refund' row per refund of a paid order, linked to the order row. */
export function mapRefundsToWebshopRows(
  connection: Pick<MedusaConnection, 'id' | 'store_name'>,
  storeScope: string,
  order: MedusaOrder,
): WebshopOrderUpsert[] {
  if (!orderQualifies(order)) return []
  return orderRefunds(order).map((refund) => {
    const amount = Math.abs(round(refund.amount))
    const { breakdown, totalTax } = buildRefundVatBreakdown(order, amount)
    const date = refund.created_at.slice(0, 10)
    return {
      platform: 'medusa',
      store_scope: storeScope,
      store_label: connection.store_name,
      connection_id: connection.id,
      row_type: 'refund',
      parent_external_id: medusaOrderExternalId(storeScope, order.id),
      external_id: medusaRefundExternalId(storeScope, refund.id),
      platform_order_id: refund.id,
      order_number: String(order.display_id),
      status: 'refund',
      is_paid: true,
      order_date: date,
      paid_date: date,
      currency: order.currency_code.toUpperCase(),
      total: -amount,
      total_tax: -totalTax,
      vat_breakdown: breakdown,
      line_items: [],
      ...customerFields(order),
      refunded_total: 0,
    }
  })
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
        rows.push(...mapRefundsToWebshopRows(connection, storeScope, order))
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
