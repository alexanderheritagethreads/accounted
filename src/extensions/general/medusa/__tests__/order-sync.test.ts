import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const listOrdersPage = vi.fn()

vi.mock('../lib/api-client', () => ({
  listOrdersPage: (...args: unknown[]) => listOrdersPage(...args),
  isRevokedCredentialsError: (error: unknown) =>
    error instanceof Error && error.message === 'REVOKED',
  MEDUSA_PAGE_SIZE: 100,
}))

vi.mock('@/lib/webshop-orders/ingest', () => ({
  upsertWebshopOrders: vi.fn(),
}))

import { upsertWebshopOrders } from '@/lib/webshop-orders/ingest'
import type { WebshopOrderUpsert } from '@/lib/webshop-orders/types'
import { encryptCredential } from '../lib/credentials'
import {
  MEDUSA_IMPORT_SOURCE,
  buildVatBreakdown,
  mapLineItems,
  mapOrderToWebshopRow,
  mapRefundsToWebshopRows,
  medusaOrderExternalId,
  medusaRefundExternalId,
  medusaStoreScope,
  orderQualifies,
  resolveWindowStartIso,
  syncMedusaOrders,
} from '../lib/order-sync'
import type { MedusaConnection, MedusaOrder } from '../types'
import liveOrders from './fixtures/medusa-orders-live.json'

process.env.MEDUSA_CREDENTIALS_ENCRYPTION_KEY = 'test-key'

const emptyUpsertResult = {
  inserted: 0,
  updated: 0,
  unchanged: 0,
  frozenFlagged: 0,
  crossMarked: 0,
  errors: 0,
}

function makeConnection(overrides: Partial<MedusaConnection> = {}): MedusaConnection {
  return {
    id: 'conn-1',
    company_id: 'company-1',
    user_id: 'user-1',
    store_url: 'https://backend.example.se',
    store_name: 'Testbutiken',
    admin_api_key_encrypted: encryptCredential('sk_admin_test'),
    status: 'active',
    currency: 'SEK',
    transaction_sync_enabled: true,
    last_order_synced_at: null,
    error_message: null,
    connected_at: '2026-07-01T00:00:00.000Z',
    disconnected_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeOrder(overrides: Partial<MedusaOrder> = {}): MedusaOrder {
  return {
    id: 'order_01',
    display_id: 1042,
    status: 'completed',
    currency_code: 'sek',
    email: 'kund@example.se',
    created_at: '2026-08-01T09:00:00.000Z',
    updated_at: '2026-08-01T09:05:00.000Z',
    total: 1250,
    tax_total: 250,
    items: [
      {
        id: 'item_1',
        title: 'Produkt A',
        quantity: 2,
        total: 1250,
        tax_total: 250,
        tax_lines: [{ rate: 25, code: null, total: 250 }],
      },
    ],
    shipping_methods: [],
    payment_collections: [{ status: 'captured', amount: 1250, captured_amount: 1250 }],
    shipping_address: {
      first_name: 'Test',
      last_name: 'Person',
      company: 'Testbolaget AB',
      country_code: 'se',
    },
    canceled_at: null,
    ...overrides,
  }
}

/** Minimal chainable supabase mock: records every update to medusa_connections. */
function makeSupabaseMock() {
  const updates: Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }> = []
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const builder = {
        update: (values: Record<string, unknown>) => {
          updates.push({ table, values, filters })
          return builder
        },
        eq: (column: string, value: unknown) => {
          filters[column] = value
          return builder
        },
      }
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, updates }
}

function cursorUpdates(updates: Array<{ table: string; values: Record<string, unknown> }>) {
  return updates.filter((u) => u.table === 'medusa_connections' && 'last_order_synced_at' in u.values)
}

beforeEach(() => {
  vi.clearAllMocks()
  listOrdersPage.mockResolvedValue({ orders: [], count: 0, offset: 0, limit: 100 })
  vi.mocked(upsertWebshopOrders).mockResolvedValue({ ...emptyUpsertResult })
})

