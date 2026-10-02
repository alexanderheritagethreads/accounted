import { NextResponse } from 'next/server'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { guardSandbox, sandboxBlockedResponse } from '@/lib/sandbox/guard'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { backfillDateErrorMessage, parseBackfillFrom } from '@/lib/feed-sync/cursor-window'
import { isMedusaConfigured, encryptCredential } from './lib/credentials'
import { normalizeStoreUrl, testConnectionAndFetchStoreInfo } from './lib/api-client'
import { syncMedusaOrders } from './lib/order-sync'
import { MAX_BACKFILL_YEARS } from './types'
import type { MedusaConnection, MedusaConnectionStatus, MedusaStatusResponse } from './types'

/**
 * Medusa extension API routes.
 *
 * Narrower than the WooCommerce routes: Medusa has no OAuth handshake (see
 * index.ts), so there is only /manual-connect, no /connect + /callback +
 * /return pending-pair. Everything else (status/sync/backfill/transaction-
 * sync/disconnect) mirrors the WooCommerce route-for-route, including the
 * guard order (auth -> sandbox/capability -> rate limit -> validate ->
 * execute) and the service-role boundary (decrypting the stored key and
 * running the sync both need the service client; member-session calls never
 * touch the encrypted column).
 */

const RATE_LIMIT_CONNECT = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_DISCONNECT = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_SYNC = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_BACKFILL = { maxRequests: 5, windowMs: 60_000 }

/** Wall clock a single manual run may spend; same budget as the WooCommerce sync. */
const MANUAL_SYNC_BUDGET_MS = 240_000

const NOT_CONFIGURED_MESSAGE = 'Medusa-integrationen är inte konfigurerad på den här installationen.'

const STATUS_COLUMNS =
  'id, status, store_url, store_name, currency, error_message, connected_at, transaction_sync_enabled, last_order_synced_at'

type AuthedContext = {
  supabase: ExtensionContext['supabase']
  userId: string
  isAnonymous: boolean
  companyId: string
}

/** Shared auth preamble: cookie user + company context, or an error response. */
async function requireUserAndCompany(
  ctx: ExtensionContext | undefined,
): Promise<AuthedContext | NextResponse> {
  const supabase = ctx?.supabase ?? (await (await import('@/lib/supabase/server')).createClient())
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!ctx?.companyId) {
    return NextResponse.json({ error: 'Company context required' }, { status: 400 })
  }
  return {
    supabase,
    userId: user.id,
    isAnonymous: Boolean(user.is_anonymous),
    companyId: ctx.companyId,
  }
}

/** Sandbox users never reach external stores; the feed is a paid capability. */
async function guardConnectPreconditions(auth: AuthedContext): Promise<NextResponse | null> {
  if (auth.isAnonymous) return sandboxBlockedResponse()
  const sandboxBlocked = await guardSandbox(auth.supabase, auth.companyId)
  if (sandboxBlocked) return sandboxBlocked
  return requireCapability(auth.supabase, auth.companyId, CAPABILITY.medusa_sync)
}

/**
 * Existing-connection preflight: 409 when this store is already actively
 * connected to any company. One connection flow, so unlike WooCommerce
 * there is no pending-handshake branch to supersede.
 */
async function blockExistingActive(auth: AuthedContext, storeUrl: string): Promise<NextResponse | null> {
  const { data: existing } = await auth.supabase
    .from('medusa_connections')
    .select('id')
    .eq('store_url', storeUrl)
    .eq('status', 'active')
    .limit(1)
  if (existing && existing.length > 0) {
    return NextResponse.json(
      { error: 'Butiken är redan ansluten. Koppla från den först om du vill ansluta om den.' },
      { status: 409 },
    )
  }
  return null
}

