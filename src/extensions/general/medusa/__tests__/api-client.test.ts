import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  INVALID_STORE_URL_CODE,
  UNSAFE_STORE_URL_CODE,
  MEDUSA_PAGE_SIZE,
  MedusaApiError,
  listOrdersPage,
  medusaGet,
  testConnectionAndFetchStoreInfo,
  type MedusaCredentials,
} from '../lib/api-client'

// safeFetch (../lib relies on it) resolves DNS through url-guard's
// validateWebhookUrl. Stub that seam so tests are deterministic and offline;
// a dedicated test flips it to a private-address verdict.
const guard = vi.hoisted(() => ({ validateUrl: vi.fn() }))
vi.mock('@/lib/webhooks/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/webhooks/url-guard')>()
  return {
    ...actual,
    validateWebhookUrl: (...args: unknown[]) => guard.validateUrl(...args),
  }
})

const CREDS: MedusaCredentials = {
  storeUrl: 'https://backend.example.se',
  adminApiKey: 'sk_admin_test',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  guard.validateUrl.mockReset()
  guard.validateUrl.mockImplementation(async (rawUrl: string) => ({
    ok: true,
    hostname: new URL(rawUrl).hostname,
    resolvedAddresses: ['203.0.113.10'],
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('medusaGet: outbound URL guard', () => {
  it('happy path: Bearer auth, no redirect following, DNS check runs per request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ orders: [] }))

    await expect(medusaGet(CREDS, '/admin/orders', { limit: '1' })).resolves.toEqual({ orders: [] })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.example.se/admin/orders?limit=1')
    expect(init.redirect).toBe('manual')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_admin_test')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(guard.validateUrl).toHaveBeenCalledWith(url, undefined)
  })

  it('refuses a stored store_url that no longer normalises before any fetch', async () => {
    for (const storeUrl of ['http://backend.example.se', 'https://10.0.0.5', 'https://localhost:8080', 'not a url']) {
      const error = await medusaGet({ ...CREDS, storeUrl }, '/admin/orders').catch((e) => e)
      expect(error).toBeInstanceOf(MedusaApiError)
      expect((error as MedusaApiError).code).toBe(INVALID_STORE_URL_CODE)
      expect((error as MedusaApiError).status).toBe(0)
      expect((error as MedusaApiError).message).toMatch(/reconnect the store/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(guard.validateUrl).not.toHaveBeenCalled()
  })

  it('canonicalises a cosmetically different stored URL instead of refusing it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ orders: [] }))

    await medusaGet({ ...CREDS, storeUrl: 'https://Backend.Example.se/' }, '/admin/orders')

    expect(fetchMock.mock.calls[0][0]).toBe('https://backend.example.se/admin/orders')
  })

  it('refuses a public hostname that resolves to a private address, without retrying', async () => {
    guard.validateUrl.mockResolvedValue({
      ok: false,
      reason: 'private_address',
      detail: 'Resolved address 10.1.2.3 for backend.example.se is not publicly routable (private_address).',
    })

    const error = await medusaGet(CREDS, '/admin/orders').catch((e) => e)

    expect(error).toBeInstanceOf(MedusaApiError)
    expect((error as MedusaApiError).code).toBe(UNSAFE_STORE_URL_CODE)
    expect((error as MedusaApiError).message).toMatch(/10\.1\.2\.3/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(guard.validateUrl).toHaveBeenCalledTimes(1)
  })

  it('treats a redirect from the store as a failure, not a hop, and does not retry it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/' } }),
    )

    const error = await medusaGet(CREDS, '/admin/orders').catch((e) => e)

    expect(error).toBeInstanceOf(MedusaApiError)
    expect((error as MedusaApiError).code).toBe(UNSAFE_STORE_URL_CODE)
    expect((error as MedusaApiError).message).toMatch(/redirects are never followed/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 503 with backoff, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse({ orders: [] }))

    await expect(medusaGet(CREDS, '/admin/orders')).resolves.toEqual({ orders: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 401 and surfaces the status for revocation handling', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Invalid API key' }, 401))

    const error = await medusaGet(CREDS, '/admin/orders').catch((e) => e)
    expect(error).toBeInstanceOf(MedusaApiError)
    expect((error as MedusaApiError).status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('listOrdersPage', () => {
  it('requests the updated_at cursor, offset and page size, and returns pagination fields', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ orders: [{ id: 'order_1' }], count: 1, offset: 0, limit: MEDUSA_PAGE_SIZE }),
    )

    const page = await listOrdersPage(CREDS, { updatedAtMin: '2026-09-01T00:00:00.000Z', offset: 0 })

    expect(page.count).toBe(1)
    expect(page.orders).toHaveLength(1)
    const [url] = fetchMock.mock.calls[0] as [string]
    const parsed = new URL(url)
    expect(parsed.searchParams.get('updated_at[$gte]')).toBe('2026-09-01T00:00:00.000Z')
    expect(parsed.searchParams.get('limit')).toBe(String(MEDUSA_PAGE_SIZE))
    expect(parsed.searchParams.get('offset')).toBe('0')
  })
})

describe('testConnectionAndFetchStoreInfo', () => {
  it('uses the orders read scope as the credential check and best-effort reads store metadata', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ orders: [] })) // credential check
      .mockResolvedValueOnce(
        jsonResponse({ stores: [{ name: 'Butiken', supported_currencies: [{ currency_code: 'sek', is_default: true }] }] }),
      )

    const info = await testConnectionAndFetchStoreInfo(CREDS)

    expect(info.name).toBe('Butiken')
    expect(info.currency).toBe('SEK')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('still returns on a failed credential check path propagating the error, and swallows a failed store lookup', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ orders: [] })) // credential check succeeds
      .mockResolvedValueOnce(jsonResponse({ message: 'forbidden' }, 403)) // store lookup fails

    const info = await testConnectionAndFetchStoreInfo(CREDS)
    expect(info).toEqual({ name: null, currency: null })
  })

  it('propagates a failed credential check instead of a store lookup', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Invalid API key' }, 401))

    await expect(testConnectionAndFetchStoreInfo(CREDS)).rejects.toBeInstanceOf(MedusaApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
