import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { EnterpriseModelProfileSummary } from '@/global'
import {
  getAuxiliaryModels,
  getGlobalModelInfo,
  getGlobalModelOptions,
  getHermesConfigRecord,
  getRecommendedDefaultModel,
  saveHermesConfig,
  setEnvVar,
  setModelAssignment
} from '@/hermes'
import type { AuxiliaryModelsResponse, ModelOptionProvider, StaleAuxAssignment } from '@/hermes'
import { useI18n } from '@/i18n'
import { AlertTriangle, Cpu, Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $enterprise, logoutEnterprise } from '@/store/enterprise'
import { notify, notifyError } from '@/store/notifications'
import { startManualLocalEndpoint, startManualProviderOAuth } from '@/store/onboarding'
import type { HermesConfigRecord } from '@/types/hermes'

import { CONTROL_TEXT } from './constants'
import { getNested, setNested } from './helpers'
import { ListRow, LoadingState, Pill, SectionHeading } from './primitives'

// Hermes' reasoning levels (VALID_REASONING_EFFORTS); `none` = thinking off.
// Empty config = Hermes default (medium), shown as Medium.
const EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

// agent.service_tier stores "fast"/"priority"/"on" for fast; anything else is
// normal (mirrors tui_gateway _load_service_tier).
const isFastTier = (tier: unknown): boolean =>
  ['fast', 'priority', 'on'].includes(String(tier ?? '').trim().toLowerCase())

// Reuse the composer's effort labels (`xhigh` shows as "Max", else 1:1).
const effortLabelKey = (v: string) => (v === 'xhigh' ? 'max' : v) as 'high' | 'low' | 'max' | 'medium' | 'minimal'

// A provider row is "ready" to pick a model from when it reports models. The
// backend now surfaces the full `hermes model` universe (every canonical
// provider), so unconfigured providers come back with `authenticated:false`
// and an empty `models` list — those need a setup step before a model exists.
function isProviderReady(p?: ModelOptionProvider): boolean {
  return !!p && (p.authenticated !== false || (p.models?.length ?? 0) > 0)
}

// Mirrors `_AUX_TASK_SLOTS` in hermes_cli/web_server.py. Friendly labels and
// hints make the assignments readable; raw task keys (vision, mcp, …) are
// opaque to most users.
interface AuxTaskMeta {
  key: string
}

const AUX_TASKS: readonly AuxTaskMeta[] = [
  { key: 'vision' },
  { key: 'web_extract' },
  { key: 'compression' },
  { key: 'skills_hub' },
  { key: 'approval' },
  { key: 'mcp' },
  { key: 'title_generation' },
  { key: 'curator' }
]

const NO_PROVIDERS: readonly ModelOptionProvider[] = [{ name: '—', slug: '', models: [] }]

interface StaleAuxWarningProps {
  applying: boolean
  onReset: () => void
  slots: readonly StaleAuxAssignment[]
  taskLabel: (key: string) => string
}

// Shared notice: auxiliary tasks still pinned to a provider that isn't the
// current main. Surfaces the silent credit-burn path (e.g. aux pinned to a
// $0-balance provider after switching main away from it) and offers the
// existing one-click reset rather than auto-clearing legitimate pins.
function StaleAuxWarning({ applying, onReset, slots, taskLabel }: StaleAuxWarningProps) {
  if (!slots.length) {
    return null
  }

  const provider = slots[0].provider
  const allSameProvider = slots.every(slot => slot.provider === provider)
  const names = slots.map(slot => taskLabel(slot.task)).join(', ')

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="grow">
        {slots.length} auxiliary task{slots.length === 1 ? '' : 's'} ({names}) still run on{' '}
        <span className="font-mono">{allSameProvider ? provider : 'other providers'}</span>, not your main model.
      </span>
      <Button disabled={applying} onClick={onReset} size="sm" variant="textStrong">
        Reset all to main
      </Button>
    </div>
  )
}

interface ModelSettingsProps {
  /** Notified after the main model is applied, so live UI stores can sync. */
  onMainModelChanged?: (provider: string, model: string) => void
}

export function ModelSettings({ onMainModelChanged }: ModelSettingsProps) {
  const enterprise = useStore($enterprise)
  const managed = enterprise.enabled && enterprise.authenticated

  if (managed) {
    return <EnterpriseModelSettings />
  }

  return <HermesModelSettings onMainModelChanged={onMainModelChanged} />
}