describe('frozen external_id formats', () => {
  // ⚠️ Persisted to webshop_orders.external_id. Changing these orphans every
  // previously imported row; do not update without a coordinated backfill.
  it('order id format is frozen', () => {
    expect(medusaOrderExternalId('backend.example.se', 'order_01')).toBe(
      'medusa_backend.example.se_order_order_01',
    )
  })

  it('store scope is the stored origin as-is, not stripped like WooCommerce', () => {
    expect(medusaStoreScope('https://backend.example.se')).toBe('https://backend.example.se')
  })

  it('import source constant is frozen', () => {
    expect(MEDUSA_IMPORT_SOURCE).toBe('medusa')
  })
})

describe('orderQualifies', () => {
  it('qualifies a captured payment', () => {
    expect(orderQualifies(makeOrder())).toBe(true)
  })

  it('qualifies a partially captured payment', () => {
    expect(
      orderQualifies(
        makeOrder({ payment_collections: [{ status: 'partially_captured', amount: 1250, captured_amount: 500 }] }),
      ),
    ).toBe(true)
  })

  it('refuses a canceled order even with a captured payment', () => {
    expect(orderQualifies(makeOrder({ canceled_at: '2026-08-01T10:00:00.000Z' }))).toBe(false)
  })

  it('refuses an order with no captured funds', () => {
    expect(orderQualifies(makeOrder({ payment_collections: [{ status: 'not_paid', amount: 1250 }] }))).toBe(false)
    expect(orderQualifies(makeOrder({ payment_collections: [] }))).toBe(false)
    expect(orderQualifies(makeOrder({ payment_collections: undefined }))).toBe(false)
  })
})

describe('buildVatBreakdown', () => {
  it('builds one bucket per rate from the lines', () => {
    expect(buildVatBreakdown(makeOrder())).toEqual([{ rate: 25, net: 1000, tax: 250 }])
  })

  it('splits a mixed-rate order into separate buckets, highest rate first', () => {
    const order = makeOrder({
      items: [
        { id: 'a', title: 'Tröja', quantity: 1, total: 1250, tax_total: 250, tax_lines: [{ rate: 25, code: null, total: 250 }] },
        { id: 'b', title: 'Bok', quantity: 1, total: 106, tax_total: 6, tax_lines: [{ rate: 6, code: null, total: 6 }] },
      ],
      shipping_methods: [{ name: 'Postnord', total: 49, tax_total: 9.8, tax_lines: [{ rate: 25, code: null, total: 9.8 }] }],
    })
    expect(buildVatBreakdown(order)).toEqual([
      { rate: 25, net: 1039.2, tax: 259.8 },
      { rate: 6, net: 100, tax: 6 },
    ])
  })

  it('falls back to one balancing bucket when a taxed line has no rate', () => {
    const order = makeOrder({ shipping_methods: [{ name: 'Postnord', total: 49, tax_total: 9.8 }] })
    expect(buildVatBreakdown(order)).toEqual([{ rate: 25, net: 1039.2, tax: 259.8 }])
  })

  it('returns [] for a zero-money order', () => {
    expect(buildVatBreakdown(makeOrder({ items: [] }))).toEqual([])
  })
})

describe('mapLineItems', () => {
  it('maps items and shipping, skipping a zero shipping method', () => {
    const order = makeOrder({
      shipping_methods: [{ name: 'Postnord', total: 0, tax_total: 0 }],
    })
    const items = mapLineItems(order)
    expect(items).toEqual([{ name: 'Produkt A', quantity: 2, total: 1000, total_tax: 250, vat_rate: 25 }])
  })

  it('includes a non-zero shipping method as its own line', () => {
    const order = makeOrder({
      shipping_methods: [{ name: 'Postnord', total: 49, tax_total: 9.8, tax_lines: [{ rate: 25, code: null, total: 9.8 }] }],
    })
    const items = mapLineItems(order)
    expect(items).toHaveLength(2)
    expect(items[1]).toEqual({ name: 'Postnord', quantity: 1, total: 39.2, total_tax: 9.8, vat_rate: 25 })
  })

  it('falls back to Frakt when a shipping method has no name', () => {
    const order = makeOrder({ shipping_methods: [{ name: '', total: 9.8, tax_total: 1.96 }] })
    expect(mapLineItems(order)[1].name).toBe('Frakt')
  })
})

