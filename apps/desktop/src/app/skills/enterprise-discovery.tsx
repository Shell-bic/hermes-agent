import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { TextTab, TextTabMeta } from '@/components/ui/text-tab'
import type { EnterpriseSkillHubItem } from '@/global'
import { useI18n } from '@/i18n'
import { $enterprise, refreshEnterprisePolicy } from '@/store/enterprise'
import { dismissNotification, notify, notifyError } from '@/store/notifications'

import { PAGE_INSET_X } from '../layout-constants'

interface EnterpriseDiscoveryProps {
  authenticated: boolean
  onInstalled: () => Promise<void>
  query: string
  refreshKey: number
}

interface OperationError {
  code: string
  message: string
}

function errorInfo(error: unknown): OperationError {
  const value = error as { code?: unknown; message?: unknown }

  return {
    code: String(value?.code || 'enterprise_skill_hub_error'),
    message: String(value?.message || error || 'Enterprise Skill Hub request failed.')
  }
}

async function listAllEnterpriseSkills(): Promise<EnterpriseSkillHubItem[]> {
  const bridge = window.hermesDesktop.enterprise.skillHub
  const pageSize = 100
  const first = await bridge.list({ page: 1, pageSize })
  const items = [...first.items]
  const pages = Math.min(100, Math.ceil(first.total / Math.max(1, first.pageSize || pageSize)))

  for (let page = 2; page <= pages; page += 1) {
    const next = await bridge.list({ page, pageSize })
    items.push(...next.items)
  }

  return items
}

function policyClass(status: EnterpriseSkillHubItem['policyStatus']): string {
  return status === 'blocked' || status === 'restricted'
    ? 'bg-destructive/10 text-destructive'
    : 'bg-(--ui-bg-quinary) text-(--ui-text-tertiary)'
}

