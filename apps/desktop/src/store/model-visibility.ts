import { atom } from 'nanostores'

import type { EnterpriseDesktopState, EnterpriseModelProfileSummary } from '@/global'
import { persistString, storedString } from '@/lib/storage'
import type { ModelCapabilities, ModelOptionProvider, ModelOptionsResponse } from '@/types/hermes'

const STORAGE_KEY = 'hermes.desktop.visible-models'

/** Models shown per provider in the status-bar dropdown before the user has
 *  customized the list. Backend `models` are already relevance-ordered. */
export const DEFAULT_VISIBLE_PER_PROVIDER = 50

/** Stable key for a provider/model pair (`::` avoids colliding with model ids
 *  that contain a single colon, e.g. `model:tag`). */
export const modelVisibilityKey = (provider: string, model: string): string => `${provider}::${model}`

/** Sentinel key suffix stored when the user explicitly hides ALL models for a
 *  provider.  Distinguishes "user hid everything" from "never customized" so
 *  `effectiveVisibleKeys` does not re-add defaults for that provider. */
export const EMPTY_PROVIDER_SENTINEL = ''

/** Build the sentinel key for a provider whose last model was toggled off. */
export const emptyProviderSentinelKey = (provider: string): string =>
  modelVisibilityKey(provider, EMPTY_PROVIDER_SENTINEL)

/** Check whether a stored key is a provider-hidden sentinel. */
export const isProviderSentinel = (key: string): boolean => key.endsWith('::')

/** A model and its optional `…-fast` sibling, collapsed into one logical row.
 *  `id` is the canonical (base) model; `fastId` is the fast variant if present. */
export interface ModelFamily {
  fastId: string | null
  id: string
}

/** Collapse a provider's model list so a base model and its `…-fast` variant
 *  become a single family (one row, one toggle). Order is preserved by the
 *  base model's position. A `…-fast` model with no base stands on its own. */
export function collapseModelFamilies(models: readonly string[]): ModelFamily[] {
  const present = new Set(models)
  const families: ModelFamily[] = []
  const consumed = new Set<string>()

  for (const model of models) {
    if (consumed.has(model)) {
      continue
    }

    if (/-fast$/i.test(model) && present.has(model.replace(/-fast$/i, ''))) {
      // Represented by its base entry — the base attaches it as `fastId`.
      continue
    }

    if (/-\d{8}$/.test(model) && present.has(model.replace(/-\d{8}$/, ''))) {
      // A date-pinned snapshot superseded by its rolling alias — drop the dupe.
      continue
    }

    const fastId = `${model}-fast`
    const hasFast = present.has(fastId)
    families.push({ fastId: hasFast ? fastId : null, id: model })
    consumed.add(model)

    if (hasFast) {
      consumed.add(fastId)
    }
  }

  return families
}

function loadVisible(): Set<string> | null {
  const raw = storedString(STORAGE_KEY)

  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw)

    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : null
  } catch {
    return null
  }
}

/** Explicit set of visible `provider::model` keys, or null when the user
 *  hasn't customized — in which case the curated default applies. */
export const $visibleModels = atom<Set<string> | null>(loadVisible())

export const $modelVisibilityOpen = atom(false)

export function setVisibleModels(keys: Set<string>): void {
  $visibleModels.set(new Set(keys))
  persistString(STORAGE_KEY, JSON.stringify([...keys]))
}

export function setModelVisibilityOpen(open: boolean): void {
  $modelVisibilityOpen.set(open)
}

/** The default-visible key set: the curated top-N per provider. Used both as
 *  the dropdown fallback and to seed the Edit Models dialog. */
export function defaultVisibleKeys(providers: readonly ModelOptionProvider[]): Set<string> {
  const keys = new Set<string>()

  for (const provider of providers) {
    const families = collapseModelFamilies(provider.models ?? [])

    for (const family of families.slice(0, DEFAULT_VISIBLE_PER_PROVIDER)) {
      keys.add(modelVisibilityKey(provider.slug, family.id))
    }
  }

  return keys
}