describe('mapOrderToWebshopRow', () => {
  const connection = { id: 'conn-1', store_name: 'Testbutiken' }

  it('maps a qualifying order to a full upsert row', () => {
    const rows = mapOrderToWebshopRow(connection, 'backend.example.se', makeOrder())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      platform: 'medusa',
      store_scope: 'backend.example.se',
      store_label: 'Testbutiken',
      connection_id: 'conn-1',
      row_type: 'order',
      external_id: 'medusa_backend.example.se_order_order_01',
      platform_order_id: 'order_01',
      order_number: '1042',
      status: 'completed',
      is_paid: true,
      order_date: '2026-08-01',
      paid_date: '2026-08-01',
      currency: 'SEK',
      total: 1250,
      total_tax: 250,
      customer_name: 'Test Person',
      customer_company: 'Testbolaget AB',
      customer_email: 'kund@example.se',
      customer_country: 'SE',
      refunded_total: 0,
    })
    expect(rows[0].vat_breakdown).toEqual([{ rate: 25, net: 1000, tax: 250 }])
  })

  it('skips a non-qualifying order (canceled or uncaptured)', () => {
    expect(
      mapOrderToWebshopRow(connection, 's', makeOrder({ canceled_at: '2026-08-01T10:00:00.000Z' })),
    ).toEqual([])
    expect(
      mapOrderToWebshopRow(connection, 's', makeOrder({ payment_collections: [] })),
    ).toEqual([])
  })

  it('skips a zero-total order: no bookable money event', () => {
    expect(
      mapOrderToWebshopRow(
        connection,
        's',
        makeOrder({ total: 0, tax_total: 0, items: [], payment_collections: [{ status: 'captured', amount: 0, captured_amount: 0 }] }),
      ),
    ).toEqual([])
  })

  it('has no customer name when the shipping address is absent', () => {
    const rows = mapOrderToWebshopRow(connection, 's', makeOrder({ shipping_address: null }))
    expect(rows[0].customer_name).toBeNull()
    expect(rows[0].customer_company).toBeNull()
    expect(rows[0].customer_country).toBeNull()
  })
})

describe('frozen refund external_id format', () => {
  it('refund id format is frozen', () => {
    expect(medusaRefundExternalId('backend.example.se', 'ref_01')).toBe('medusa_backend.example.se_refund_ref_01')
  })
})

/**
 * Real Admin API payloads from a live Medusa 2.15 store (2026-10-08), fetched
 * with the ORDER_FIELDS list: a partly refunded SEK order, a fully refunded
 * EUR order (Finland, 25.5 %) and a discounted SEK order.
 */
describe('live Medusa payloads', () => {
  const connection = { id: 'conn-1', store_name: 'Testbutiken' }
  const [partlyRefunded, fullyRefundedEur, discounted] = liveOrders.orders as unknown as MedusaOrder[]
  const rowsFor = (order: MedusaOrder) => [
    ...mapOrderToWebshopRow(connection, 's', order),
    ...mapRefundsToWebshopRows(connection, 's', order),
  ]

  it('books what was sold, not order.total (which drops after a refund)', () => {
    expect(partlyRefunded.total).toBe(248)
    const [order, refund] = rowsFor(partlyRefunded)
    expect(order).toMatchObject({ row_type: 'order', total: 447, total_tax: 89.4, currency: 'SEK', refunded_total: 199 })
    expect(order.vat_breakdown).toEqual([{ rate: 25, net: 357.6, tax: 89.4 }])
    const lines = order.line_items as Array<{ total: number; total_tax: number }>
    expect(lines.reduce((sum, l) => sum + l.total + l.total_tax, 0)).toBeCloseTo(447, 2)
    expect(refund).toMatchObject({
      row_type: 'refund',
      status: 'refund',
      parent_external_id: 'medusa_s_order_' + partlyRefunded.id,
      external_id: 'medusa_s_refund_ref_01M4E5NP7QE33RY2CAZZ15T2CZ',
      total: -199,
      total_tax: -39.8,
      order_date: '2026-10-08',
      line_items: [],
      refunded_total: 0,
    })
    expect(refund.vat_breakdown).toEqual([{ rate: 25, net: 159.2, tax: 39.8 }])
  })

  it('maps a fully refunded EUR order with the Finnish 25.5 % rate', () => {
    const [order, refund] = rowsFor(fullyRefundedEur)
    expect(order).toMatchObject({ total: 24.9, total_tax: 5.06, currency: 'EUR', refunded_total: 24.9 })
    expect(order.vat_breakdown).toEqual([{ rate: 25.5, net: 19.84, tax: 5.06 }])
    expect(refund).toMatchObject({ total: -24.9, total_tax: -5.06, currency: 'EUR' })
    expect(refund.vat_breakdown).toEqual([{ rate: 25.5, net: 19.84, tax: 5.06 }])
  })

  it('books a discounted order at the discounted price, with no refund rows', () => {
    const rows = rowsFor(discounted)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ total: 547.97, total_tax: 109.59, refunded_total: 0 })
    expect(rows[0].vat_breakdown).toEqual([{ rate: 25, net: 438.38, tax: 109.59 }])
  })
})

