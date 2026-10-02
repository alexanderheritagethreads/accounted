/**
 * The Medusa settings panel's server calls, each classified into exactly one
 * outcome. Same doctrine as the WooCommerce panel's settings-actions: never
 * throw, one toast sentence per click, and the classification lives outside
 * the component because component logic has no tests in this repo.
 */

import {
  panelRequest,
  type PanelRequestOptions,
  type PanelRequestResult,
} from '@/lib/browser/panel-request'

/** Deadline for the quick calls (status, toggle, disconnect). */
export const MEDUSA_ACTION_TIMEOUT_MS = 15_000
/** Connect probes the merchant's Medusa host; generous but bounded. */
export const MEDUSA_CONNECT_TIMEOUT_MS = 30_000
/** "Synka nu" / "Hämta äldre ordrar": the route's own ceiling plus margin. */
export const MEDUSA_SYNC_TIMEOUT_MS = 310_000

export type MedusaRequestResult<T> = PanelRequestResult<T>
export type MedusaRequestOptions = PanelRequestOptions

export { serverErrorMessage } from '@/lib/browser/panel-request'

/** Call one of the panel's endpoints and report exactly why it failed. */
export function medusaRequest<T>(options: MedusaRequestOptions): Promise<MedusaRequestResult<T>> {
  return panelRequest<T>({ timeoutMs: MEDUSA_ACTION_TIMEOUT_MS, ...options })
}

/** Success body of POST /api/extensions/ext/medusa/sync. */
export interface MedusaSyncPayload {
  success?: boolean
  /** `MedusaSyncSummary` from lib/order-sync.ts, over the wire. */
  transactions?: {
    fetched?: number
    inserted?: number
    updated?: number
    unchanged?: number
    errors?: number
    revoked?: boolean
    deadlineReached?: boolean
  } | null
}

type SyncCounts = { fetched: number; imported: number }

export type MedusaSyncSummary =
  | { reason: 'revoked' }
  | { reason: 'empty' }
  | { reason: 'partial'; values: SyncCounts & { errors: number } }
  | { reason: 'errors'; values: SyncCounts & { errors: number } }
  | { reason: 'feed'; values: SyncCounts }
  | { reason: 'unknown' }

/** Turn the sync route's success body into the single sentence the user gets. */
export function syncSummary(payload: MedusaSyncPayload | null): MedusaSyncSummary {
  const summary = payload?.transactions
  if (!summary) return { reason: 'unknown' }
  if (summary.revoked === true) return { reason: 'revoked' }
  if (typeof summary.fetched !== 'number') return { reason: 'unknown' }

  const fetched = summary.fetched
  const imported = typeof summary.inserted === 'number' ? summary.inserted : 0
  const errors = typeof summary.errors === 'number' ? summary.errors : 0

  if (summary.deadlineReached === true) {
    return { reason: 'partial', values: { fetched, imported, errors } }
  }
  if (fetched === 0) return { reason: 'empty' }
  if (errors > 0) return { reason: 'errors', values: { fetched, imported, errors } }
  return { reason: 'feed', values: { fetched, imported } }
}
