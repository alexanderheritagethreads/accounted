import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Force the capability gate to run but stub requireCapability so entitlement
// is controlled per test. Mirrors the woocommerce/stripe suites.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn().mockResolvedValue(null) }
})

// Never let a unit test reach a real Medusa host: the credential probe is
// mocked, the pure helper (normalizeStoreUrl) stays real.
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-client')>()
  return { ...actual, testConnectionAndFetchStoreInfo: vi.fn() }
})

// The sync engine has its own suite; here it only needs to be callable.
vi.mock('../lib/order-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/order-sync')>()
  return { ...actual, syncMedusaOrders: vi.fn() }
})

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({ service: true })),
}))

import { medusaExtension } from '../index'
import { requireCapability, capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { testConnectionAndFetchStoreInfo } from '../lib/api-client'
import { syncMedusaOrders } from '../lib/order-sync'
import { decryptCredential } from '../lib/credentials'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

function findRoute(method: string, path: string) {
  const route = medusaExtension.apiRoutes?.find((r) => r.method === method && r.path === path)
  expect(route, `${method} ${path} must be registered`).toBeDefined()
  return route!
}

function makeRequest(method: string, body?: unknown): Request {
  return new Request('https://test.local/api/extensions/ext/medusa/x', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function makeContext(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'medusa',
    requestId: 'req_test',
    supabase,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const USER = { id: 'user-1', is_anonymous: false }

/**
 * The next service client the route creates, answering `results` in order.
 * The sync and backfill look connections up there: the encrypted admin API
 * keys are withheld from end-user roles (same boundary as the other feeds).
 */
function serviceReturning(...results: Array<{ data?: unknown; error?: unknown }>) {
  const service = createQueuedMockSupabase()
  for (const result of results) service.enqueue(result)
  vi.mocked(createServiceClientNoCookies).mockReturnValueOnce(service.supabase as never)
  return service
}

const emptySyncSummary = {
  fetched: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  frozenFlagged: 0,
  crossMarked: 0,
  errors: 0,
}

describe('medusa extension routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireCapability).mockResolvedValue(null)
    vi.stubEnv('MEDUSA_CREDENTIALS_ENCRYPTION_KEY', 'test-key')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('GET /status', () => {
    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('GET', '/status').handler(makeRequest('GET'), makeContext(supabase))
      expect(res.status).toBe(401)
    })

    it('prefers the active connection and reports configured', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({
        data: [
          { id: 'c2', status: 'revoked' },
          { id: 'c1', status: 'active', store_url: 'https://backend.example.se' },
        ],
      })
      const res = await findRoute('GET', '/status').handler(makeRequest('GET'), makeContext(supabase))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.configured).toBe(true)
      expect(body.connection.id).toBe('c1')
    })

    it('falls back to the most recent connection when none is active', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [{ id: 'c1', status: 'revoked' }] })
      const res = await findRoute('GET', '/status').handler(makeRequest('GET'), makeContext(supabase))
      const body = await res.json()
      expect(body.connection.id).toBe('c1')
    })
  })

  describe('POST /manual-connect', () => {
    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(401)
    })

    it('blocks anonymous (sandbox) users before any external call', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({
        data: { user: { id: 'user-1', is_anonymous: true } },
        error: null,
      })
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.sandbox_blocked).toBe(true)
      expect(testConnectionAndFetchStoreInfo).not.toHaveBeenCalled()
    })

    it('returns 403 capability_blocked when not entitled', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      vi.mocked(requireCapability).mockResolvedValue(capabilityBlockedResponse(CAPABILITY.medusa_sync))
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', { store_url: 'https://backend.example.se', admin_api_key: 'sk_x' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(403)
    })

    it('rejects an invalid or http store URL with 400', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', { store_url: 'http://insecure.se', admin_api_key: 'sk_x' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
      expect(testConnectionAndFetchStoreInfo).not.toHaveBeenCalled()
    })

    it('rejects a missing admin_api_key with 400', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', { store_url: 'https://backend.example.se' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('rejects with 400 when the credential probe fails', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      enqueue({ data: [] }) // no existing active connection
      vi.mocked(testConnectionAndFetchStoreInfo).mockRejectedValue(new Error('401'))
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', { store_url: 'https://backend.example.se', admin_api_key: 'sk_x' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('returns 409 when the store is already actively connected', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      enqueue({ data: [{ id: 'conn-existing' }] }) // existing active connection
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', { store_url: 'https://backend.example.se', admin_api_key: 'sk_x' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(409)
      expect(testConnectionAndFetchStoreInfo).not.toHaveBeenCalled()
    })

    it('verifies, encrypts and activates on the happy path', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      vi.mocked(createServiceClientNoCookies).mockReturnValueOnce(supabase as never)
      enqueue({ data: { is_sandbox: false } })
      enqueue({ data: [] }) // no existing active connection
      enqueue({ data: { id: 'conn-1', store_url: 'https://backend.example.se' } }) // insert
      vi.mocked(testConnectionAndFetchStoreInfo).mockResolvedValue({ name: 'Testbutiken', currency: 'SEK' })
      const ctx = makeContext(supabase)
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', { store_url: 'https://backend.example.se', admin_api_key: 'sk_admin_test' }),
        ctx,
      )
      expect(res.status).toBe(200)
      const inserted = findCall('medusa_connections', 'insert')?.[0] as Record<string, string>
      expect(inserted.status).toBe('active')
      // The order cursor starts at the connection moment.
      expect(inserted.last_order_synced_at).toBe(inserted.connected_at)
      expect(typeof inserted.last_order_synced_at).toBe('string')
      // Scoped to the authenticated context, never to anything in the body.
      expect(inserted.company_id).toBe('company-1')
      expect(inserted.user_id).toBe(USER.id)
      expect(createServiceClientNoCookies).toHaveBeenCalled()
      expect(inserted.store_name).toBe('Testbutiken')
      // Secrets never stored in plaintext, and they decrypt back.
      expect(inserted.admin_api_key_encrypted).not.toContain('sk_admin_test')
      expect(decryptCredential(inserted.admin_api_key_encrypted)).toBe('sk_admin_test')
      expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'medusa.connected' }))
    })
  })

  describe('POST /sync', () => {
    it('returns 404 without an active connection', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      serviceReturning({ data: [] })
      const res = await findRoute('POST', '/sync').handler(makeRequest('POST'), makeContext(supabase))
      expect(res.status).toBe(404)
    })

    it('runs the sync on the service client and returns the summary', async () => {
      const { supabase, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      const service = serviceReturning({ data: [{ id: 'conn-1', status: 'active' }] })
      vi.mocked(syncMedusaOrders).mockResolvedValue({ ...emptySyncSummary, fetched: 3, inserted: 3 })
      const res = await findRoute('POST', '/sync').handler(makeRequest('POST'), makeContext(supabase))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.transactions.inserted).toBe(3)
      expect(vi.mocked(syncMedusaOrders).mock.calls[0][0]).toBe(service.supabase)
      // The credentialed rows come from the service role, scoped to the
      // caller's company; the session client never selects them.
      expect(service.findCall('medusa_connections', 'eq')).toEqual(['company_id', 'company-1'])
      expect(findCall('medusa_connections', 'select')).toBeUndefined()
    })
  })

  describe('POST /backfill', () => {
    const ACTIVE = {
      id: 'conn-1',
      status: 'active',
      store_url: 'https://backend.example.se',
      last_order_synced_at: '2026-09-14T00:00:00.000Z',
    }

    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('POST', '/backfill').handler(
        makeRequest('POST', { from: '2026-01-01' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(401)
      expect(syncMedusaOrders).not.toHaveBeenCalled()
    })

    it('rejects a date it cannot honour with 400', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      const route = findRoute('POST', '/backfill')
      for (const from of [undefined, 'igar', '2026-02-31', '3000-01-01', '1990-01-01']) {
        const res = await route.handler(makeRequest('POST', { from }), makeContext(supabase))
        expect(res.status, `from=${String(from)}`).toBe(400)
      }
      expect(syncMedusaOrders).not.toHaveBeenCalled()
    })

    it('returns 404 without an active connection', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      serviceReturning({ data: [] })
      const res = await findRoute('POST', '/backfill').handler(
        makeRequest('POST', { from: '2026-01-01' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(404)
      expect(syncMedusaOrders).not.toHaveBeenCalled()
    })

    it('refuses to guess the store when several are connected and none is named', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      serviceReturning({ data: [ACTIVE, { ...ACTIVE, id: 'conn-2', store_url: 'https://b.example.se' }] })
      const res = await findRoute('POST', '/backfill').handler(
        makeRequest('POST', { from: '2026-01-01' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
      expect(syncMedusaOrders).not.toHaveBeenCalled()
    })

    it('moves the named store cursor to the chosen date and syncs from there', async () => {
      const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      const service = serviceReturning({ data: [ACTIVE] })
      enqueue({ data: [] }) // cursor update (session client)
      vi.mocked(syncMedusaOrders).mockResolvedValue({ ...emptySyncSummary, fetched: 4, inserted: 4 })
      const res = await findRoute('POST', '/backfill').handler(
        makeRequest('POST', { from: '2026-01-01', connection_id: 'conn-1' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.from).toBe('2026-01-01T00:00:00.000Z')
      expect(body.connection_id).toBe('conn-1')
      expect(body.transactions.inserted).toBe(4)
      const updates = findCalls('medusa_connections', 'update')
      expect(updates[0][0]).toMatchObject({ last_order_synced_at: '2026-01-01T00:00:00.000Z' })
      // The sync must see the moved cursor, not the stored one, and run on
      // the service client like the manual sync.
      expect(vi.mocked(syncMedusaOrders).mock.calls[0][0]).toBe(service.supabase)
      expect(service.findCalls('medusa_connections', 'eq')).toContainEqual(['id', 'conn-1'])
      expect(findCall('medusa_connections', 'select')).toBeUndefined()
      expect(vi.mocked(syncMedusaOrders).mock.calls[0][1].last_order_synced_at).toBe('2026-01-01T00:00:00.000Z')
    })
  })

  describe('POST /transaction-sync', () => {
    it('rejects a non-boolean enabled with 400', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      const res = await findRoute('POST', '/transaction-sync').handler(
        makeRequest('POST', { enabled: 'yes' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('persists the toggle for the active connection', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [{ id: 'conn-1' }] })
      const res = await findRoute('POST', '/transaction-sync').handler(
        makeRequest('POST', { enabled: false }),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
      expect(findCall('medusa_connections', 'update')?.[0]).toEqual({ transaction_sync_enabled: false })
    })

    it('returns 404 when no connection matches', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [] })
      const res = await findRoute('POST', '/transaction-sync').handler(
        makeRequest('POST', { enabled: true }),
        makeContext(supabase),
      )
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /disconnect', () => {
    it('returns 404 when no connection exists', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [] })
      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(404)
    })

    it('revokes (never deletes), drops the stored key, and emits the audit event', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [{ id: 'conn-1', status: 'active', store_url: 'https://backend.example.se' }] })
      enqueue({ data: null }) // update
      const ctx = makeContext(supabase)
      const res = await findRoute('DELETE', '/disconnect').handler(makeRequest('DELETE', {}), ctx)
      expect(res.status).toBe(200)
      const updated = findCall('medusa_connections', 'update')?.[0] as Record<string, unknown>
      expect(updated.status).toBe('revoked')
      expect(updated.admin_api_key_encrypted).toBeNull()
      expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'medusa.disconnected' }))
    })
  })
})
