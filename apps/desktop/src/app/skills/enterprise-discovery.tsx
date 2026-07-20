import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { TextTab, TextTabMeta } from '@/components/ui/text-tab'
import type { EnterpriseSkillHubItem } from '@/global'
import { useI18n } from '@/i18n'
import { $enterprise, refreshEnterprisePolicy } from '@/store/enterprise'
import { dismissNotification, notify } from '@/store/notifications'

import { PAGE_INSET_X } from '../layout-constants'

interface EnterpriseDiscoveryProps {
  authenticated: boolean
  onInstalled: () => Promise<void>
  query: string
  refreshKey: number
}

interface OperationError {
  errorCode: string
  httpStatus: number | null
  lifecycleEpoch: number
  message: string
  recoveryKind: 'none' | 'refresh-policy' | 'restart' | 'retry' | 'retry-stop' | 'sign-in' | 'upgrade' | 'wait'
}

const RECOVERY_ERROR_KINDS = new Set<OperationError['recoveryKind']>([
  'none', 'refresh-policy', 'restart', 'retry', 'retry-stop', 'sign-in', 'upgrade', 'wait'
])
const PUBLIC_ERROR_ENVELOPE = 'enterprise-public-error.v1'
const PUBLIC_ERROR_CODES = new Set([
  'artifact_body_missing',
  'artifact_hash_mismatch',
  'artifact_length_mismatch',
  'artifact_length_missing',
  'artifact_metadata_invalid',
  'artifact_too_large',
  'client_operation_id_conflict',
  'desktop_active_role_required',
  'desktop_session_required',
  'enterprise_lifecycle_effect_denied',
  'enterprise_lifecycle_ipc_denied',
  'enterprise_operation_superseded',
  'enterprise_operation_failed',
  'enterprise_profile_not_managed',
  'enterprise_runtime_access_unavailable',
  'enterprise_skill_download_failed',
  'enterprise_skill_hub_disabled',
  'enterprise_skill_hub_untrusted_renderer',
  'enterprise_skill_install_busy',
  'enterprise_skill_install_failed',
  'enterprise_skill_install_recovery_failed',
  'enterprise_skill_install_recovery_unavailable',
  'enterprise_managed_user_invalid',
  'enterprise_untrusted_renderer',
  'gateway-offline',
  'gateway-timeout',
  'install_operation_abort_unconfirmed',
  'install_operation_binding_mismatch',
  'install_operation_content_changed',
  'install_operation_content_mismatch',
  'install_operation_expired',
  'install_operation_journal_invalid',
  'install_operation_not_authorized',
  'install_operation_not_found',
  'install_operation_pending_limit',
  'install_operation_reconciliation_invalid',
  'install_operation_receipt_expired',
  'install_operation_receipt_invalid',
  'install_operation_receipt_required',
  'install_operation_reconciling',
  'install_operation_response_invalid',
  'install_operation_target_invalid',
  'install_operation_user_mismatch',
  'install_policy_changed',
  'local_backend_request_failed',
  'local_backend_unavailable',
  'local_install_response_invalid',
  'local_stage_response_invalid',
  'package_revision_changed',
  'request-canceled',
  'skill_install_receipt_ineligible',
  'skill_install_receipt_recovery_expired',
  'skill_install_receipt_unavailable',
  'skill_name_conflict',
  'skill_policy_denied',
  'skills_manage_required',
  'update_not_supported'
])
const SAFE_PUBLIC_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  client_operation_id_conflict: 'The enterprise skill operation conflicts with an existing request.',
  desktop_active_role_required: 'Contact an administrator to assign an active enterprise role.',
  desktop_session_required: 'Sign in to your enterprise account and try again.',
  enterprise_lifecycle_effect_denied: 'Enterprise access changed while the operation was running.',
  enterprise_lifecycle_ipc_denied: 'Enterprise policy does not allow this operation right now.',
  enterprise_managed_user_invalid: 'The managed enterprise user identity is invalid.',
  enterprise_operation_superseded: 'Enterprise access changed while the operation was running.',
  enterprise_skill_install_recovery_failed: 'The enterprise skill installation could not be recovered safely.',
  enterprise_skill_install_recovery_unavailable: 'Secure enterprise skill recovery is unavailable.',
  install_operation_abort_unconfirmed: 'Hermes could not confirm that the enterprise skill target is absent.',
  install_operation_binding_mismatch: 'The enterprise skill authorization no longer matches this operation.',
  install_operation_content_changed: 'The staged enterprise skill content changed before installation completed.',
  install_operation_content_mismatch: 'The enterprise skill content does not match its authorization.',
  install_operation_expired: 'The enterprise skill operation expired before installation completed.',
  install_operation_journal_invalid: 'The local enterprise skill recovery record is invalid.',
  install_operation_not_authorized: 'The enterprise skill operation is not authorized for installation.',
  install_operation_not_found: 'The enterprise skill operation no longer exists.',
  install_operation_pending_limit: 'Too many enterprise skill installations are pending. Wait before retrying.',
  install_operation_receipt_expired: 'The enterprise skill installation receipt expired.',
  install_operation_receipt_invalid: 'The enterprise skill installation receipt is invalid.',
  install_operation_receipt_required: 'A signed enterprise skill installation receipt is required.',
  install_operation_reconciliation_invalid: 'The enterprise skill recovery state is invalid.',
  install_operation_reconciling: 'The enterprise skill installation is being safely reconciled.',
  install_operation_response_invalid: 'The enterprise Gateway returned an invalid install operation.',
  install_operation_target_invalid: 'The local enterprise skill target is invalid.',
  install_operation_user_mismatch: 'The enterprise skill operation belongs to a different managed user.',
  install_policy_changed: 'Enterprise policy changed while this skill was being installed.',
  local_stage_response_invalid: 'The local enterprise skill staging result is invalid.',
  package_revision_changed: 'The enterprise skill package changed before installation.',
  request_canceled: 'The operation was canceled because enterprise access changed.',
  'request-canceled': 'The operation was canceled because enterprise access changed.',
  skill_install_receipt_ineligible: 'This enterprise skill operation cannot receive an installation receipt.',
  skill_install_receipt_recovery_expired: 'The enterprise skill receipt recovery window expired.',
  skill_install_receipt_unavailable: 'The enterprise Gateway could not issue an installation receipt.',
  skill_name_conflict: 'A local skill conflicts with this enterprise skill.',
  skill_policy_denied: 'Enterprise policy does not allow this skill to be installed.',
  skills_manage_required: 'Contact an administrator to grant enterprise skill management access.',
  update_not_supported: 'This enterprise skill cannot be updated by the current Desktop version.'
})
const SAFE_SKILL_HUB_FAILURE_MESSAGE = 'Enterprise Skill Hub request failed safely.'
const SAFE_RECOVERY_FAILURE_MESSAGE = 'Enterprise skill recovery could not be completed safely.'

