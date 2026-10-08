import { sleep } from '@/lib/utils'
import { isUnsafeUrlError, safeFetch } from '@/lib/http/safe-fetch'
import type { MedusaOrder, MedusaStoreInfo } from '../types'

/**
 * Minimal Medusa v2 Admin API client for the order feed.
 *
 * Auth is a secret API key (Medusa Settings > API Key Management > Secret
 * keys), sent as HTTP Basic with the key as the username and an empty
 * password: `Authorization: Basic base64("sk_...:")`. Medusa answers 401 to
 * `Bearer sk_...` — verified against a live Medusa 2.15 store (2026-10-08);
 * the first version of this client used Bearer and could not have connected
 * to any store. Unlike WooCommerce
 * there is no query-string credential fallback: Medusa's Admin API does not
 * document one, and putting a secret key in a URL would log it in every
 * proxy/CDN access log between here and the merchant's host.
 *
 * The store URL is tenant input that the server connects to, and members can
 * write `medusa_connections.store_url` directly through PostgREST (bypassing
 * the connect route's normalisation), so every request here re-normalises
 * the stored URL and goes through `safeFetch`: public addresses only,
 * checked at request time, no redirects followed. The nightly cron runs
 * this under the service role, exactly the network position an SSRF would
 * want (mirrors the WooCommerce client's reasoning verbatim).
 *
 * Verified against a live Medusa 2.15 store (2026-10-08): auth, the
 * updated_at window filter, offset pagination and the order field list.
 */

/** HTTP Basic header for a Medusa secret API key (key as username, empty password). */
export function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
}

const REQUEST_TIMEOUT_MS = 30_000
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const RETRY_DELAYS_MS = [1_000, 3_000]
/** Medusa's documented Admin API page-size ceiling for list endpoints. */
export const MEDUSA_PAGE_SIZE = 100

export interface MedusaCredentials {
  storeUrl: string
  adminApiKey: string
}

export class MedusaApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for network-level failures. */
    readonly status: number,
    /** accounted_* error code for the invalid/unsafe-store-url cases, if any. */
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = 'MedusaApiError'
  }
}

/**
 * Whether an API error means the key itself is dead (deleted/revoked in the
 * merchant's Medusa admin), as opposed to a transient failure. Used to flip
 * a connection to status 'revoked' so the UI offers a reconnect instead of
 * the cron retrying forever.
 */
export function isRevokedCredentialsError(error: unknown): boolean {
  if (!(error instanceof MedusaApiError)) return false
  return error.status === 401 || error.status === 403
}

/**
 * Hostnames the server must never fetch: the store URL is user input probed
 * server-side, so loopback/link-local/private ranges and internal naming
 * conventions are refused outright (SSRF guard), same list as the
 * WooCommerce client.
 */
function isDisallowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h.includes(':')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
  }
  return false
}

/**
 * Normalize and validate a user-entered store URL to an https origin,
 * lowercased host, no trailing slash, no query/fragment/credentials, and no
 * private/internal hosts. Returns null for anything invalid, including
 * plain http (a Medusa backend not served over TLS is not a store we send a
 * secret API key to).
 */
export function normalizeStoreUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || url.search || url.hash) return null
  if (isDisallowedHost(url.hostname)) return null
  const path = url.pathname.replace(/\/+$/, '')
  return `https://${url.host.toLowerCase()}${path}`
}

export const INVALID_STORE_URL_CODE = 'accounted_invalid_store_url'
export const UNSAFE_STORE_URL_CODE = 'accounted_unsafe_store_url'

/**
 * Re-run the connect-time normalisation on the STORED store URL at use
 * time, same reasoning as the WooCommerce client: a member can PATCH
 * `store_url` straight into the row through PostgREST, so the database
 * value is not trusted to still be an https public-host origin.
 */
function storeOriginOf(creds: MedusaCredentials): string {
  const normalized = normalizeStoreUrl(creds.storeUrl)
  if (!normalized) {
    throw new MedusaApiError(
      `Medusa store URL is not a valid https store address (${creds.storeUrl}); reconnect the store`,
      0,
      INVALID_STORE_URL_CODE,
    )
  }
  return normalized
}

