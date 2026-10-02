'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { useFormat } from '@/lib/hooks/use-format'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { History, KeyRound, RefreshCw, ShoppingBag, Unlink } from 'lucide-react'
import {
  medusaRequest,
  syncSummary,
  MEDUSA_CONNECT_TIMEOUT_MS,
  MEDUSA_SYNC_TIMEOUT_MS,
  type MedusaSyncPayload,
} from '../lib/settings-actions'
import { MAX_BACKFILL_YEARS } from '../types'
import type { MedusaConnectionStatus, MedusaStatusResponse } from '../types'

const STATUS_VARIANT: Record<MedusaConnectionStatus['status'], 'destructive' | 'warning' | null> = {
  // Active is the normal state: muted text, not a chip (chips mark exceptions).
  active: null,
  revoked: 'warning',
  error: 'destructive',
}

/** Bounds of the backfill date picker, mirroring parseBackfillFrom on the server. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function earliestBackfillDay(): string {
  const floor = new Date()
  floor.setUTCFullYear(floor.getUTCFullYear() - MAX_BACKFILL_YEARS)
  return isoDay(floor)
}

export default function MedusaSettingsPanel() {
  const t = useTranslations('medusa')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { formatDateLong } = useFormat()

  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [connections, setConnections] = useState<MedusaConnectionStatus[]>([])
  const [storeUrl, setStoreUrl] = useState('')
  const [adminApiKey, setAdminApiKey] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null)
  const [backfillFrom, setBackfillFrom] = useState<Record<string, string>>({})
  const [backfillingId, setBackfillingId] = useState<string | null>(null)

  const failureCopy = { timeout: t('action_timeout'), network: t('action_network') }

  const loadStatus = useCallback(async () => {
    // A failed status read must never render as "not configured" (same
    // reasoning as the WooCommerce/Stripe panels).
    const result = await medusaRequest<MedusaStatusResponse>({
      url: '/api/extensions/ext/medusa/status',
      method: 'GET',
      locale,
    })
    setLoading(false)
    if (!result.ok || !result.data) {
      setLoadFailed(true)
      return
    }
    setLoadFailed(false)
    setConfigured(result.data.configured)
    setConnections(result.data.connections ?? (result.data.connection ? [result.data.connection] : []))
  }, [locale])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  function retryLoadStatus() {
    setLoading(true)
    void loadStatus()
  }

  async function handleConnect() {
    if (connecting) return
    setConnecting(true)
    try {
      const result = await medusaRequest({
        url: '/api/extensions/ext/medusa/manual-connect',
        body: { store_url: storeUrl, admin_api_key: adminApiKey },
        locale,
        timeoutMs: MEDUSA_CONNECT_TIMEOUT_MS,
      })
      if (!result.ok) {
        toast({
          title: t('connect_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('connected_toast_title'), description: t('connected_toast_description') })
      setStoreUrl('')
      setAdminApiKey('')
      await loadStatus()
    } finally {
      setConnecting(false)
    }
  }

  function showSyncOutcome(
    payload: MedusaSyncPayload | null | undefined,
    doneTitle: string,
    failedTitle: string,
  ) {
    const summary = syncSummary(payload ?? null)
    if (summary.reason === 'revoked') {
      toast({ title: failedTitle, description: t('sync_revoked'), variant: 'destructive' })
    } else if (summary.reason === 'partial') {
      toast({ title: t('sync_partial_title'), description: t('sync_partial', summary.values) })
    } else if (summary.reason === 'empty') {
      toast({ title: doneTitle, description: t('sync_done_empty') })
    } else if (summary.reason === 'errors') {
      toast({ title: doneTitle, description: t('sync_done_feed_errors', summary.values) })
    } else if (summary.reason === 'feed') {
      toast({ title: doneTitle, description: t('sync_done_feed', summary.values) })
    } else {
      toast({ title: doneTitle })
    }
  }

  async function handleSyncNow(connectionId: string) {
    if (busyId) return
    setBusyId(connectionId)
    try {
      const result = await medusaRequest<MedusaSyncPayload>({
        url: '/api/extensions/ext/medusa/sync',
        body: { connection_id: connectionId },
        locale,
        timeoutMs: MEDUSA_SYNC_TIMEOUT_MS,
      })
      if (!result.ok) {
        toast({
          title: t('sync_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      showSyncOutcome(result.data, t('sync_done_title'), t('sync_failed_title'))
      await loadStatus()
    } finally {
      setBusyId(null)
    }
  }

  async function handleBackfill(connectionId: string) {
    if (busyId) return
    const from = backfillFrom[connectionId] ?? ''
    if (!from) {
      toast({
        title: t('backfill_failed_title'),
        description: t('backfill_missing_date'),
        variant: 'destructive',
      })
      return
    }
    setBusyId(connectionId)
    setBackfillingId(connectionId)
    try {
      const result = await medusaRequest<MedusaSyncPayload>({
        url: '/api/extensions/ext/medusa/backfill',
        body: { from, connection_id: connectionId },
        locale,
        timeoutMs: MEDUSA_SYNC_TIMEOUT_MS,
      })
      if (!result.ok) {
        toast({
          title: t('backfill_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      showSyncOutcome(result.data, t('backfill_done_title'), t('backfill_failed_title'))
      await loadStatus()
    } finally {
      setBackfillingId(null)
      setBusyId(null)
    }
  }

  async function handleToggleTransactionSync(connectionId: string, enabled: boolean) {
    if (busyId) return
    setBusyId(connectionId)
    try {
      const result = await medusaRequest({
        url: '/api/extensions/ext/medusa/transaction-sync',
        body: { enabled, connection_id: connectionId },
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('transaction_sync_toggle_failed'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      toast({ title: enabled ? t('transaction_sync_enabled_toast') : t('transaction_sync_disabled_toast') })
      await loadStatus()
    } finally {
      setBusyId(null)
    }
  }

  async function handleDisconnect(connectionId: string) {
    if (busyId) return
    setBusyId(connectionId)
    try {
      const result = await medusaRequest({
        url: '/api/extensions/ext/medusa/disconnect',
        method: 'DELETE',
        body: { connection_id: connectionId },
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('disconnect_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('disconnected_toast_title'), description: t('disconnected_toast_description') })
      setConfirmDisconnectId(null)
      await loadStatus()
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-10 w-40" />
        </CardContent>
      </Card>
    )
  }

  if (loadFailed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <p className="text-sm text-destructive">{t('load_failed')}</p>
          <Button variant="outline" size="sm" onClick={retryLoadStatus}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {tCommon('retry')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-sm text-muted-foreground">{t('not_configured')}</p>
        </CardContent>
      </Card>
    )
  }

  const hasActive = connections.some((c) => c.status === 'active')

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 pt-0">
        <p className="text-sm text-muted-foreground">{t('description')}</p>

        {connections.map((connection) => {
          const isActive = connection.status === 'active'
          const busy = busyId === connection.id
          const backfilling = backfillingId === connection.id
          const syncing = busy && !backfilling
          const blocked = busyId !== null
          return (
            <div key={connection.id} className="space-y-4 rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <ShoppingBag className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {connection.store_name || connection.store_url || t('unnamed_store')}
                      </span>
                      {STATUS_VARIANT[connection.status] ? (
                        <Badge variant={STATUS_VARIANT[connection.status] ?? undefined}>
                          {t(`status_${connection.status}`)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t(`status_${connection.status}`)}</span>
                      )}
                    </div>
                    {connection.store_name && (
                      <p className="mt-1 text-sm text-muted-foreground">{connection.store_url}</p>
                    )}
                    {isActive && connection.connected_at && (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t('connected_since', { date: formatDateLong(connection.connected_at) })}
                      </p>
                    )}
                    {connection.error_message && (
                      <p className="mt-1 text-sm text-destructive">{connection.error_message}</p>
                    )}
                  </div>
                </div>
                {isActive &&
                  (confirmDisconnectId === connection.id ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDisconnect(connection.id)}
                        disabled={blocked}
                      >
                        {t('disconnect_confirm')}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setConfirmDisconnectId(null)} disabled={blocked}>
                        {t('cancel')}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => handleSyncNow(connection.id)} disabled={blocked} loading={syncing}>
                        {!syncing && <RefreshCw className="mr-2 h-4 w-4" />}
                        {syncing ? t('syncing') : t('sync_now')}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setConfirmDisconnectId(connection.id)} disabled={blocked}>
                        <Unlink className="mr-2 h-4 w-4" />
                        {t('disconnect')}
                      </Button>
                    </div>
                  ))}
              </div>

              {isActive && (
                <div className="flex flex-wrap items-start justify-between gap-4 border-t border-border pt-4">
                  <div className="min-w-0 max-w-prose space-y-1">
                    <p className="text-sm font-medium">{t('transaction_sync_title')}</p>
                    <p className="text-sm text-muted-foreground">{t('transaction_sync_description')}</p>
                    {connection.transaction_sync_enabled ? (
                      <p className="text-xs text-muted-foreground">
                        {connection.last_order_synced_at
                          ? t('transaction_sync_last_synced', { date: formatDateLong(connection.last_order_synced_at) })
                          : t('transaction_sync_never_synced')}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t('transaction_sync_backfill_note')}</p>
                    )}
                  </div>
                  <Switch
                    checked={connection.transaction_sync_enabled}
                    onCheckedChange={(enabled) => handleToggleTransactionSync(connection.id, enabled)}
                    disabled={blocked}
                    aria-label={t('transaction_sync_title')}
                  />
                </div>
              )}

              {isActive && (
                <div className="space-y-4 border-t border-border pt-4">
                  <div className="min-w-0 max-w-prose space-y-1">
                    <p className="text-sm font-medium">{t('backfill_title')}</p>
                    <p className="text-sm text-muted-foreground">{t('backfill_description')}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Input
                      type="date"
                      className="w-48"
                      value={backfillFrom[connection.id] ?? ''}
                      min={earliestBackfillDay()}
                      max={isoDay(new Date())}
                      onChange={(event) => setBackfillFrom((prev) => ({ ...prev, [connection.id]: event.target.value }))}
                      aria-label={t('backfill_from_label')}
                      disabled={blocked}
                    />
                    <Button variant="outline" size="sm" onClick={() => handleBackfill(connection.id)} disabled={blocked} loading={backfilling}>
                      {!backfilling && <History className="mr-2 h-4 w-4" />}
                      {backfilling ? t('backfill_running') : t('backfill_submit')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        <div className="space-y-4">
          {hasActive && <p className="text-sm font-medium">{t('add_store')}</p>}
          <p className="text-sm text-muted-foreground">{t('manual_hint')}</p>
          <div className="space-y-2">
            <Label htmlFor="medusa-store-url">{t('store_url_label')}</Label>
            <Input
              id="medusa-store-url"
              type="url"
              inputMode="url"
              placeholder="https://backend.exempel.se"
              value={storeUrl}
              onChange={(e) => setStoreUrl(e.target.value)}
              disabled={connecting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="medusa-admin-api-key">{t('admin_api_key_label')}</Label>
            <Input
              id="medusa-admin-api-key"
              type="password"
              autoComplete="off"
              placeholder="sk_..."
              value={adminApiKey}
              onChange={(e) => setAdminApiKey(e.target.value)}
              disabled={connecting}
            />
          </div>
          <Button onClick={handleConnect} disabled={!storeUrl || !adminApiKey} loading={connecting}>
            {!connecting && <KeyRound className="mr-2 h-4 w-4" />}
            {connecting ? t('connecting') : t('connect')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