/** Resolve which keys are currently visible: the user's explicit set when
 *  configured, otherwise the curated default for the given providers. */
export function effectiveVisibleKeys(
  stored: Set<string> | null,
  providers: readonly ModelOptionProvider[]
): Set<string> {
  if (!stored) {
    return defaultVisibleKeys(providers)
  }

  if (stored.size === 0) {
    return new Set()
  }

  const next = new Set(stored)

  for (const provider of providers) {
    const providerPrefix = `${provider.slug}::`
    const hasStoredProvider = [...stored].some(key => key.startsWith(providerPrefix) && !isProviderSentinel(key))
    const hasSentinel = stored.has(emptyProviderSentinelKey(provider.slug))

    if (hasStoredProvider || hasSentinel) {
      continue
    }

    const families = collapseModelFamilies(provider.models ?? [])

    for (const family of families.slice(0, DEFAULT_VISIBLE_PER_PROVIDER)) {
      next.add(modelVisibilityKey(provider.slug, family.id))
    }
  }

  // Strip sentinel keys — they are bookkeeping, not real visibility entries.
  for (const key of [...next]) {
    if (isProviderSentinel(key)) {
      next.delete(key)
    }
  }

  return next
}

const ENTERPRISE_PROVIDER_SLUG = 'company-gateway'
const ENTERPRISE_PROVIDER_NAME = '企业模型'

export function isEnterpriseModelManaged(state: EnterpriseDesktopState): boolean {
  return state.enabled && (state.authenticated || state.status === 'authenticated')
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function enterpriseProfileModel(profile: EnterpriseModelProfileSummary): string | null {
  const expanded = profile as EnterpriseModelProfileSummary & Record<string, unknown>

  return firstString(
    expanded.model,
    expanded.modelId,
    expanded.model_id,
    expanded.runtimeModel,
    expanded.runtime_model,
    expanded.id,
    expanded.name
  )
}

function enterpriseProfileName(profile: EnterpriseModelProfileSummary, fallback: string): string {
  const expanded = profile as EnterpriseModelProfileSummary & Record<string, unknown>

  return firstString(expanded.name, expanded.displayName, expanded.display_name, expanded.label, fallback) ?? fallback
}

function enterpriseCapabilities(profile: EnterpriseModelProfileSummary): ModelCapabilities | undefined {
  const expanded = profile as EnterpriseModelProfileSummary & Record<string, unknown>
  const raw = expanded.capabilities

  if (!raw || typeof raw !== 'object') {
    return undefined
  }

  const capabilities = raw as Record<string, unknown>

  return {
    fast: capabilities.fast === true,
    reasoning: capabilities.reasoning !== false
  }
}

export function enterpriseModelOptionsFromState(state: EnterpriseDesktopState): ModelOptionsResponse {
  const models: string[] = []
  const capabilities: Record<string, ModelCapabilities> = {}
  const seen = new Set<string>()

  for (const profile of state.modelProfiles ?? []) {
    const model = enterpriseProfileModel(profile)

    if (!model || seen.has(model)) {
      continue
    }

    seen.add(model)
    models.push(model)

    const caps = enterpriseCapabilities(profile)

    if (caps) {
      capabilities[model] = caps
    }
  }

  for (const model of state.allowedModels ?? []) {
    if (model && !seen.has(model)) {
      seen.add(model)
      models.push(model)
    }
  }

  const provider: ModelOptionProvider = {
    authenticated: true,
    capabilities: Object.keys(capabilities).length > 0 ? capabilities : undefined,
    models,
    name: ENTERPRISE_PROVIDER_NAME,
    slug: ENTERPRISE_PROVIDER_SLUG,
    total_models: models.length
  }

  return {
    model: models[0],
    provider: ENTERPRISE_PROVIDER_SLUG,
    providers: models.length > 0 ? [provider] : []
  }
}

export function enterpriseModelDisplayName(state: EnterpriseDesktopState, model: string): string {
  for (const profile of state.modelProfiles ?? []) {
    const profileModel = enterpriseProfileModel(profile)

    if (profileModel === model) {
      return enterpriseProfileName(profile, model)
    }
  }

  return model
}