describe('resolveWindowStartIso', () => {
  const CONNECTED_AT = '2026-09-09T10:00:00.000Z'
  const seeded = (overrides: Partial<MedusaConnection> = {}) =>
    makeConnection({
      connected_at: CONNECTED_AT,
      created_at: '2026-09-09T09:59:00.000Z',
      last_order_synced_at: CONNECTED_AT,
      ...overrides,
    })

  it('starts the first sync at the connection moment, not a day earlier', () => {
    expect(resolveWindowStartIso(seeded())).toBe(CONNECTED_AT)
  })

  it('keeps the 24h overlap once the cursor has moved past the connection', () => {
    expect(resolveWindowStartIso(seeded({ last_order_synced_at: '2026-09-20T10:00:00.000Z' }))).toBe(
      '2026-09-19T10:00:00.000Z',
    )
  })

  it("falls back to the connection's own start when the cursor is null", () => {
    expect(resolveWindowStartIso(seeded({ last_order_synced_at: null }))).toBe(CONNECTED_AT)
    expect(
      resolveWindowStartIso(seeded({ last_order_synced_at: null, connected_at: null })),
    ).toBe('2026-09-09T09:59:00.000Z')
  })
})

describe('syncMedusaOrders', () => {
  it('upserts a qualifying order and advances the cursor to the page watermark', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce({ orders: [makeOrder()], count: 1, offset: 0, limit: 100 })
    vi.mocked(upsertWebshopOrders).mockResolvedValueOnce({ ...emptyUpsertResult, inserted: 1 })

    const summary = await syncMedusaOrders(client, makeConnection())

    expect(summary).toMatchObject({ fetched: 1, inserted: 1, errors: 0 })
    expect(upsertWebshopOrders).toHaveBeenCalledTimes(1)
    const [, companyId, userId, rows] = vi.mocked(upsertWebshopOrders).mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect((rows as WebshopOrderUpsert[])[0].external_id).toBe('medusa_https://backend.example.se_order_order_01')

    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:05:00.000Z')
    expect(cursors[0].values.error_message).toBeNull()
  })

  it('upserts a refunded order together with its refund row', async () => {
    const { client } = makeSupabaseMock()
    const refunded = (liveOrders.orders as unknown as MedusaOrder[])[0]
    listOrdersPage.mockResolvedValueOnce({ orders: [refunded], count: 1, offset: 0, limit: 100 })

    await syncMedusaOrders(client, makeConnection())

    const rows = vi.mocked(upsertWebshopOrders).mock.calls[0][3] as WebshopOrderUpsert[]
    expect(rows.map((r) => [r.row_type, r.total])).toEqual([
      ['order', 447],
      ['refund', -199],
    ])
  })

  it('advances the cursor past a non-qualifying order without upserting it', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce({
      orders: [makeOrder({ canceled_at: '2026-08-01T10:00:00.000Z' })],
      count: 1,
      offset: 0,
      limit: 100,
    })

    const summary = await syncMedusaOrders(client, makeConnection())

    expect(summary).toMatchObject({ fetched: 1, inserted: 0, errors: 0 })
    expect(upsertWebshopOrders).not.toHaveBeenCalled()
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:05:00.000Z')
  })

  it('holds the cursor below a page whose upsert reported errors', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce({ orders: [makeOrder()], count: 1, offset: 0, limit: 100 })
    vi.mocked(upsertWebshopOrders).mockResolvedValueOnce({ ...emptyUpsertResult, errors: 1 })

    const summary = await syncMedusaOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:04:59.000Z')
  })

  it('pages by offset through a full page, then stops on a short page', async () => {
    const { client } = makeSupabaseMock()
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makeOrder({
        id: `order_${i + 1}`,
        display_id: i + 1,
        updated_at: '2026-08-01T09:05:00.000Z',
      }),
    )
    const secondPage = [makeOrder({ id: 'order_200', display_id: 200, updated_at: '2026-08-01T10:00:00.000Z' })]
    listOrdersPage
      .mockResolvedValueOnce({ orders: fullPage, count: 150, offset: 0, limit: 100 })
      .mockResolvedValueOnce({ orders: secondPage, count: 150, offset: 100, limit: 100 })

    const summary = await syncMedusaOrders(client, makeConnection())

    expect(summary.fetched).toBe(101)
    expect(listOrdersPage).toHaveBeenCalledTimes(2)
    expect(listOrdersPage.mock.calls[0][1]).toMatchObject({ offset: 0 })
    expect(listOrdersPage.mock.calls[1][1]).toMatchObject({ offset: 100 })
  })

  it('advances a quiet store (empty window) to roughly now, not just the stale cursor', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce({ orders: [], count: 0, offset: 0, limit: 100 })

    const before = Date.now()
    const summary = await syncMedusaOrders(client, makeConnection({ last_order_synced_at: '2026-07-02T00:00:00.000Z' }))
    const after = Date.now()

    expect(summary).toMatchObject({ fetched: 0, inserted: 0, errors: 0 })
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    const cursorMs = Date.parse(String(cursors[0].values.last_order_synced_at))
    expect(cursorMs).toBeGreaterThanOrEqual(before)
    expect(cursorMs).toBeLessThanOrEqual(after)
  })

  it('does not double-write the cursor on a short but non-empty final page', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce({ orders: [makeOrder()], count: 1, offset: 0, limit: 100 })
    vi.mocked(upsertWebshopOrders).mockResolvedValueOnce({ ...emptyUpsertResult, inserted: 1 })

    await syncMedusaOrders(client, makeConnection())

    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:05:00.000Z')
  })

  it('does nothing for a connection without credentials or not active', async () => {
    const { client } = makeSupabaseMock()
    const summary = await syncMedusaOrders(client, makeConnection({ admin_api_key_encrypted: null }))
    expect(summary.fetched).toBe(0)
    expect(listOrdersPage).not.toHaveBeenCalled()

    const revokedSummary = await syncMedusaOrders(client, makeConnection({ status: 'revoked' }))
    expect(revokedSummary.fetched).toBe(0)
  })

  it('flips the connection to revoked when the store rejects the credentials', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockRejectedValueOnce(new Error('REVOKED'))

    const summary = await syncMedusaOrders(client, makeConnection())

    expect(summary.revoked).toBe(true)
    const revokeUpdate = updates.find((u) => u.table === 'medusa_connections' && u.values.status === 'revoked')
    expect(revokeUpdate?.values).toMatchObject({
      status: 'revoked',
      admin_api_key_encrypted: null,
    })
  })

  it('stops before fetching when the deadline is already reached', async () => {
    const { client } = makeSupabaseMock()
    const summary = await syncMedusaOrders(client, makeConnection(), undefined, Date.now() - 1)
    expect(summary.deadlineReached).toBe(true)
    expect(listOrdersPage).not.toHaveBeenCalled()
  })
})
