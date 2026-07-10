import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { TextTab, TextTabMeta } from '@/components/ui/text-tab'
import type { EnterpriseToolPolicyItem, EnterpriseToolPolicySnapshot, EnterpriseToolPolicyStatus } from '@/global'
import { getSkillContent, getSkills, getToolsets, toggleSkill, toggleToolset } from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $enterprise } from '@/store/enterprise'
import { notify, notifyError } from '@/store/notifications'
import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { PAGE_INSET_X } from '../layout-constants'
import { PageSearchShell } from '../page-search-shell'
import { asText, includesQuery, prettyName, toolNames, toolsetDisplayLabel } from '../settings/helpers'
import { ToolsetConfigPanel } from '../settings/toolset-config-panel'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import {
  type CapabilityDetailCopy,
  getSkillDetail,
  getToolsetDetail,
  shortCapabilitySummary
} from './capability-details'

const SKILLS_MODES = ['skills', 'toolsets'] as const
type SkillsMode = (typeof SKILLS_MODES)[number]
const POLICY_LOCKED_STATUSES = new Set<EnterpriseToolPolicyStatus>(['blocked', 'restricted'])

interface EnterprisePolicyMeta {
  enterpriseManaged?: boolean
  enterprisePolicyKey?: string
  enterprisePolicyReason?: string | null
  enterpriseRuntimeKey?: string
  enterprisePolicySource?: string | null
  enterprisePolicyStatus?: EnterpriseToolPolicyStatus
  runtimeAvailable?: boolean
  userCreated?: boolean
}

type ManagedSkillInfo = SkillInfo & EnterprisePolicyMeta
type ManagedToolsetInfo = ToolsetInfo & EnterprisePolicyMeta
type ExpandedCapability = { kind: 'skill' | 'toolset'; key: string } | null

interface SkillContentState {
  content?: string
  error?: string
  loading: boolean
  path?: string
}

function asPolicyArray(value: EnterpriseToolPolicyItem[] | undefined): EnterpriseToolPolicyItem[] {
  return Array.isArray(value) ? value : []
}

function policyKey(value: string | null | undefined): string {
  return String(value || '').trim()
}

function policyMapKey(value: string | null | undefined): string {
  return policyKey(value).toLowerCase()
}

function stripCatalogPrefix(value: string, prefix: 'skill' | 'toolset'): string {
  const normalized = policyKey(value)
  const marker = `${prefix}.`

  return normalized.toLowerCase().startsWith(marker) ? normalized.slice(marker.length) : normalized
}

function policyLookupKeys(value: string, prefix: 'skill' | 'toolset'): string[] {
  const key = policyKey(value)
  const stripped = stripCatalogPrefix(key, prefix)
  const prefixed = `${prefix}.${stripped}`

  return Array.from(new Set([key, stripped, prefixed].map(policyMapKey).filter(Boolean)))
}

function localSkillMap(localSkills: SkillInfo[]): Map<string, SkillInfo> {
  const result = new Map<string, SkillInfo>()

  for (const skill of localSkills) {
    for (const key of policyLookupKeys(skill.name, 'skill')) {
      result.set(key, skill)
    }
  }

  return result
}

function localToolsetMap(localToolsets: ToolsetInfo[]): Map<string, ToolsetInfo> {
  const result = new Map<string, ToolsetInfo>()

  for (const toolset of localToolsets) {
    for (const key of policyLookupKeys(toolset.name, 'toolset')) {
      result.set(key, toolset)
    }
  }

  return result
}

function operationKey(item: EnterprisePolicyMeta & { name: string }): string {
  return item.enterpriseRuntimeKey || item.name
}

function matchesRuntimeKey(name: string, key: string, prefix: 'skill' | 'toolset'): boolean {
  return policyLookupKeys(name, prefix).includes(policyMapKey(key))
}

function isRuntimeAvailable(item: EnterprisePolicyMeta): boolean {
  return item.runtimeAvailable !== false
}

function localizedField(
  item: EnterpriseToolPolicyItem,
  locale: 'en' | 'zh',
  field: 'description' | 'displayName'
): string | null {
  const value = item.localizedDisplay?.[locale]

  if (typeof value === 'string') {
    return field === 'displayName' ? value : null
  }

  if (value && typeof value === 'object') {
    const record = value as { description?: unknown; displayName?: unknown; name?: unknown }
    const raw = field === 'displayName' ? (record.displayName ?? record.name) : record.description
    const text = String(raw || '').trim()

    return text || null
  }

  return null
}