function buildUrl(creds: MedusaCredentials, path: string, params: Record<string, string>): string {
  const url = new URL(`${storeOriginOf(creds)}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

async function parseError(response: Response): Promise<MedusaApiError> {
  let detail = ''
  try {
    const body = (await response.json()) as { message?: string }
    detail = body.message ?? ''
  } catch {
    // Non-JSON error body; the status is enough.
  }
  return new MedusaApiError(`Medusa API ${response.status}${detail ? `: ${detail}` : ''}`, response.status)
}

/** GET an /admin path. Retries 429/5xx with a short backoff. */
export async function medusaGet<T>(
  creds: MedusaCredentials,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let response: Response
    try {
      // safeFetch: public address only (checked now, not at connect time),
      // no redirects. A 3xx from the store is a failure, never a hop.
      response = await safeFetch(buildUrl(creds, path, params), {
        headers: { Accept: 'application/json', Authorization: basicAuth(creds.adminApiKey) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      if (err instanceof MedusaApiError) throw err
      if (isUnsafeUrlError(err)) {
        throw new MedusaApiError(
          `Medusa store refused by outbound URL guard: ${err.detail}`,
          0,
          UNSAFE_STORE_URL_CODE,
        )
      }
      lastError = new MedusaApiError(
        `Medusa request failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
      )
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      throw lastError
    }

    if (response.ok) return (await response.json()) as T
    if (RETRYABLE_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
      lastError = await parseError(response)
      await sleep(RETRY_DELAYS_MS[attempt])
      continue
    }
    throw await parseError(response)
  }
  throw lastError instanceof Error ? lastError : new MedusaApiError('Medusa request failed', 0)
}

/**
 * Explicit field list, verified against a live Medusa 2.15 store. Medusa computes
 * order and line totals from the relations that are LOADED: a narrower list
 * (e.g. shipping_methods without its amount or adjustments) silently returns
 * wrong totals — shipping as 0, the original total without shipping. Hence
 * whole relations (`*items`, `*shipping_methods`, `*credit_lines` …) rather
 * than picked columns.
 */
const ORDER_FIELDS = [
  'id',
  'display_id',
  'status',
  'currency_code',
  'email',
  'created_at',
  'updated_at',
  'canceled_at',
  'original_total',
  'total',
  'tax_total',
  '*items',
  '*items.tax_lines',
  '*items.adjustments',
  '*shipping_methods',
  '*shipping_methods.tax_lines',
  '*shipping_methods.adjustments',
  '*credit_lines',
  '*payment_collections',
  '*payment_collections.payments',
  '*payment_collections.payments.refunds',
  '*shipping_address',
].join(',')

export interface ListOrdersOptions {
  /** ISO timestamp; orders updated at or after this instant. */
  updatedAtMin: string
  offset: number
}

export interface ListOrdersPage {
  orders: MedusaOrder[]
  count: number
  offset: number
  limit: number
}

/**
 * One page of orders updated at or after the cursor, oldest-updated first.
 * Medusa v2's Admin API paginates by offset/limit (no cursor token like
 * Shopify/WooCommerce), so the caller advances `offset` by MEDUSA_PAGE_SIZE
 * until `offset + orders.length >= count`.
 */
export async function listOrdersPage(
  creds: MedusaCredentials,
  options: ListOrdersOptions,
): Promise<ListOrdersPage> {
  const data = await medusaGet<{ orders: MedusaOrder[]; count: number; offset: number; limit: number }>(
    creds,
    '/admin/orders',
    {
      'updated_at[$gte]': options.updatedAtMin,
      order: 'updated_at',
      limit: String(MEDUSA_PAGE_SIZE),
      offset: String(options.offset),
      fields: ORDER_FIELDS,
    },
  )
  return { orders: data.orders, count: data.count, offset: data.offset, limit: data.limit }
}

/**
 * Verify credentials and read store metadata. GET /admin/orders?limit=1 is
 * the authoritative credential check (it exercises the read scope the feed
 * needs); the store name/currency lookup is best-effort.
 */
export async function testConnectionAndFetchStoreInfo(
  creds: MedusaCredentials,
): Promise<MedusaStoreInfo> {
  await medusaGet<unknown>(creds, '/admin/orders', { limit: '1' })

  const info: MedusaStoreInfo = { name: null, currency: null }
  try {
    const store = await medusaGet<{
      stores: Array<{ name?: string; supported_currencies?: Array<{ currency_code: string; is_default: boolean }> }>
    }>(creds, '/admin/stores', { limit: '1' })
    const s = store.stores?.[0]
    if (s?.name) info.name = s.name
    const defaultCurrency = s?.supported_currencies?.find((c) => c.is_default)
    if (defaultCurrency) info.currency = defaultCurrency.currency_code.toUpperCase()
  } catch {
    // Store metadata needs the same read scope; best-effort, the feed works without it.
  }
  return info
}