export function EnterpriseDiscovery({ authenticated, onInstalled, query, refreshKey }: EnterpriseDiscoveryProps) {
  const { t } = useI18n()
  const enterprise = useStore($enterprise)
  const [items, setItems] = useState<EnterpriseSkillHubItem[] | null>(null)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [operationErrors, setOperationErrors] = useState<Record<string, OperationError>>({})
  const [detail, setDetail] = useState<EnterpriseSkillHubItem | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [refreshingPolicy, setRefreshingPolicy] = useState(false)

  useEffect(() => {
    if (!authenticated) {
      setItems(null)
      setLoadError(null)

      return
    }

    let cancelled = false
    setLoading(true)
    setLoadError(null)
    void listAllEnterpriseSkills()
      .then(next => {
        if (!cancelled) {setItems(next)}
      })
      .catch(error => {
        if (!cancelled) {setLoadError(errorInfo(error).message)}
      })
      .finally(() => {
        if (!cancelled) {setLoading(false)}
      })

    return () => {
      cancelled = true
    }
  }, [authenticated, refreshKey])

  const categories = useMemo(() => {
    const counts = new Map<string, number>()

    for (const item of items || []) {
      const category = item.category || 'general'
      counts.set(category, (counts.get(category) || 0) + 1)
    }

    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [items])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()

    return (items || [])
      .filter(item => !activeCategory || (item.category || 'general') === activeCategory)
      .filter(item => {
        if (!needle) {return true}

        return [item.key, item.name, item.description, item.category, item.declaredVersion]
          .filter(Boolean)
          .some(value => String(value).toLocaleLowerCase().includes(needle))
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [activeCategory, items, query])

  async function refreshList(): Promise<void> {
    setItems(await listAllEnterpriseSkills())
  }

  async function handleRefreshPolicy(): Promise<void> {
    setRefreshingPolicy(true)

    try {
      await refreshEnterprisePolicy()
      await Promise.all([refreshList(), onInstalled()])
    } catch (error) {
      notifyError(error, t.skills.enterpriseLoadFailed)
    } finally {
      setRefreshingPolicy(false)
    }
  }

  async function refreshInstalledState(key: string): Promise<void> {
    const notificationId = `enterprise-skill-refresh:${key}`

    try {
      await Promise.all([refreshList(), onInstalled()])
      dismissNotification(notificationId)
    } catch (error) {
      notify({
        action: {
          label: t.skills.refresh,
          onClick: () => void refreshInstalledState(key)
        },
        id: notificationId,
        kind: 'warning',
        message: errorInfo(error).message,
        title: t.skills.enterpriseLoadFailed
      })
    }
  }

  async function showDetail(item: EnterpriseSkillHubItem): Promise<void> {
    setDetailLoading(true)

    try {
      setDetail(await window.hermesDesktop.enterprise.skillHub.detail(item.key))
    } catch (error) {
      notifyError(error, t.skills.enterpriseLoadFailed)
    } finally {
      setDetailLoading(false)
    }
  }

  async function install(item: EnterpriseSkillHubItem): Promise<void> {
    if (
      item.policyStatus === 'blocked' ||
      item.policyStatus === 'restricted' ||
      item.installState !== 'not-installed'
    ) {return}

    setInstalling(item.key)
    setOperationErrors(current => {
      const next = { ...current }
      delete next[item.key]

      return next
    })

    try {
      const result = await window.hermesDesktop.enterprise.skillHub.install({
        key: item.key,
        revision: item.currentRevision
      })

      setItems(current => current?.map(row => row.key === result.item.key ? result.item : row) ?? current)
      setDetail(current => current?.key === result.item.key ? result.item : current)
      notify({ kind: 'success', title: t.skills.enterpriseInstallSucceeded, message: item.name })
      void refreshInstalledState(item.key)
    } catch (error) {
      const info = errorInfo(error)
      setOperationErrors(current => ({ ...current, [item.key]: info }))

      if (info.code === 'package_revision_changed') {
        await refreshList().catch(() => undefined)
      }

      notifyError(error, t.skills.enterpriseInstallFailed(item.name))
    } finally {
      setInstalling(null)
    }
  }

  if (!authenticated) {
    return (
      <div className="grid h-full min-h-64 place-items-center px-6 text-center">
        <div className="max-w-md">
          <Codicon className="mx-auto text-(--ui-text-tertiary)" name="lock" size="1.5rem" />
          <h2 className="mt-3 text-sm font-semibold">{t.skills.enterpriseSignInTitle}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t.skills.enterpriseSignInDesc}</p>
        </div>
      </div>
    )
  }

  if (loading && !items) {
    return <div className="grid h-full place-items-center text-xs text-muted-foreground">{t.skills.loading}</div>
  }

  if (loadError) {
    return (
      <div className="grid h-full min-h-64 place-items-center px-6 text-center">
        <div className="max-w-md">
          <h2 className="text-sm font-semibold">{t.skills.enterpriseLoadFailed}</h2>
          <p className="mt-1 break-words text-xs leading-5 text-destructive">{loadError}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={`h-full overflow-y-auto py-3 ${PAGE_INSET_X}`}>
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)/20 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">
            {enterprise.policyRefreshStatus === 'stale'
              ? t.skills.enterprisePolicyStale
              : enterprise.policyRefreshStatus === 'failed'
                ? t.skills.enterprisePolicyFailed
                : enterprise.policyRefreshStatus === 'current'
                  ? t.skills.enterprisePolicyCurrent
                  : enterprise.policyRefreshStatus === 'refreshing'
                    ? t.skills.enterprisePolicyRefreshing
                    : t.skills.enterprisePolicyRefresh}
          </div>
          <div className={`mt-0.5 truncate text-[0.68rem] ${enterprise.policyRefreshError ? 'text-destructive' : 'text-(--ui-text-tertiary)'}`}>
            {enterprise.policyRefreshError || enterprise.policyVersion || enterprise.policyHash || '—'}
          </div>
        </div>
        <Button
          aria-label={refreshingPolicy ? t.skills.enterprisePolicyRefreshing : t.skills.enterprisePolicyRefresh}
          disabled={refreshingPolicy}
          onClick={() => void handleRefreshPolicy()}
          size="sm"
          type="button"
          variant="outline"
        >
          <Codicon name="refresh" size="0.875rem" spinning={refreshingPolicy} />
          {refreshingPolicy ? t.skills.enterprisePolicyRefreshing : t.skills.enterprisePolicyRefresh}
        </Button>
      </div>
      {categories.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          <TextTab active={activeCategory === null} onClick={() => setActiveCategory(null)}>
            {t.skills.all} <TextTabMeta>{items?.length || 0}</TextTabMeta>
          </TextTab>
          {categories.map(([category, count]) => (
            <TextTab
              active={activeCategory === category}
              key={category}
              onClick={() => setActiveCategory(activeCategory === category ? null : category)}
            >
              {category} <TextTabMeta>{count}</TextTabMeta>
            </TextTab>
          ))}
        </div>
      )}
      {visible.length === 0 ? (
        <div className="grid min-h-52 place-items-center text-center">
          <div>
            <div className="text-sm font-medium">{t.skills.noEnterpriseTitle}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t.skills.noEnterpriseDesc}</div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          {visible.map(item => {
            const denied = item.policyStatus === 'blocked' || item.policyStatus === 'restricted'
            const installed = item.installState === 'installed'
            const updateAvailable = item.installState === 'update-not-supported'

            const actionLabel = installing === item.key
              ? t.skills.enterpriseInstalling
              : installed
                ? t.skills.enterpriseInstalled
                : updateAvailable
                  ? t.skills.enterpriseUpdateAvailable
                  : t.skills.enterpriseInstall

            return (
              <article
                className="flex min-h-48 min-w-0 flex-col rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)/25 p-3"
                key={item.key}
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <div className="grid size-8 shrink-0 place-items-center rounded-md bg-violet-500/10 text-violet-600 dark:text-violet-300">
                    <Codicon name="organization" size="1rem" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="min-w-0 truncate text-sm font-semibold">{item.name}</h3>
                      <Badge className={policyClass(item.policyStatus)} title={item.policyReason || undefined}>
                        {t.skills.policyStatus[item.policyStatus]}
                      </Badge>
                    </div>
                    <div className="mt-1 text-[0.68rem] text-(--ui-text-tertiary)">
                      {t.skills.enterpriseRevision(item.currentRevision)} · {t.skills.enterpriseFiles(item.fileCount)}
                    </div>
                  </div>
                </div>
                <p className="mt-3 line-clamp-3 text-xs leading-5 text-muted-foreground">
                  {item.description || t.skills.noDescription}
                </p>
                {(denied || updateAvailable || operationErrors[item.key]) && (
                  <p className={`mt-2 text-[0.7rem] leading-4 ${operationErrors[item.key] ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {operationErrors[item.key]?.message ||
                      (denied ? item.policyReason : t.skills.enterpriseUpdateUnsupported)}
                  </p>
                )}
                <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                  <Badge variant="outline">{item.category || 'general'}</Badge>
                  <div className="flex items-center gap-1.5">
                    <Button
                      aria-label={t.skills.showDetails(item.name)}
                      disabled={detailLoading}
                      onClick={() => void showDetail(item)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <Codicon name="info" size="0.875rem" spinning={detailLoading} />
                    </Button>
                    <Button
                      aria-label={`${actionLabel} ${item.name}`}
                      disabled={denied || installed || updateAvailable || installing === item.key}
                      onClick={() => void install(item)}
                      size="sm"
                      type="button"
                      variant={installed ? 'ghost' : 'default'}
                    >
                      {actionLabel}
                    </Button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      <Sheet onOpenChange={open => !open && setDetail(null)} open={Boolean(detail)}>
        <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
          {detail && (
            <>
              <SheetHeader className="border-b border-(--ui-stroke-secondary) pr-11">
                <SheetTitle>{detail.name}</SheetTitle>
                <SheetDescription>{detail.description || t.skills.noDescription}</SheetDescription>
              </SheetHeader>
              <div className="space-y-3 px-4 py-4 text-xs">
                <div className="flex flex-wrap gap-2">
                  <Badge className={policyClass(detail.policyStatus)}>{t.skills.policyStatus[detail.policyStatus]}</Badge>
                  <Badge variant="outline">{detail.category || 'general'}</Badge>
                  <Badge variant="outline">{t.skills.enterpriseRevision(detail.currentRevision)}</Badge>
                  <Badge variant="outline">{t.skills.enterpriseFiles(detail.fileCount)}</Badge>
                </div>
                {detail.declaredVersion && <p className="text-muted-foreground">Version {detail.declaredVersion}</p>}
                {detail.policyReason && <p className="leading-5 text-muted-foreground">{detail.policyReason}</p>}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