function policyDisplayName(item: EnterpriseToolPolicyItem): string {
  return (
    localizedField(item, 'zh', 'displayName') ||
    localizedField(item, 'en', 'displayName') ||
    String(item.displayName || '').trim() ||
    item.key
  )
}

function policyDescription(item: EnterpriseToolPolicyItem): string {
  return (
    localizedField(item, 'zh', 'description') ||
    localizedField(item, 'en', 'description') ||
    String(item.description || '').trim() ||
    String(item.reason || '').trim()
  )
}

function isPolicyLocked(item: EnterprisePolicyMeta): boolean {
  return Boolean(item.enterprisePolicyStatus && POLICY_LOCKED_STATUSES.has(item.enterprisePolicyStatus))
}

function policyStatusLabel(
  status: EnterpriseToolPolicyStatus | undefined,
  labels: Record<EnterpriseToolPolicyStatus, string>
): string | null {
  return status ? labels[status] || null : null
}

function enabledForPolicy(item: EnterpriseToolPolicyItem, localEnabled: boolean | undefined): boolean {
  if (POLICY_LOCKED_STATUSES.has(item.status)) {
    return false
  }

  if (localEnabled !== undefined) {
    return localEnabled
  }

  return item.status === 'defaultEnabled' || item.status === 'recommended' || item.status === 'teamShared'
}

function mergeManagedSkills(
  localSkills: SkillInfo[],
  snapshot: EnterpriseToolPolicySnapshot | null
): ManagedSkillInfo[] {
  if (!snapshot) {
    return localSkills
  }

  const localByKey = localSkillMap(localSkills)
  const enterpriseByKey = new Map<string, ManagedSkillInfo>()

  for (const item of asPolicyArray(snapshot.skills)) {
    const key = policyKey(item.key)

    if (!key) {
      continue
    }

    const local = localByKey.get(policyMapKey(key))
    const runtimeKey = local?.name || stripCatalogPrefix(key, 'skill')
    enterpriseByKey.set(policyMapKey(runtimeKey), {
      category: String(item.category || local?.category || 'general'),
      description: policyDescription(item) || local?.description || '',
      enabled: enabledForPolicy(item, local?.enabled),
      enterpriseManaged: true,
      enterprisePolicyKey: key,
      enterprisePolicyReason: item.reason || null,
      enterpriseRuntimeKey: runtimeKey,
      enterprisePolicySource: item.source || null,
      enterprisePolicyStatus: item.status,
      name: policyDisplayName(item),
      runtimeAvailable: Boolean(local),
      userCreated: item.status === 'userCreated'
    })
  }

  for (const skill of localSkills) {
    if (enterpriseByKey.has(policyMapKey(skill.name))) {
      continue
    }

    enterpriseByKey.set(policyMapKey(skill.name), {
      ...skill,
      enterprisePolicyKey: skill.name,
      enterprisePolicySource: 'local-runtime',
      enterprisePolicyStatus: 'userCreated',
      runtimeAvailable: true,
      userCreated: true
    })
  }

  return Array.from(enterpriseByKey.values())
}

function mergeManagedToolsets(
  localToolsets: ToolsetInfo[],
  snapshot: EnterpriseToolPolicySnapshot | null
): ManagedToolsetInfo[] {
  if (!snapshot) {
    return localToolsets
  }

  const localByKey = localToolsetMap(localToolsets)
  const enterpriseByKey = new Map<string, ManagedToolsetInfo>()

  for (const item of asPolicyArray(snapshot.toolSets)) {
    const key = policyKey(item.key)

    if (!key) {
      continue
    }

    const local = localByKey.get(policyMapKey(key))
    const runtimeKey = local?.name || stripCatalogPrefix(key, 'toolset')
    enterpriseByKey.set(policyMapKey(runtimeKey), {
      configured: POLICY_LOCKED_STATUSES.has(item.status) ? false : Boolean(local?.configured),
      description: policyDescription(item) || local?.description || '',
      enabled: enabledForPolicy(item, local?.enabled),
      enterpriseManaged: true,
      enterprisePolicyKey: key,
      enterprisePolicyReason: item.reason || null,
      enterpriseRuntimeKey: runtimeKey,
      enterprisePolicySource: item.source || null,
      enterprisePolicyStatus: item.status,
      label: policyDisplayName(item),
      name: runtimeKey,
      runtimeAvailable: Boolean(local),
      tools: Array.isArray(local?.tools) ? local.tools : [],
      userCreated: item.status === 'userCreated'
    })
  }

  for (const toolset of localToolsets) {
    if (enterpriseByKey.has(policyMapKey(toolset.name))) {
      continue
    }

    enterpriseByKey.set(policyMapKey(toolset.name), {
      ...toolset,
      enterprisePolicyKey: toolset.name,
      enterprisePolicySource: 'local-runtime',
      enterprisePolicyStatus: 'userCreated',
      runtimeAvailable: true,
      userCreated: true
    })
  }

  return Array.from(enterpriseByKey.values())
}