function displayModelName(profile: EnterpriseModelProfileSummary): string {
  return profile.displayName || profile.name || profile.model || profile.id || '未命名模型'
}

function formatManagedValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '未配置'
  }

  if (typeof value === 'boolean') {
    return value ? '是' : '否'
  }

  if (Array.isArray(value)) {
    return value.length ? value.map(formatManagedValue).join('、') : '未配置'
  }

  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  return String(value)
}

function ManagedRecordRows({ record }: { record?: Record<string, unknown> }) {
  const entries = Object.entries(record ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== '')

  if (entries.length === 0) {
    return <span className="text-xs text-muted-foreground">未配置</span>
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([key, value]) => (
        <Pill key={key}>
          <span className="font-mono">{key}</span>: {formatManagedValue(value)}
        </Pill>
      ))}
    </div>
  )
}

function enterpriseUserLabel(user: unknown): string {
  if (!user || typeof user !== 'object') {
    return '已认证企业账号'
  }

  const record = user as Record<string, unknown>
  const candidate = record.displayName ?? record.name ?? record.userName ?? record.username ?? record.email ?? record.id

  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : '已认证企业账号'
}

function EnterpriseModelSettings() {
  const enterprise = useStore($enterprise)
  const [loggingOut, setLoggingOut] = useState(false)
  const profiles = enterprise.modelProfiles ?? []
  const currentProfile = profiles.find(
    profile =>
      (enterprise.currentModelProfileId && profile.id === enterprise.currentModelProfileId) ||
      (enterprise.currentModel && profile.model === enterprise.currentModel)
  )
  const defaultProfile = profiles.find(profile => profile.isDefault || profile.model === enterprise.defaultModel)
  const capabilities = currentProfile?.capabilities ?? enterprise.capabilities
  const runtimeDefaults = currentProfile?.runtimeDefaults ?? enterprise.runtimeDefaults
  const auxiliaryPolicy = currentProfile?.auxiliaryPolicy ?? enterprise.auxiliaryPolicy

  async function handleLogout() {
    if (loggingOut) {
      return
    }

    if (!window.confirm('退出企业账号后，本机将停止当前企业受管运行环境，并回到企业登录界面。确定退出吗？')) {
      return
    }

    setLoggingOut(true)

    try {
      await logoutEnterprise()
      notify({ durationMs: 3_000, kind: 'success', message: '已退出企业账号。' })
    } catch (error) {
      notifyError(error, '退出企业账号失败')
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <div className="grid gap-6">
      <section className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)/40 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <SectionHeading icon={Cpu} title="企业模型配置" />
          <Pill tone="primary">受管</Pill>
          {enterprise.policyVersion ? <Pill>策略版本 {enterprise.policyVersion}</Pill> : null}
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          当前模型、授权范围、运行默认值和辅助模型策略由企业管理员统一配置。普通用户不能在桌面端修改
          provider、API key、OAuth、local/custom endpoint、模型可见性或网关凭据。
        </p>
      </section>

      <section>
        <div className="grid gap-1">
          <ListRow
            action={<span className="font-mono text-xs">{enterprise.currentModel ?? '未配置'}</span>}
            description={currentProfile ? displayModelName(currentProfile) : '由企业策略下发'}
            title="当前模型"
          />
          <ListRow
            action={<span className="font-mono text-xs">{enterprise.defaultModel ?? '未配置'}</span>}
            description={defaultProfile ? displayModelName(defaultProfile) : '由企业策略下发'}
            title="默认模型"
          />
          <ListRow
            action={<ManagedRecordRows record={capabilities} />}
            description="包含上下文、reasoning、fast、vision 等模型能力；字段不存在时按后端默认策略执行。"
            title="模型能力"
          />
          <ListRow
            action={<ManagedRecordRows record={runtimeDefaults} />}
            description="新会话运行参数默认值由企业网关下发。"
            title="运行默认值"
          />
          <ListRow
            action={<ManagedRecordRows record={auxiliaryPolicy} />}
            description="辅助任务模型策略由企业统一控制，未指定时跟随主模型。"
            title="辅助模型策略"
          />
        </div>
      </section>

      <section>
        <SectionHeading icon={Cpu} meta={`${profiles.length}`} title="授权模型" />
        {profiles.length > 0 ? (
          <div className="grid gap-1">
            {profiles.map(profile => (
              <ListRow
                action={
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {profile.model === enterprise.currentModel ? <Pill tone="primary">当前</Pill> : null}
                    {(profile.isDefault || profile.model === enterprise.defaultModel) ? <Pill>默认</Pill> : null}
                    {profile.apiFormat ? <Pill>{profile.apiFormat}</Pill> : null}
                  </div>
                }
                description={
                  <span className="font-mono text-[0.68rem]">
                    {profile.model ?? '未配置'}
                  </span>
                }
                key={profile.id ?? profile.model ?? profile.name}
                title={displayModelName(profile)}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-4 py-8 text-center text-sm text-muted-foreground">
            暂无授权模型，请联系企业管理员配置模型授权。
          </div>
        )}
      </section>

      <section className="rounded-lg border border-destructive/35 bg-destructive/5 px-4 py-3">
        <SectionHeading icon={AlertTriangle} title="企业账号" />
        <ListRow
          action={
            <Button disabled={loggingOut} onClick={() => void handleLogout()} type="button" variant="destructive">
              {loggingOut ? <Loader2 className="animate-spin" /> : null}
              {loggingOut ? '退出中...' : '退出企业账号'}
            </Button>
          }
          description="退出会撤销当前桌面会话和网关令牌，之后需要重新登录才能使用企业模型。"
          title={enterpriseUserLabel(enterprise.user)}
        />
      </section>
    </div>
  )
}

function HermesModelSettings({ onMainModelChanged }: ModelSettingsProps) {
  const { t } = useI18n()
  const m = t.settings.model
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mainModel, setMainModel] = useState<{ model: string; provider: string } | null>(null)
  const [providers, setProviders] = useState<ModelOptionProvider[]>([])
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [auxiliary, setAuxiliary] = useState<AuxiliaryModelsResponse | null>(null)
  // Full profile config, kept so the reasoning/speed defaults round-trip
  // (read agent.* → write back the whole record) like the generic config page.
  const [config, setConfig] = useState<HermesConfigRecord | null>(null)
  const [applying, setApplying] = useState(false)
  const [editingAuxTask, setEditingAuxTask] = useState<null | string>(null)
  const [auxDraft, setAuxDraft] = useState<{ model: string; provider: string }>({ model: '', provider: '' })
  // Aux slots reported stale by the backend immediately after a main-model
  // switch (provider differs from the new main). Cleared on next switch/reset.
  const [switchStaleAux, setSwitchStaleAux] = useState<StaleAuxAssignment[]>([])
  // Inline API-key entry for picking an unconfigured `api_key` provider in
  // place — mirrors the onboarding ApiKeyForm but scoped to the model picker.
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [activating, setActivating] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      const [modelInfo, modelOptions, auxiliaryModels, cfg] = await Promise.all([
        getGlobalModelInfo(),
        getGlobalModelOptions(),
        getAuxiliaryModels(),
        getHermesConfigRecord()
      ])

      setMainModel({ model: modelInfo.model, provider: modelInfo.provider })
      setProviders(modelOptions.providers || [])
      setSelectedProvider(prev => prev || modelInfo.provider)
      setSelectedModel(prev => prev || modelInfo.model)
      setAuxiliary(auxiliaryModels)
      setConfig(cfg)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const providerOptions = providers.length ? providers : NO_PROVIDERS

  const selectedProviderRow = useMemo(
    () => providers.find(provider => provider.slug === selectedProvider),
    [providers, selectedProvider]
  )

  const selectedProviderModels = selectedProviderRow?.models ?? []

  // An unconfigured provider was picked: no credentials yet, so there are no
  // models to choose. `api_key` providers can be activated inline (paste key);
  // OAuth / external flows hand off to the onboarding sign-in.
  const needsSetup = !!selectedProvider && !isProviderReady(selectedProviderRow)
  const setupIsApiKey = needsSetup && selectedProviderRow?.auth_type === 'api_key' && !!selectedProviderRow?.key_env

  // Clear any half-typed key when switching provider so it can't leak across.
  useEffect(() => {
    setApiKeyDraft('')
  }, [selectedProvider])

  const auxDraftProviderModels = useMemo(
    () => providers.find(provider => provider.slug === auxDraft.provider)?.models ?? [],
    [auxDraft.provider, providers]
  )

  const auxiliaryTaskLabel = useCallback((key: string) => m.tasks[key]?.label ?? key, [m.tasks])

  // Persistent mismatch: any aux slot pinned to a provider different from the
  // current main, regardless of whether the user just switched. Catches the
  // "I pinned aux months ago and forgot, now it bills a dead provider" case.
  const persistentStaleAux = useMemo<StaleAuxAssignment[]>(() => {
    const mainProvider = (mainModel?.provider ?? '').toLowerCase()

    if (!mainProvider || !auxiliary) {
      return []
    }

    return auxiliary.tasks
      .filter(entry => {
        const p = (entry.provider ?? '').toLowerCase()

        return p && p !== 'auto' && p !== mainProvider
      })
      .map(entry => ({ task: entry.task, provider: entry.provider, model: entry.model }))
  }, [auxiliary, mainModel])

  // Capabilities of the APPLIED main model — gates the profile-default
  // reasoning/speed controls the same way the composer picker gates per-model
  // edits (reasoning defaults on, fast defaults off when unreported).
  const mainCaps = useMemo(() => {
    const row = providers.find(provider => provider.slug === mainModel?.provider)

    return mainModel ? row?.capabilities?.[mainModel.model] : undefined
  }, [providers, mainModel])

  const reasoningSupported = mainCaps?.reasoning ?? true
  const fastSupported = mainCaps?.fast ?? false
  const effortValue = String(getNested(config ?? {}, 'agent.reasoning_effort') ?? '').trim().toLowerCase() || 'medium'
  const fastOn = isFastTier(getNested(config ?? {}, 'agent.service_tier'))

  // Persist a single agent.* default by round-tripping the whole config record
  // (PUT /api/config replaces it) — optimistic, with rollback on failure.
  const writeAgentDefault = useCallback(
    async (key: string, value: string) => {
      if (!config) {
        return
      }

      const prev = config
      const next = setNested(config, key, value)
      setConfig(next)

      try {
        await saveHermesConfig(next)
      } catch (err) {
        setConfig(prev)
        notifyError(err, m.defaultsFailed)
      }
    },
    [config, m.defaultsFailed]
  )

  // Paste an API key for the selected `api_key` provider, persist it, then
  // refresh so the now-authenticated provider's models populate. Auto-selects
  // the recommended default model so the user can Apply in one more click.
  const activateApiKeyProvider = useCallback(async () => {
    const keyEnv = selectedProviderRow?.key_env
    const slug = selectedProviderRow?.slug

    if (!keyEnv || !slug || !apiKeyDraft.trim()) {
      return
    }

    setActivating(true)
    setError('')

    try {
      await setEnvVar(keyEnv, apiKeyDraft.trim())
      setApiKeyDraft('')

      // Pick a sensible default for the freshly-activated provider (mirrors
      // `hermes model` curation). Best-effort — fall through to the refreshed
      // model list if it fails.
      let nextModel = ''

      try {
        const rec = await getRecommendedDefaultModel(slug)
        nextModel = rec.model || ''
      } catch {
        nextModel = ''
      }

      const options = await getGlobalModelOptions()
      setProviders(options.providers || [])
      const refreshedRow = options.providers?.find(p => p.slug === slug)
      const fallbackModel = refreshedRow?.models?.[0] ?? ''
      setSelectedModel(nextModel || fallbackModel)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActivating(false)
    }
  }, [apiKeyDraft, selectedProviderRow])

  // OAuth / external providers can't be activated with a pasted key — hand off
  // to the shared onboarding flow scoped to this provider's real sign-in. The
  // custom / local endpoint is NOT an OAuth provider, so it gets the dedicated
  // local-endpoint form (URL + optional API key) instead of being dead-ended
  // on the OAuth picker (the original "booted back to the first screen" loop).
  const startProviderSetup = useCallback(() => {
    const slug = selectedProviderRow?.slug

    if (!slug) {
      return
    }

    const lower = slug.toLowerCase()

    if (lower === 'custom' || lower === 'local' || lower.startsWith('custom:')) {
      startManualLocalEndpoint()
    } else {
      startManualProviderOAuth(slug)
    }
  }, [selectedProviderRow])

  const applyMainModel = useCallback(async () => {
    if (!selectedProvider || !selectedModel) {
      return
    }

    setApplying(true)
    setError('')

    try {
      const result = await setModelAssignment({ model: selectedModel, provider: selectedProvider, scope: 'main' })
      const provider = result.provider || selectedProvider
      const model = result.model || selectedModel
      setMainModel({ provider, model })
      setSwitchStaleAux(result.stale_aux ?? [])
      onMainModelChanged?.(provider, model)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }, [onMainModelChanged, refresh, selectedModel, selectedProvider])

  const setAuxiliaryToMain = useCallback(
    async (task: string) => {
      if (!mainModel) {
        return
      }

      setApplying(true)
      setError('')

      try {
        await setModelAssignment({ model: mainModel.model, provider: mainModel.provider, scope: 'auxiliary', task })
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setApplying(false)
      }
    },
    [mainModel, refresh]
  )

  const applyAuxiliaryDraft = useCallback(
    async (task: string) => {
      if (!auxDraft.provider || !auxDraft.model) {
        return
      }

      setApplying(true)
      setError('')

      try {
        await setModelAssignment({ model: auxDraft.model, provider: auxDraft.provider, scope: 'auxiliary', task })
        setEditingAuxTask(null)
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setApplying(false)
      }
    },
    [auxDraft, refresh]
  )

  const beginAuxiliaryEdit = useCallback(
    (task: string) => {
      const current = auxiliary?.tasks.find(entry => entry.task === task)

      const initialProvider =
        current?.provider && current.provider !== 'auto' ? current.provider : (mainModel?.provider ?? '')

      const initialModel = current?.model || mainModel?.model || ''
      setAuxDraft({ provider: initialProvider, model: initialModel })
      setEditingAuxTask(task)
    },
    [auxiliary, mainModel]
  )

  const resetAuxiliaryModels = useCallback(async () => {
    if (!mainModel) {
      return
    }

    setApplying(true)
    setError('')

    try {
      await setModelAssignment({
        model: mainModel.model,
        provider: mainModel.provider,
        scope: 'auxiliary',
        task: '__reset__'
      })
      setSwitchStaleAux([])
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }, [mainModel, refresh])

  if (loading && !mainModel) {
    return <LoadingState label={m.loading} />
  }

  return (
    <div className="grid gap-6">
      <section>
        <p className="mb-3 text-xs text-muted-foreground">
          {m.appliesDesc}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select onValueChange={setSelectedProvider} value={selectedProvider}>
            <SelectTrigger className={cn('min-w-40', CONTROL_TEXT)}>
              <SelectValue placeholder={m.provider} />
            </SelectTrigger>
            <SelectContent>
              {providerOptions.map(provider => (
                <SelectItem key={provider.slug || 'none'} value={provider.slug || 'none'}>
                  {provider.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {needsSetup ? (
            setupIsApiKey ? (
              <>
                <Input
                  autoComplete="off"
                  className={cn('min-w-60 flex-1', CONTROL_TEXT)}
                  onChange={event => setApiKeyDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      void activateApiKeyProvider()
                    }
                  }}
                  placeholder={`Paste ${selectedProviderRow?.key_env ?? 'API key'}`}
                  type="password"
                  value={apiKeyDraft}
                />
                <Button
                  disabled={!apiKeyDraft.trim() || activating}
                  onClick={() => void activateApiKeyProvider()}
                  size="sm"
                >
                  {activating && <Loader2 className="size-3.5 animate-spin" />}
                  {activating ? 'Activating...' : 'Activate'}
                </Button>
              </>
            ) : (
              <Button onClick={startProviderSetup} size="sm" variant="textStrong">
                Set up {selectedProviderRow?.name ?? 'provider'}
              </Button>
            )
          ) : (
            <>
              <Select onValueChange={setSelectedModel} value={selectedModel}>
                <SelectTrigger className={cn('min-w-60', CONTROL_TEXT)}>
                  <SelectValue placeholder={m.model} />
                </SelectTrigger>
                <SelectContent>
                  {(selectedProviderModels.length ? selectedProviderModels : []).map(model => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                disabled={!selectedProvider || !selectedModel || applying}
                onClick={() => void applyMainModel()}
                size="sm"
              >
                {applying && <Loader2 className="size-3.5 animate-spin" />}
                {applying ? m.applying : t.common.apply}
              </Button>
            </>
          )}
        </div>
        {needsSetup && !setupIsApiKey && (
          <p className="mt-2 text-xs text-muted-foreground">
            {selectedProviderRow?.auth_type === 'api_key'
              ? `${selectedProviderRow?.name} needs an API key — set it up to choose a model.`
              : `${selectedProviderRow?.name} signs in through your browser — Hermes runs the flow for you.`}
          </p>
        )}
        {config && mainModel && (reasoningSupported || fastSupported) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="text-xs text-muted-foreground">{m.defaultsLabel}</span>
            {reasoningSupported && (
              <div className="flex items-center gap-2 text-xs">
                {m.reasoning}
                <Select onValueChange={value => void writeAgentDefault('agent.reasoning_effort', value)} value={effortValue}>
                  <SelectTrigger className={cn('min-w-28', CONTROL_TEXT)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EFFORT_VALUES.map(value => (
                      <SelectItem key={value} value={value}>
                        {value === 'none' ? m.reasoningOff : t.shell.modelOptions[effortLabelKey(value)]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {fastSupported && (
              <label className="flex items-center gap-2 text-xs">
                {t.shell.modelOptions.fast}
                <Switch
                  checked={fastOn}
                  onCheckedChange={checked => void writeAgentDefault('agent.service_tier', checked ? 'fast' : 'normal')}
                  size="xs"
                />
              </label>
            )}
          </div>
        )}
        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
        {switchStaleAux.length > 0 && (
          <div className="mt-2">
            <StaleAuxWarning
              applying={applying}
              onReset={() => void resetAuxiliaryModels()}
              slots={switchStaleAux}
              taskLabel={auxiliaryTaskLabel}
            />
          </div>
        )}
      </section>

      <section>
        <div className="mb-2.5 flex items-center justify-between">
          <SectionHeading icon={Cpu} title={m.auxiliaryTitle} />
          <Button
            disabled={!mainModel || applying}
            onClick={() => void resetAuxiliaryModels()}
            size="sm"
            variant="textStrong"
          >
            {m.resetAllToMain}
          </Button>
        </div>
        <p className="mb-2 text-xs text-muted-foreground">
          {m.auxiliaryDesc}
        </p>
        {switchStaleAux.length === 0 && persistentStaleAux.length > 0 && (
          <div className="mb-2.5">
            <StaleAuxWarning
              applying={applying}
              onReset={() => void resetAuxiliaryModels()}
              slots={persistentStaleAux}
              taskLabel={auxiliaryTaskLabel}
            />
          </div>
        )}
        <div className="grid gap-1">
          {AUX_TASKS.map(meta => {
            const copy = m.tasks[meta.key] ?? { label: meta.key, hint: meta.key }
            const current = auxiliary?.tasks.find(entry => entry.task === meta.key)
            const isAuto = !current || !current.provider || current.provider === 'auto'
            const isEditing = editingAuxTask === meta.key

            return (
              <ListRow
                action={
                  !isEditing && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        disabled={!mainModel || applying}
                        onClick={() => void setAuxiliaryToMain(meta.key)}
                        size="sm"
                        variant="text"
                      >
                        {m.setToMain}
                      </Button>
                      <Button
                        disabled={!providers.length || applying}
                        onClick={() => beginAuxiliaryEdit(meta.key)}
                        size="sm"
                        variant="textStrong"
                      >
                        {m.change}
                      </Button>
                    </div>
                  )
                }
                below={
                  isEditing && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 pt-1">
                      <Select
                        onValueChange={value => setAuxDraft(prev => ({ ...prev, provider: value, model: '' }))}
                        value={auxDraft.provider}
                      >
                        <SelectTrigger className={cn('min-w-32', CONTROL_TEXT)}>
                          <SelectValue placeholder={m.provider} />
                        </SelectTrigger>
                        <SelectContent>
                          {providerOptions.map(provider => (
                            <SelectItem key={provider.slug || 'none'} value={provider.slug || 'none'}>
                              {provider.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        onValueChange={value => setAuxDraft(prev => ({ ...prev, model: value }))}
                        value={auxDraft.model}
                      >
                        <SelectTrigger className={cn('min-w-48', CONTROL_TEXT)}>
                          <SelectValue placeholder={m.model} />
                        </SelectTrigger>
                        <SelectContent>
                          {(auxDraftProviderModels.length ? auxDraftProviderModels : []).map(model => (
                            <SelectItem key={model} value={model}>
                              {model}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        disabled={!auxDraft.provider || !auxDraft.model || applying}
                        onClick={() => void applyAuxiliaryDraft(meta.key)}
                        size="sm"
                      >
                        {applying ? m.applying : t.common.apply}
                      </Button>
                      <Button onClick={() => setEditingAuxTask(null)} size="sm" variant="ghost">
                        {t.common.cancel}
                      </Button>
                    </div>
                  )
                }
                description={
                  <span className="font-mono text-[0.68rem]">
                    {isAuto
                      ? m.autoUseMain
                      : `${current.provider} · ${current.model || m.providerDefault}`}
                  </span>
                }
                key={meta.key}
                title={
                  <span className="flex items-baseline gap-2">
                    {copy.label}
                    <Pill>{copy.hint}</Pill>
                  </span>
                }
              />
            )
          })}
        </div>
      </section>
    </div>
  )
}