export const medusaApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET',
    path: '/status',
    handler: async (_request: Request, ctx?: ExtensionContext) => {
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const { data: rows } = await auth.supabase
        .from('medusa_connections')
        .select(STATUS_COLUMNS)
        .eq('company_id', auth.companyId)
        .order('created_at', { ascending: false })
        .limit(25)

      const active = (rows ?? []).filter((r) => r.status === 'active')
      const listed = active.length > 0 ? active : rows?.[0] ? [rows[0]] : []
      const payload: MedusaStatusResponse = {
        configured: isMedusaConfigured(),
        connection: (listed[0] as MedusaConnectionStatus | undefined) ?? null,
        connections: listed as MedusaConnectionStatus[],
      }
      return NextResponse.json(payload)
    },
  },
  {
    method: 'POST',
    path: '/manual-connect',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const log = ctx?.log ?? console
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const blocked = await guardConnectPreconditions(auth)
      if (blocked) return blocked

      const rl = await checkRateLimit({
        prefix: 'medusa:connect',
        identifier: auth.userId,
        ...RATE_LIMIT_CONNECT,
      })
      if (!rl.ok) return rl.response!

      if (!isMedusaConfigured()) {
        return NextResponse.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 503 })
      }

      const body = (await request.json().catch(() => ({}))) as {
        store_url?: unknown
        admin_api_key?: unknown
      }
      const storeUrl = typeof body.store_url === 'string' ? normalizeStoreUrl(body.store_url) : null
      const adminApiKey = typeof body.admin_api_key === 'string' ? body.admin_api_key.trim() : ''
      if (!storeUrl) {
        return NextResponse.json(
          { error: 'Ange butikens Medusa-adress som en giltig https-URL.' },
          { status: 400 },
        )
      }
      if (!adminApiKey) {
        return NextResponse.json({ error: 'Ange en Medusa secret API-nyckel.' }, { status: 400 })
      }

      const conflict = await blockExistingActive(auth, storeUrl)
      if (conflict) return conflict

      // Verify before storing: a typo'd key must fail here, not at 03:45.
      let storeInfo
      try {
        storeInfo = await testConnectionAndFetchStoreInfo({ storeUrl, adminApiKey })
      } catch (probeError) {
        log.warn('[medusa] Manual credential probe failed', {
          companyId: auth.companyId,
          message: probeError instanceof Error ? probeError.message : String(probeError),
        })
        return NextResponse.json(
          {
            error:
              'Kunde inte ansluta till Medusa-butiken med den angivna nyckeln. Kontrollera adressen och att nyckeln har läsrättighet till /admin/orders.',
          },
          { status: 400 },
        )
      }

      // The key was typed in under this user's session; company_id/user_id
      // come from the authed context, never from the body. The order cursor
      // is seeded with the connection moment: orders placed before connecting
      // are already in the books from the bank side (same reasoning as the
      // WooCommerce manual connect) — older history is an explicit backfill.
      const connectedAt = new Date().toISOString()
      const { data: created, error: insertError } = await createServiceClientNoCookies()
        .from('medusa_connections')
        .insert({
          company_id: auth.companyId,
          user_id: auth.userId,
          store_url: storeUrl,
          store_name: storeInfo.name,
          currency: storeInfo.currency,
          admin_api_key_encrypted: encryptCredential(adminApiKey),
          status: 'active',
          connected_at: connectedAt,
          last_order_synced_at: connectedAt,
          transaction_sync_enabled: true,
        })
        .select('id, store_url')
        .single()

      if (insertError || !created) {
        const isConflict = insertError?.code === '23505'
        log.error('[medusa] Failed to create connection', {
          message: insertError?.message,
          code: insertError?.code,
          companyId: auth.companyId,
        })
        return NextResponse.json(
          {
            error: isConflict
              ? 'Butiken är redan ansluten till ett företag.'
              : 'Kunde inte spara anslutningen. Försök igen.',
          },
          { status: isConflict ? 409 : 500 },
        )
      }

      if (ctx?.emit) {
        try {
          await ctx.emit({
            type: 'medusa.connected',
            payload: {
              connectionId: created.id,
              storeUrl: created.store_url,
              userId: auth.userId,
              companyId: auth.companyId,
            },
          })
        } catch {
          // Audit event failure must not block the connect itself.
        }
      }

      return NextResponse.json({ success: true, connection_id: created.id })
    },
  },
  {
    method: 'POST',
    path: '/sync',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const log = ctx?.log ?? console
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const capabilityBlocked = await requireCapability(auth.supabase, auth.companyId, CAPABILITY.medusa_sync)
      if (capabilityBlocked) return capabilityBlocked

      const rl = await checkRateLimit({ prefix: 'medusa:sync', identifier: auth.userId, ...RATE_LIMIT_SYNC })
      if (!rl.ok) return rl.response!

      const body = (await request.json().catch(() => ({}))) as { connection_id?: string }
      const serviceClient = createServiceClientNoCookies()
      let query = serviceClient
        .from('medusa_connections')
        .select('*')
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
      if (body.connection_id) query = query.eq('id', body.connection_id)
      const { data: connections } = await query.order('last_order_synced_at', {
        ascending: true,
        nullsFirst: true,
      })

      if (!connections || connections.length === 0) {
        return NextResponse.json({ error: 'Ingen ansluten Medusa-butik.' }, { status: 404 })
      }

      try {
        const deadlineMs = Date.now() + MANUAL_SYNC_BUDGET_MS
        const results: Array<{
          connection_id: string
          store_url: string
          summary: Awaited<ReturnType<typeof syncMedusaOrders>>
        }> = []
        let skipped = 0
        for (const connection of connections as MedusaConnection[]) {
          if (Date.now() >= deadlineMs) {
            skipped += 1
            continue
          }
          const summary = await syncMedusaOrders(serviceClient, connection, undefined, deadlineMs)
          results.push({ connection_id: connection.id, store_url: connection.store_url, summary })
        }
        return NextResponse.json({
          success: true,
          results,
          skipped,
          transactions: results[results.length - 1]?.summary ?? null,
        })
      } catch (error) {
        log.error('[medusa] Manual sync failed', {
          message: error instanceof Error ? error.message : String(error),
        })
        return NextResponse.json({ error: 'Synkroniseringen misslyckades. Försök igen.' }, { status: 502 })
      }
    },
  },
  {
    method: 'POST',
    path: '/backfill',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const log = ctx?.log ?? console
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const capabilityBlocked = await requireCapability(auth.supabase, auth.companyId, CAPABILITY.medusa_sync)
      if (capabilityBlocked) return capabilityBlocked

      const rl = await checkRateLimit({
        prefix: 'medusa:backfill',
        identifier: auth.userId,
        ...RATE_LIMIT_BACKFILL,
      })
      if (!rl.ok) return rl.response!

      const body = (await request.json().catch(() => ({}))) as { from?: unknown; connection_id?: unknown }
      const parsed = parseBackfillFrom(body.from, MAX_BACKFILL_YEARS)
      if ('error' in parsed) {
        return NextResponse.json(
          { error: backfillDateErrorMessage(parsed.error, MAX_BACKFILL_YEARS) },
          { status: 400 },
        )
      }

      const serviceClient = createServiceClientNoCookies()
      let query = serviceClient
        .from('medusa_connections')
        .select('*')
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
      if (typeof body.connection_id === 'string') query = query.eq('id', body.connection_id)
      const { data: connections } = await query.limit(2)

      if (!connections || connections.length === 0) {
        return NextResponse.json({ error: 'Ingen ansluten Medusa-butik.' }, { status: 404 })
      }
      if (connections.length > 1) {
        return NextResponse.json(
          { error: 'Flera butiker är anslutna. Ange vilken butik som ska hämtas (connection_id).' },
          { status: 400 },
        )
      }
      const connection = connections[0] as MedusaConnection

      const { error: cursorError } = await auth.supabase
        .from('medusa_connections')
        .update({ last_order_synced_at: parsed.iso, error_message: null })
        .eq('id', connection.id)
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
      if (cursorError) {
        log.error('[medusa] Failed to move order cursor for backfill', {
          message: cursorError.message,
          connection_id: connection.id,
        })
        return NextResponse.json({ error: 'Kunde inte spara startdatumet. Försök igen.' }, { status: 500 })
      }

      try {
        const summary = await syncMedusaOrders(
          serviceClient,
          { ...connection, last_order_synced_at: parsed.iso },
          undefined,
          Date.now() + MANUAL_SYNC_BUDGET_MS,
        )
        return NextResponse.json({ success: true, from: parsed.iso, connection_id: connection.id, transactions: summary })
      } catch (error) {
        log.error('[medusa] Backfill sync failed', {
          message: error instanceof Error ? error.message : String(error),
          connection_id: connection.id,
        })
        return NextResponse.json({ error: 'Synkroniseringen misslyckades. Försök igen.' }, { status: 502 })
      }
    },
  },
  {
    method: 'POST',
    path: '/transaction-sync',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const capabilityBlocked = await requireCapability(auth.supabase, auth.companyId, CAPABILITY.medusa_sync)
      if (capabilityBlocked) return capabilityBlocked

      const rl = await checkRateLimit({
        prefix: 'medusa:transaction-sync-toggle',
        identifier: auth.userId,
        ...RATE_LIMIT_SYNC,
      })
      if (!rl.ok) return rl.response!

      const body = (await request.json().catch(() => ({}))) as { enabled?: unknown; connection_id?: string }
      if (typeof body.enabled !== 'boolean') {
        return NextResponse.json({ error: 'enabled måste vara true eller false.' }, { status: 400 })
      }

      let updateQuery = auth.supabase
        .from('medusa_connections')
        .update({ transaction_sync_enabled: body.enabled })
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
      if (body.connection_id) updateQuery = updateQuery.eq('id', body.connection_id)
      const { data: updated, error: updateError } = await updateQuery.select('id')

      if (updateError) {
        return NextResponse.json({ error: 'Kunde inte spara inställningen. Försök igen.' }, { status: 500 })
      }
      if (!updated || updated.length === 0) {
        return NextResponse.json({ error: 'Ingen ansluten Medusa-butik.' }, { status: 404 })
      }
      return NextResponse.json({ success: true, enabled: body.enabled })
    },
  },
  {
    method: 'DELETE',
    path: '/disconnect',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const log = ctx?.log ?? console
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const rl = await checkRateLimit({
        prefix: 'medusa:disconnect',
        identifier: auth.userId,
        ...RATE_LIMIT_DISCONNECT,
      })
      if (!rl.ok) return rl.response!

      const body = (await request.json().catch(() => ({}))) as { connection_id?: string }
      const base = auth.supabase.from('medusa_connections').select('id, status, store_url').eq('company_id', auth.companyId)
      const query = body.connection_id
        ? base.eq('id', body.connection_id).limit(1)
        : base.neq('status', 'revoked').order('created_at', { ascending: false }).limit(1)
      const { data: rows, error: findError } = await query
      const connection = rows?.[0]

      if (findError || !connection) {
        return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
      }

      // There is no remote revoke API: the merchant's secret key lives in
      // their own Medusa admin and only they can delete it there. We drop
      // our copy outright (nothing reads it after revoke); the audit row
      // keeps store_url and the connect/disconnect timestamps.
      const { error: updateError } = await auth.supabase
        .from('medusa_connections')
        .update({
          status: 'revoked',
          admin_api_key_encrypted: null,
          disconnected_at: new Date().toISOString(),
        })
        .eq('id', connection.id)
        .eq('company_id', auth.companyId)

      if (updateError) {
        log.error('[medusa] Failed to mark connection revoked', {
          message: updateError.message,
          connection_id: connection.id,
        })
        return NextResponse.json({ error: 'Kunde inte koppla från. Försök igen.' }, { status: 500 })
      }

      if (ctx?.emit) {
        try {
          await ctx.emit({
            type: 'medusa.disconnected',
            payload: {
              connectionId: connection.id,
              storeUrl: connection.store_url ?? null,
              reason: 'user',
              userId: auth.userId,
              companyId: auth.companyId,
            },
          })
        } catch {
          // Audit event failure must not block the disconnect itself.
        }
      }

      return NextResponse.json({ success: true })
    },
  },
]