function categoryFor(skill: ManagedSkillInfo): string {
  return asText(skill.category) || 'general'
}

function filteredSkills(skills: ManagedSkillInfo[], query: string, category: string | null): ManagedSkillInfo[] {
  const q = query.trim().toLowerCase()

  return skills
    .filter(skill => {
      if (category && categoryFor(skill) !== category) {
        return false
      }

      if (!q) {
        return true
      }

      return (
        includesQuery(skill.name, q) ||
        includesQuery(skill.description, q) ||
        includesQuery(skill.category, q) ||
        includesQuery(skill.enterprisePolicyKey, q) ||
        includesQuery(skill.enterprisePolicyStatus, q)
      )
    })
    .sort((a, b) => asText(a.name).localeCompare(asText(b.name)))
}

function filteredToolsets(toolsets: ManagedToolsetInfo[], query: string): ManagedToolsetInfo[] {
  const q = query.trim().toLowerCase()

  return toolsets
    .filter(toolset => {
      if (!q) {
        return true
      }

      const label = toolsetDisplayLabel(toolset)

      return (
        includesQuery(toolset.name, q) ||
        includesQuery(label, q) ||
        includesQuery(toolset.label, q) ||
        includesQuery(toolset.description, q) ||
        includesQuery(toolset.enterprisePolicyKey, q) ||
        includesQuery(toolset.enterprisePolicyStatus, q) ||
        toolNames(toolset).some(name => includesQuery(name, q))
      )
    })
    .sort((a, b) => toolsetDisplayLabel(a).localeCompare(toolsetDisplayLabel(b)))
}

interface SkillsViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