function deterministicRecoveryKind(code: string, status: number | null): OperationError['recoveryKind'] | null {
  if (
    code === 'enterprise_skill_hub_untrusted_renderer' ||
    code === 'enterprise_skill_hub_disabled' ||
    code === 'enterprise_runtime_access_unavailable' ||
    code === 'enterprise_profile_not_managed' ||
    code === 'enterprise_untrusted_renderer' ||
    code === 'request-canceled' ||
    code === 'enterprise_operation_superseded' ||
    code === 'local_backend_request_failed'
  ) return 'none'
  if (status === 401 || code === 'desktop_session_required') return 'sign-in'
  if (status === 426) return 'upgrade'
  if (code === 'install_operation_reconciling' || code === 'install_operation_pending_limit') return 'wait'
  if (
    status === 403 ||
    code === 'desktop_active_role_required' ||
    code === 'skills_manage_required' ||
    code === 'skill_policy_denied' ||
    code === 'install_policy_changed'
  ) return 'refresh-policy'
  if (
    code === 'install_operation_expired' ||
    code === 'skill_install_receipt_recovery_expired' ||
    code === 'skill_install_receipt_unavailable'
  ) return 'retry'
  if ((status !== null && status >= 500) || code === 'gateway-offline' || code === 'gateway-timeout') return 'retry'
  return null
}

function safePublicMessage(code: string, status: number | null, recoveryKind: OperationError['recoveryKind']): string {
  if (SAFE_PUBLIC_MESSAGES[code]) return SAFE_PUBLIC_MESSAGES[code]
  if (recoveryKind === 'sign-in') return 'Sign in to your enterprise account and try again.'
  if (recoveryKind === 'upgrade') return 'Update Hermes Desktop before continuing.'
  if (recoveryKind === 'wait') return 'Hermes maintenance is still in progress. Wait before retrying.'
  if (recoveryKind === 'retry-stop') return 'Hermes could not stop safely. Retry the stop before continuing.'
  if (recoveryKind === 'restart') return 'Restart Hermes Desktop before continuing.'
  if (recoveryKind === 'refresh-policy') return 'Enterprise policy does not allow this operation right now.'
  if (status !== null && status >= 500) return 'The enterprise service is temporarily unavailable. Try again.'
  return SAFE_SKILL_HUB_FAILURE_MESSAGE
}