export function SkillsView({ setStatusbarItemGroup: _setStatusbarItemGroup, ...props }: SkillsViewProps) {
  const { locale, t } = useI18n()
  const enterprise = useStore($enterprise)
  const [mode, setMode] = useRouteEnumParam('tab', SKILLS_MODES, 'skills')

  const [query, setQuery] = useState('')
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [toolsets, setToolsets] = useState<ToolsetInfo[] | null>(null)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [savingSkill, setSavingSkill] = useState<string | null>(null)
  const [savingToolset, setSavingToolset] = useState<string | null>(null)
  const [expandedToolset, setExpandedToolset] = useState<string | null>(null)
  const [expandedCapability, setExpandedCapability] = useState<ExpandedCapability>(null)
  const [skillContent, setSkillContent] = useState<Record<string, SkillContentState>>({})

  const refreshCapabilities = useCallback(async () => {
    setRefreshing(true)

    try {
      const [nextSkills, nextToolsets] = await Promise.all([getSkills(), getToolsets()])
      setSkills(nextSkills)
      setToolsets(nextToolsets)
    } catch (err) {
      notifyError(err, t.skills.skillsLoadFailed)
    } finally {
      setRefreshing(false)
    }
  }, [t])

  const refreshToolsets = useCallback(() => {
    getToolsets()
      .then(setToolsets)
      .catch(err => notifyError(err, t.skills.toolsetsRefreshFailed))
  }, [t])

  useRefreshHotkey(refreshCapabilities)

  useEffect(() => {
    void refreshCapabilities()
  }, [refreshCapabilities])

  const enterprisePolicySnapshot = enterprise.enabled && enterprise.authenticated ? enterprise.toolPolicySnapshot : null

  const effectiveSkills = useMemo(
    () => (skills ? mergeManagedSkills(skills, enterprisePolicySnapshot) : null),
    [enterprisePolicySnapshot, skills]
  )

  const effectiveToolsets = useMemo(
    () => (toolsets ? mergeManagedToolsets(toolsets, enterprisePolicySnapshot) : null),
    [enterprisePolicySnapshot, toolsets]
  )

  const categories = useMemo(() => {
    if (!effectiveSkills) {
      return []
    }

    const counts = new Map<string, number>()

    for (const skill of effectiveSkills) {
      const key = categoryFor(skill)
      counts.set(key, (counts.get(key) || 0) + 1)
    }

    return Array.from(counts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => ({ key, count }))
  }, [effectiveSkills])

  const visibleSkills = useMemo(
    () => (effectiveSkills ? filteredSkills(effectiveSkills, query, mode === 'skills' ? activeCategory : null) : []),
    [activeCategory, effectiveSkills, mode, query]
  )

  const visibleToolsets = useMemo(
    () => (effectiveToolsets ? filteredToolsets(effectiveToolsets, query) : []),
    [effectiveToolsets, query]
  )

  const totalSkills = effectiveSkills?.length || 0
  const enabledToolsets = effectiveToolsets?.filter(toolset => toolset.enabled).length || 0

  const selectedSkill =
    expandedCapability?.kind === 'skill'
      ? effectiveSkills?.find(skill => operationKey(skill) === expandedCapability.key) || null
      : null

  const selectedToolset =
    expandedCapability?.kind === 'toolset'
      ? effectiveToolsets?.find(toolset => operationKey(toolset) === expandedCapability.key) || null
      : null

  const configuringToolset = effectiveToolsets?.find(toolset => toolset.name === expandedToolset) || null

  async function handleToggleSkill(skill: ManagedSkillInfo, enabled: boolean) {
    if (isPolicyLocked(skill) || !isRuntimeAvailable(skill)) {
      return
    }

    const key = operationKey(skill)
    setSavingSkill(key)

    try {
      const result = await toggleSkill(key, enabled)
      setSkills(
        current =>
          current?.map(row =>
            matchesRuntimeKey(row.name, result.name, 'skill') ? { ...row, enabled: result.enabled } : row
          ) ?? current
      )
      setSkills(await getSkills())
      notify({
        kind: 'success',
        title: enabled ? t.skills.skillEnabled : t.skills.skillDisabled,
        message: t.skills.appliesToNewSessions(skill.name)
      })
    } catch (err) {
      notifyError(err, t.skills.failedToUpdate(skill.name))
    } finally {
      setSavingSkill(null)
    }
  }

  async function handleToggleToolset(toolset: ManagedToolsetInfo, enabled: boolean) {
    if (isPolicyLocked(toolset) || !isRuntimeAvailable(toolset)) {
      return
    }

    const key = operationKey(toolset)
    setSavingToolset(key)

    try {
      const result = await toggleToolset(key, enabled)
      setToolsets(
        current =>
          current?.map(row =>
            matchesRuntimeKey(row.name, result.name, 'toolset')
              ? { ...row, enabled: result.enabled, available: result.enabled }
              : row
          ) ?? current
      )
      setToolsets(await getToolsets())
      notify({
        kind: 'success',
        title: enabled ? t.skills.toolsetEnabled : t.skills.toolsetDisabled,
        message: t.skills.appliesToNewSessions(toolsetDisplayLabel(toolset))
      })
    } catch (err) {
      notifyError(err, t.skills.failedToUpdate(toolsetDisplayLabel(toolset)))
    } finally {
      setSavingToolset(null)
    }
  }

  async function loadSkillContent(skill: ManagedSkillInfo) {
    const key = operationKey(skill)

    if (skillContent[key]?.loading || skillContent[key]?.content || skillContent[key]?.error) {
      return
    }

    setSkillContent(current => ({
      ...current,
      [key]: { loading: true }
    }))

    try {
      const response = await getSkillContent(key)
      setSkillContent(current => ({
        ...current,
        [key]: { content: response.content, loading: false, path: response.path }
      }))
    } catch {
      setSkillContent(current => ({
        ...current,
        [key]: { error: t.skills.skillContentFailed(skill.name), loading: false }
      }))
    }
  }

  function handleToggleDetails(kind: 'skill' | 'toolset', key: string, skill?: ManagedSkillInfo) {
    setExpandedToolset(null)
    setExpandedCapability(current => {
      const next = current?.kind === kind && current.key === key ? null : { kind, key }

      if (next?.kind === 'skill' && skill) {
        void loadSkillContent(skill)
      }

      return next
    })
  }

  return (
    <PageSearchShell
      {...props}
      filters={
        mode === 'skills' && categories.length > 0 ? (
          <>
            <TextTab active={activeCategory === null} onClick={() => setActiveCategory(null)}>
              {t.skills.all} <TextTabMeta>{totalSkills}</TextTabMeta>
            </TextTab>
            {categories.map(category => (
              <TextTab
                active={activeCategory === category.key}
                key={category.key}
                onClick={() => setActiveCategory(activeCategory === category.key ? null : category.key)}
              >
                {prettyName(category.key)} <TextTabMeta>{category.count}</TextTabMeta>
              </TextTab>
            ))}
          </>
        ) : undefined
      }
      onSearchChange={setQuery}
      searchHidden={mode === 'skills' ? (effectiveSkills?.length ?? 0) === 0 : (effectiveToolsets?.length ?? 0) === 0}
      searchPlaceholder={mode === 'skills' ? t.skills.searchSkills : t.skills.searchToolsets}
      searchTrailingAction={
        <Button
          aria-label={refreshing ? t.skills.refreshing : t.skills.refresh}
          className="text-(--ui-text-tertiary) hover:bg-transparent hover:text-foreground"
          disabled={refreshing}
          onClick={() => void refreshCapabilities()}
          size="icon-xs"
          title={refreshing ? t.skills.refreshing : t.skills.refresh}
          type="button"
          variant="ghost"
        >
          <Codicon name="refresh" size="0.875rem" spinning={refreshing} />
        </Button>
      }
      searchValue={query}
      tabs={
        <>
          <TextTab active={mode === 'skills'} onClick={() => setMode('skills')}>
            {t.skills.tabSkills} <TextTabMeta>{totalSkills}</TextTabMeta>
          </TextTab>
          <TextTab active={mode === 'toolsets'} onClick={() => setMode('toolsets')}>
            {t.skills.tabToolsets} <TextTabMeta>{effectiveToolsets?.length || 0}</TextTabMeta>
          </TextTab>
        </>
      }
    >
      {!effectiveSkills || !effectiveToolsets ? (
        <PageLoader label={t.skills.loading} />
      ) : mode === 'skills' ? (
        <div className={cn('h-full overflow-y-auto py-3', PAGE_INSET_X)}>
          {visibleSkills.length === 0 ? (
            <EmptyState description={t.skills.noSkillsDesc} title={t.skills.noSkillsTitle} />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
              {visibleSkills.map(skill => {
                const key = operationKey(skill)
                const detail = getSkillDetail(skill, locale)
                const runtimeAvailable = isRuntimeAvailable(skill)

                return (
                  <article
                    className="flex min-h-44 min-w-0 flex-col rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)/25 p-3 transition-colors hover:border-(--ui-stroke-primary)"
                    key={skill.enterprisePolicyKey || skill.name}
                  >
                    <div className="flex min-w-0 items-start gap-2.5">
                      <div className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <Codicon name="book" size="1rem" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <h3 className="min-w-0 truncate text-sm font-semibold">{skill.name}</h3>
                          <PolicyStatusPill item={skill} labels={t.skills.policyStatus} />
                        </div>
                        <div className="mt-1 text-[0.68rem] text-(--ui-text-tertiary)">{t.skills.skillGuidance}</div>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-3 text-xs leading-5 text-muted-foreground">
                      {shortCapabilitySummary(detail) || t.skills.noDescription}
                    </p>
                    <div className="mt-auto flex min-w-0 items-center justify-between gap-2 pt-3">
                      <Badge className="max-w-[60%] truncate" variant="outline">
                        {prettyName(categoryFor(skill))}
                      </Badge>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {!runtimeAvailable && <Badge variant="muted">{t.skills.notInstalled}</Badge>}
                        <Button
                          aria-label={t.skills.showDetails(skill.name)}
                          className="text-(--ui-text-tertiary)"
                          onClick={() => handleToggleDetails('skill', key, skill)}
                          size="icon-xs"
                          title={t.skills.showDetails(skill.name)}
                          type="button"
                          variant="ghost"
                        >
                          <Codicon name="info" size="0.875rem" />
                        </Button>
                        {runtimeAvailable && (
                          <Switch
                            aria-label={t.skills.toggleSkill(skill.name)}
                            checked={skill.enabled}
                            disabled={savingSkill === key || isPolicyLocked(skill)}
                            onCheckedChange={checked => void handleToggleSkill(skill, checked)}
                          />
                        )}
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      ) : (
        <div className={cn('h-full overflow-y-auto py-3', PAGE_INSET_X)}>
          {visibleToolsets.length === 0 ? (
            <EmptyState description={t.skills.noToolsetsDesc} title={t.skills.noToolsetsTitle} />
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">
                {t.skills.toolsetsEnabled(enabledToolsets, effectiveToolsets.length)}
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
                {visibleToolsets.map(toolset => {
                  const tools = toolNames(toolset)
                  const label = toolsetDisplayLabel(toolset)
                  const detailKey = operationKey(toolset)
                  const detail = getToolsetDetail(toolset, locale)
                  const lockedByPolicy = isPolicyLocked(toolset)
                  const runtimeAvailable = isRuntimeAvailable(toolset)

                  const configLabel = lockedByPolicy
                    ? policyStatusLabel(toolset.enterprisePolicyStatus, t.skills.policyStatus) ||
                      (toolset.enterprisePolicyStatus === 'blocked'
                        ? t.skills.policyStatus.blocked
                        : t.skills.policyStatus.restricted)
                    : toolset.configured
                      ? t.skills.configured
                      : t.skills.needsKeys

                  return (
                    <article
                      className="flex min-h-44 min-w-0 flex-col rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)/25 p-3 transition-colors hover:border-(--ui-stroke-primary)"
                      key={toolset.enterprisePolicyKey || toolset.name}
                    >
                      <div className="flex min-w-0 items-start gap-2.5">
                        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                          <Codicon name="tools" size="1rem" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <h3 className="min-w-0 truncate text-sm font-semibold">{label}</h3>
                            <PolicyStatusPill item={toolset} labels={t.skills.policyStatus} />
                          </div>
                          <div className="mt-1 text-[0.68rem] text-(--ui-text-tertiary)">{t.skills.toolCapability}</div>
                        </div>
                      </div>
                      <p className="mt-3 line-clamp-3 text-xs leading-5 text-muted-foreground">
                        {shortCapabilitySummary(detail) || t.skills.noDescription}
                      </p>
                      <div className="mt-auto flex min-w-0 items-center justify-between gap-2 pt-3">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <StatusPill active={toolset.configured} locked={lockedByPolicy}>
                            {runtimeAvailable ? configLabel : t.skills.notInstalled}
                          </StatusPill>
                          {tools.length > 0 && <Badge variant="outline">{t.skills.toolCount(tools.length)}</Badge>}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button
                            aria-label={t.skills.showDetails(label)}
                            className="text-(--ui-text-tertiary)"
                            onClick={() => handleToggleDetails('toolset', detailKey)}
                            size="icon-xs"
                            title={t.skills.showDetails(label)}
                            type="button"
                            variant="ghost"
                          >
                            <Codicon name="info" size="0.875rem" />
                          </Button>
                          {runtimeAvailable && !lockedByPolicy && (
                            <Button
                              aria-label={t.skills.configureToolset(label)}
                              className="text-(--ui-text-tertiary)"
                              onClick={() => {
                                setExpandedCapability(null)
                                setExpandedToolset(toolset.name)
                              }}
                              size="icon-xs"
                              title={t.skills.configureToolset(label)}
                              type="button"
                              variant="ghost"
                            >
                              <Codicon name="settings-gear" size="0.875rem" />
                            </Button>
                          )}
                          {runtimeAvailable && (
                            <Switch
                              aria-label={t.skills.toggleToolset(label)}
                              checked={toolset.enabled}
                              disabled={savingToolset === operationKey(toolset) || lockedByPolicy}
                              onCheckedChange={checked => void handleToggleToolset(toolset, checked)}
                            />
                          )}
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <Sheet
        onOpenChange={open => {
          if (!open) {
            setExpandedCapability(null)
          }
        }}
        open={Boolean(selectedSkill || selectedToolset)}
      >
        <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
          {selectedSkill && (
            <>
              <SheetHeader className="border-b border-(--ui-stroke-secondary) pr-11">
                <SheetTitle>{selectedSkill.name}</SheetTitle>
                <SheetDescription>{t.skills.skillGuidance}</SheetDescription>
              </SheetHeader>
              <div className="px-3 pb-4">
                <SkillDetailPanel
                  contentState={skillContent[operationKey(selectedSkill)]}
                  detail={getSkillDetail(selectedSkill, locale)}
                  item={selectedSkill}
                  labels={t.skills}
                />
              </div>
            </>
          )}
          {selectedToolset && (
            <>
              <SheetHeader className="border-b border-(--ui-stroke-secondary) pr-11">
                <SheetTitle>{toolsetDisplayLabel(selectedToolset)}</SheetTitle>
                <SheetDescription>{t.skills.toolCapability}</SheetDescription>
              </SheetHeader>
              <div className="px-3 pb-4">
                <ToolsetDetailPanel
                  detail={getToolsetDetail(selectedToolset, locale)}
                  item={selectedToolset}
                  labels={t.skills}
                  tools={toolNames(selectedToolset)}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Sheet onOpenChange={open => !open && setExpandedToolset(null)} open={Boolean(configuringToolset)}>
        <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
          {configuringToolset && (
            <>
              <SheetHeader className="border-b border-(--ui-stroke-secondary) pr-11">
                <SheetTitle>{toolsetDisplayLabel(configuringToolset)}</SheetTitle>
                <SheetDescription>{getToolsetDetail(configuringToolset, locale).summary}</SheetDescription>
              </SheetHeader>
              <div className="px-3 pb-4">
                <ToolsetConfigPanel onConfiguredChange={refreshToolsets} toolset={configuringToolset.name} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </PageSearchShell>
  )
}

type SkillsCopy = Translations['skills']

function copyLanguage(labels: SkillsCopy): 'en' | 'ja' | 'zh' {
  if (labels.details === '详情' || labels.details === '詳情') {
    return 'zh'
  }

  if (labels.details === '詳細') {
    return 'ja'
  }

  return 'en'
}

function capabilityStatusRows(
  item: EnterprisePolicyMeta & { enabled: boolean },
  labels: SkillsCopy,
  configured?: boolean
): { callable: string; status: string; userControl: string } {
  const language = copyLanguage(labels)
  const locked = isPolicyLocked(item)
  const runtimeAvailable = isRuntimeAvailable(item)
  const policy = policyStatusLabel(item.enterprisePolicyStatus, labels.policyStatus)

  const statusParts = [policy, configured === undefined ? null : configured ? labels.configured : labels.needsKeys]
    .filter(Boolean)
    .join(' / ')

  const status = runtimeAvailable
    ? statusParts || (item.enabled ? labels.policyStatus.available : labels.policyStatus.blocked)
    : labels.notInstalled

  if (language === 'zh') {
    return {
      callable: !runtimeAvailable
        ? '当前运行时没有安装这项能力，不会进入会话。'
        : locked
          ? '不会进入当前会话 callable tools；需要策略放行。'
          : item.enabled
            ? '可进入新会话工具 schema；当前会话仍以实际可用工具列表为准。'
            : '未启用，默认不会进入新会话 callable tools。',
      status,
      userControl: !runtimeAvailable
        ? '这是企业目录条目；安装到当前运行时后才可切换。'
        : locked
          ? '由企业策略控制，用户不能在此修改。'
          : '用户可在此切换；变更通常应用于新会话。'
    }
  }

  if (language === 'ja') {
    return {
      callable: !runtimeAvailable
        ? 'This capability is not installed in the current runtime.'
        : locked
          ? '現在の callable tools には入りません。ポリシー許可が必要です。'
          : item.enabled
            ? 'New sessions may receive this schema; the current session still depends on actual callable tools.'
            : 'Disabled entries normally do not enter new-session callable tools.',
      status,
      userControl: !runtimeAvailable
        ? 'Install this catalog entry in the current runtime before changing it.'
        : locked
          ? 'Enterprise policy controls this entry, so users cannot change it here.'
          : 'Users can toggle this entry; changes usually apply to new sessions.'
    }
  }

  return {
    callable: !runtimeAvailable
      ? 'This capability is not installed in the current runtime.'
      : locked
        ? 'Does not enter current callable tools until policy allows it.'
        : item.enabled
          ? 'May enter new-session tool schemas; the current session still depends on actual callable tools.'
          : 'Disabled entries normally do not enter new-session callable tools.',
    status,
    userControl: !runtimeAvailable
      ? 'Install this catalog entry in the current runtime before changing it.'
      : locked
        ? 'Enterprise policy controls this entry; users cannot change it here.'
        : 'Users can toggle this entry; changes usually apply to new sessions.'
  }
}

function DetailPanelShell({ children, detail }: { children?: React.ReactNode; detail: CapabilityDetailCopy }) {
  return (
    <div className="mt-2 max-w-6xl rounded-[4px] border border-border/60 bg-(--ui-bg-secondary)/35 px-3 py-2.5 text-xs">
      <p className="max-w-5xl leading-5 text-(--ui-text-secondary)">{detail.summary}</p>
      {children}
    </div>
  )
}

function DetailSection({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</div>
      {children}
    </div>
  )
}

function DetailList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1 leading-5 text-muted-foreground">
      {items.map(item => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

function StatusDetailRows({
  configured,
  item,
  labels
}: {
  configured?: boolean
  item: EnterprisePolicyMeta & { enabled: boolean }
  labels: SkillsCopy
}) {
  const rows = capabilityStatusRows(item, labels, configured)

  return (
    <div className="space-y-1 leading-5 text-muted-foreground">
      <div>
        <span className="text-(--ui-text-tertiary)">{labels.statusMeaning}: </span>
        {rows.status}
      </div>
      <div>
        <span className="text-(--ui-text-tertiary)">{labels.callableSchema}: </span>
        {rows.callable}
      </div>
      <div>
        <span className="text-(--ui-text-tertiary)">{labels.userControl}: </span>
        {rows.userControl}
      </div>
    </div>
  )
}

function ToolChips({ tools }: { tools: string[] }) {
  if (tools.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-1">
      {tools.map(name => (
        <span
          className="rounded-md bg-(--ui-bg-quinary) px-1.5 py-0.5 font-mono text-[0.65rem] text-(--ui-text-tertiary)"
          key={name}
        >
          {name}
        </span>
      ))}
    </div>
  )
}

function ToolsetDetailPanel({
  detail,
  item,
  labels,
  tools
}: {
  detail: CapabilityDetailCopy
  item: ManagedToolsetInfo
  labels: SkillsCopy
  tools: string[]
}) {
  return (
    <DetailPanelShell detail={detail}>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <DetailSection title={labels.bestFor}>
          <DetailList items={detail.bestFor} />
        </DetailSection>
        <DetailSection title={labels.configuration}>
          <p className="leading-5 text-muted-foreground">{detail.configuration}</p>
        </DetailSection>
        <DetailSection title={labels.enterprisePolicyImpact}>
          <p className="leading-5 text-muted-foreground">{detail.policyImpact}</p>
        </DetailSection>
        <DetailSection title={labels.riskBoundary}>
          <p className="leading-5 text-muted-foreground">{detail.riskBoundary}</p>
        </DetailSection>
      </div>
      <div className="mt-3">
        <StatusDetailRows configured={item.configured} item={item} labels={labels} />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <DetailSection title={labels.includedTools}>
          <ToolChips tools={tools} />
        </DetailSection>
        <DetailSection title={labels.detailExamples}>
          <DetailList items={detail.examples} />
        </DetailSection>
      </div>
    </DetailPanelShell>
  )
}

function SkillDetailPanel({
  contentState,
  detail,
  item,
  labels
}: {
  contentState?: SkillContentState
  detail: CapabilityDetailCopy
  item: ManagedSkillInfo
  labels: SkillsCopy
}) {
  return (
    <DetailPanelShell detail={detail}>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <DetailSection title={labels.bestFor}>
          <DetailList items={detail.bestFor} />
        </DetailSection>
        <DetailSection title={labels.skillUsage}>
          <p className="leading-5 text-muted-foreground">{detail.configuration}</p>
        </DetailSection>
        <DetailSection title={labels.enterprisePolicyImpact}>
          <p className="leading-5 text-muted-foreground">{detail.policyImpact}</p>
        </DetailSection>
        <DetailSection title={labels.riskBoundary}>
          <p className="leading-5 text-muted-foreground">{detail.riskBoundary}</p>
        </DetailSection>
      </div>
      <div className="mt-3">
        <StatusDetailRows item={item} labels={labels} />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <DetailSection title={labels.detailExamples}>
          <DetailList items={detail.examples} />
        </DetailSection>
        <DetailSection title={labels.originalSkill}>
          {contentState?.loading ? (
            <p className="leading-5 text-muted-foreground">{labels.skillContentLoading}</p>
          ) : contentState?.error ? (
            <p className="leading-5 text-muted-foreground">{contentState.error}</p>
          ) : contentState?.content ? (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-(--ui-bg-quinary) p-2 font-mono text-[0.68rem] leading-5 text-(--ui-text-secondary)">
              {contentState.content}
            </pre>
          ) : (
            <p className="leading-5 text-muted-foreground">{labels.rawSkillUnavailable}</p>
          )}
        </DetailSection>
      </div>
    </DetailPanelShell>
  )
}

function PolicyStatusPill({
  item,
  labels
}: {
  item: EnterprisePolicyMeta
  labels: Record<EnterpriseToolPolicyStatus, string>
}) {
  const label = policyStatusLabel(item.enterprisePolicyStatus, labels)

  if (!label) {
    return null
  }

  return (
    <Badge
      className={
        isPolicyLocked(item) ? 'bg-destructive/10 text-destructive' : 'bg-(--ui-bg-quinary) text-(--ui-text-tertiary)'
      }
      title={item.enterprisePolicyReason || undefined}
    >
      {label}
    </Badge>
  )
}

function StatusPill({ active, children, locked = false }: { active: boolean; children: string; locked?: boolean }) {
  return (
    <Badge
      className={
        locked
          ? 'bg-destructive/10 text-destructive'
          : active
            ? 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)'
            : 'bg-(--ui-bg-quinary) text-(--ui-text-tertiary)'
      }
    >
      {children}
    </Badge>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="grid min-h-52 place-items-center text-center">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-1 text-xs text-muted-foreground">{description}</div>
      </div>
    </div>
  )
}