function verifiedPublicError(error: unknown): OperationError | null {
  const value = error as {
    code?: unknown
    envelope?: unknown
    errorCode?: unknown
    httpStatus?: unknown
    lifecycleEpoch?: unknown
    message?: unknown
    recoveryKind?: unknown
    status?: unknown
  }
  const code = typeof value?.errorCode === 'string' ? value.errorCode : ''
  const status = value?.httpStatus
  const lifecycleEpoch = value?.lifecycleEpoch
  const recoveryKind = value?.recoveryKind
  if (
    value?.envelope !== PUBLIC_ERROR_ENVELOPE ||
    !PUBLIC_ERROR_CODES.has(code) ||
    value?.code !== code ||
    value?.status !== status ||
    !(status === null || (Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599)) ||
    !Number.isSafeInteger(lifecycleEpoch) || Number(lifecycleEpoch) < 0 ||
    typeof recoveryKind !== 'string' || !RECOVERY_ERROR_KINDS.has(recoveryKind as OperationError['recoveryKind']) ||
    typeof value?.message !== 'string' ||
    (deterministicRecoveryKind(code, status as number | null) || 'none') !== recoveryKind
  ) return null

  return {
    errorCode: code,
    httpStatus: status as number | null,
    lifecycleEpoch: lifecycleEpoch as number,
    message: safePublicMessage(code, status as number | null, recoveryKind as OperationError['recoveryKind']),
    recoveryKind: recoveryKind as OperationError['recoveryKind']
  }
}

function errorInfo(error: unknown): OperationError {
  return verifiedPublicError(error) || {
    errorCode: 'enterprise_operation_failed',
    httpStatus: null,
    lifecycleEpoch: 0,
    message: SAFE_SKILL_HUB_FAILURE_MESSAGE,
    recoveryKind: 'none'
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
  const [recovering, setRecovering] = useState<string | null>(null)
  const recoveryFlightRef = useRef<Promise<void> | null>(null)

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
      notify({ kind: 'warning', message: errorInfo(error).message, title: t.skills.enterpriseLoadFailed })
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
      notify({ kind: 'warning', message: errorInfo(error).message, title: t.skills.enterpriseLoadFailed })
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

      if (info.errorCode === 'package_revision_changed') {
        await refreshList().catch(() => undefined)
      }

      notify({ kind: 'warning', message: info.message, title: t.skills.enterpriseInstallFailed(item.name) })
    } finally {
      setInstalling(null)
    }
  }

  function canRecover(error: OperationError): boolean {
    return ['refresh-policy', 'retry', 'wait'].includes(error.recoveryKind)
  }

  function recover(item: EnterpriseSkillHubItem, operationError: OperationError): void {
    if (!canRecover(operationError) || recoveryFlightRef.current) {return}
    const flight = (async () => {
      setRecovering(item.key)
      const lifecycle = await window.hermesDesktop.enterprise.lifecycleStatus()
      if (lifecycle.lifecycleEpoch !== operationError.lifecycleEpoch) {return}
      if (operationError.recoveryKind === 'refresh-policy') {
        await handleRefreshPolicy()
      } else {
        await install(item)
      }
    })().catch(error => {
      const next = verifiedPublicError(error) || operationError
      setOperationErrors(current => ({ ...current, [item.key]: next }))
      notify({
        id: `enterprise-skill-recovery:${item.key}`,
        kind: 'warning',
        message: SAFE_RECOVERY_FAILURE_MESSAGE,
        title: t.skills.enterpriseInstallFailed(item.name)
      })
    }).finally(() => {
      if (recoveryFlightRef.current === flight) {recoveryFlightRef.current = null}
      setRecovering(null)
    })
    recoveryFlightRef.current = flight
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
                  <div
                    className={`mt-2 text-[0.7rem] leading-4 ${operationErrors[item.key] ? 'text-destructive' : 'text-muted-foreground'}`}
                    data-error-code={operationErrors[item.key]?.errorCode}
                    data-http-status={operationErrors[item.key]?.httpStatus ?? undefined}
                    data-lifecycle-epoch={operationErrors[item.key]?.lifecycleEpoch}
                    data-recovery-kind={operationErrors[item.key]?.recoveryKind}
                  >
                    <p>
                      {operationErrors[item.key]?.message ||
                        (denied ? item.policyReason : t.skills.enterpriseUpdateUnsupported)}
                    </p>
                    {operationErrors[item.key] && (
                      <p className="mt-1 text-(--ui-text-tertiary)">
                        {operationErrors[item.key].errorCode}
                        {operationErrors[item.key].httpStatus ? ` · HTTP ${operationErrors[item.key].httpStatus}` : ''}
                        {` · ${operationErrors[item.key].recoveryKind} · epoch ${operationErrors[item.key].lifecycleEpoch}`}
                      </p>
                    )}
                    {operationErrors[item.key] && canRecover(operationErrors[item.key]) && (
                      <Button
                        aria-label={`${operationErrors[item.key].recoveryKind === 'refresh-policy'
                          ? t.skills.enterprisePolicyRefresh
                          : t.skills.refresh} ${item.name}`}
                        className="mt-1.5"
                        disabled={recovering === item.key}
                        onClick={() => recover(item, operationErrors[item.key])}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {operationErrors[item.key].recoveryKind === 'refresh-policy'
                          ? t.skills.enterprisePolicyRefresh
                          : t.skills.refresh}
                      </Button>
                    )}
                  </div>
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
