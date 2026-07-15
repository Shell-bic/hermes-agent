const fs = require('node:fs')
const path = require('node:path')

const MANAGED_PROVIDER = 'company-gateway'
const GATEWAY_TOKEN_ENV = 'COMPANY_GATEWAY_TOKEN'
const ENTERPRISE_UI_POLICY_DEFAULT = Object.freeze({
  defaultLocale: 'zh',
  allowLanguageChange: true,
  lockedLocale: false
})
const SUPPORTED_DISPLAY_LANGUAGES = new Set(['en', 'zh', 'zh-hant', 'ja'])
const NON_SECRET_TOKEN_FIELDS = new Set([
  'completiontokens',
  'contextlengthtokens',
  'contextwindowtokens',
  'inputtokens',
  'maxoutputtokens',
  'maxtokens',
  'outputtokens',
  'prompttokens',
  'totaltokens'
])
const PROVIDER_RUNTIME_EXECUTION_MODES = new Set(['legacy', 'shadow', 'canonical'])
const PROVIDER_RUNTIME_ENDPOINT_MODES = new Set(['strict', 'translate'])
const PROVIDER_RUNTIME_SUPPORT_LEVELS = new Set([
  'mock-only',
  'implemented-auto-verified',
  'provider-certified'
])
const PROVIDER_RUNTIME_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i
const PROVIDER_RUNTIME_HASH_PATTERN = /^[a-f0-9]{64}$/i
const MAX_PROVIDER_RUNTIME_ENDPOINT_LENGTH = 256
const MAX_PROVIDER_RUNTIME_WARNINGS = 16
const UNSAFE_PROVIDER_RUNTIME_SUMMARY_PATTERN = /authorization|api[-_ ]?key|bearer\s+|credential|password|secret|token|prompt|tool(?:set|s)?\s*schema|https?:\/\//i
const TOOL_POLICY_STATUSES = new Set([
  'available',
  'blocked',
  'defaultEnabled',
  'recommended',
  'restricted',
  'teamShared',
  'userCreated'
])
const TOOL_POLICY_KEY_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,255}$/u
const TOOL_POLICY_COLLECTIONS = ['skills', 'toolSets', 'tools', 'mcpServers', 'capabilityFlags']
const ROLE_POLICY_VALUE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,255}$/u

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function hasControlCharacters(value) {
  return [...String(value || '')].some(character => {
    const code = character.charCodeAt(0)

    return code < 32 || code === 127
  })
}

function scalarYaml(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  return JSON.stringify(String(value))
}

function yamlBlock(value, indent = 0) {
  const pad = ' '.repeat(indent)

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`

    return value
      .map(item => {
        if (item && typeof item === 'object') {
          return `${pad}-\n${yamlBlock(item, indent + 2)}`
        }

        return `${pad}- ${scalarYaml(item)}`
      })
      .join('\n')
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    if (entries.length === 0) return `${pad}{}`

    return entries
      .map(([key, item]) => {
        if (item && typeof item === 'object') {
          return `${pad}${key}:\n${yamlBlock(item, indent + 2)}`
        }

        return `${pad}${key}: ${scalarYaml(item)}`
      })
      .join('\n')
  }

  return `${pad}${scalarYaml(value)}`
}

function normalizeEnterpriseUiPolicy({ bootstrap = null, manifest = null } = {}) {
  const source = manifest?.uiPolicy && typeof manifest.uiPolicy === 'object'
    ? manifest.uiPolicy
    : bootstrap?.uiPolicy && typeof bootstrap.uiPolicy === 'object'
      ? bootstrap.uiPolicy
      : null

  return {
    defaultLocale: typeof source?.defaultLocale === 'string' && source.defaultLocale.trim()
      ? source.defaultLocale.trim()
      : ENTERPRISE_UI_POLICY_DEFAULT.defaultLocale,
    allowLanguageChange: typeof source?.allowLanguageChange === 'boolean'
      ? source.allowLanguageChange
      : ENTERPRISE_UI_POLICY_DEFAULT.allowLanguageChange,
    lockedLocale: typeof source?.lockedLocale === 'boolean'
      ? source.lockedLocale
      : ENTERPRISE_UI_POLICY_DEFAULT.lockedLocale
  }
}

function dotenvLine(key, value) {
  const escaped = String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/"/g, '\\"')

  return `${key}="${escaped}"`
}

function enterpriseUserPathSegment(user) {
  if (!user || typeof user !== 'object') {
    return 'unknown'
  }

  const record = user
  const raw = record.id || record.userId || record.desktopUserId || record.userName || record.username || record.email || ''
  const value = String(raw || '').trim().toLowerCase()
  const safe = value.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')

  if (!safe || safe === '.' || safe === '..' || safe.includes('..')) {
    return 'unknown'
  }

  return safe
}

function normalizeGatewayApiBaseUrl(rawUrl) {
  const value = String(rawUrl || '').trim().replace(/\/+$/, '')

  if (!value) {
    throw new Error('Runtime manifest is missing gatewayApiBaseUrl.')
  }

  return value.endsWith('/v1') ? value : `${value}/v1`
}

function normalizeModelProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return null
  }

  const id = profile.id || profile.profileId || profile.model || profile.name || null
  const model = profile.model || profile.modelId || profile.id || null
  const provider = profile.provider && typeof profile.provider === 'object'
    ? scrubSecretFields(profile.provider)
    : {
        id: profile.modelProviderId || profile.providerId || null,
        name: profile.providerName || null,
        type: profile.providerType || null
      }
  const providerRuntime = normalizeProviderRuntimeMetadata(profile.providerRuntime)

  return {
    apiFormat: profile.apiFormat || profile.transport || null,
    ...(profile.apiMode || profile.api_mode ? { apiMode: profile.apiMode || profile.api_mode } : {}),
    auxiliaryPolicy: scrubSecretFields(profile.auxiliaryPolicy || {}),
    capabilities: scrubSecretFields(profile.capabilities || {}),
    displayName: profile.displayName || profile.name || profile.model || profile.id || null,
    ...(profile.gatewayEndpoint || profile.gateway_endpoint ? { gatewayEndpoint: profile.gatewayEndpoint || profile.gateway_endpoint } : {}),
    id,
    isDefault: Boolean(profile.isDefault),
    model,
    modelProviderId: profile.modelProviderId || profile.providerId || null,
    name: profile.name || profile.displayName || profile.model || profile.id || null,
    pricing: scrubSecretFields(profile.pricing || {}),
    ...(profile.protocolKey || profile.protocol_key ? { protocolKey: profile.protocolKey || profile.protocol_key } : {}),
    ...(providerRuntime ? { providerRuntime } : {}),
    provider,
    providerName: profile.providerName || provider?.name || null,
    providerType: profile.providerType || provider?.type || null,
    ...(profile.requestPolicy ? { requestPolicy: scrubSecretFields(profile.requestPolicy) } : {}),
    runtimeDefaults: scrubSecretFields(profile.runtimeDefaults || {}),
    ...(profile.runtimeLimits ? { runtimeLimits: scrubSecretFields(profile.runtimeLimits) } : {}),
    ...(profile.streamingPolicy ? { streamingPolicy: scrubSecretFields(profile.streamingPolicy) } : {}),
    ...(profile.toolSchemaPolicy ? { toolSchemaPolicy: scrubSecretFields(profile.toolSchemaPolicy) } : {})
  }
}

function normalizeProviderRuntimeToken(value) {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()

  return PROVIDER_RUNTIME_TOKEN_PATTERN.test(normalized) ? normalized : null
}

function normalizeProviderRuntimeHash(value) {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()

  return PROVIDER_RUNTIME_HASH_PATTERN.test(normalized) ? normalized : null
}

function normalizePublicGatewayEndpoint(value) {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()

  if (
    normalized.length > MAX_PROVIDER_RUNTIME_ENDPOINT_LENGTH ||
    !normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    normalized.includes('\\') ||
    normalized.includes('?') ||
    normalized.includes('#') ||
    hasControlCharacters(normalized)
  ) {
    return null
  }

  return normalized
}

function normalizeProviderRuntimeWarning(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const code = normalizeProviderRuntimeToken(value.code)
  if (!code) {
    return null
  }

  const candidate = typeof value.safeSummary === 'string' ? value.safeSummary.trim() : ''
  const safeSummary = candidate &&
      candidate.length <= 256 &&
      !hasControlCharacters(candidate) &&
      !UNSAFE_PROVIDER_RUNTIME_SUMMARY_PATTERN.test(candidate)
    ? candidate
    : 'Provider runtime policy warning.'

  return { code, safeSummary }
}

function normalizeProviderRuntimeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const presetKey = normalizeProviderRuntimeToken(value.presetKey)
  const presetVersion = normalizeProviderRuntimeToken(value.presetVersion)
  const supportLevel = normalizeProviderRuntimeToken(value.supportLevel)
  const executionMode = normalizeProviderRuntimeToken(value.executionMode)
  const endpointMode = normalizeProviderRuntimeToken(value.endpointMode)
  const protocolKey = normalizeProviderRuntimeToken(value.protocolKey)
  const publicGatewayEndpoint = normalizePublicGatewayEndpoint(value.publicGatewayEndpoint)
  const effectivePolicyHash = normalizeProviderRuntimeHash(value.effectivePolicyHash)
  const runtimeHash = normalizeProviderRuntimeHash(value.runtimeHash)
  const warnings = asArray(value.warnings)
    .slice(0, MAX_PROVIDER_RUNTIME_WARNINGS)
    .map(normalizeProviderRuntimeWarning)
    .filter(Boolean)
  const result = {
    ...(presetKey ? { presetKey } : {}),
    ...(presetVersion ? { presetVersion } : {}),
    ...(supportLevel && PROVIDER_RUNTIME_SUPPORT_LEVELS.has(supportLevel) ? { supportLevel } : {}),
    ...(executionMode && PROVIDER_RUNTIME_EXECUTION_MODES.has(executionMode) ? { executionMode } : {}),
    ...(endpointMode && PROVIDER_RUNTIME_ENDPOINT_MODES.has(endpointMode) ? { endpointMode } : {}),
    ...(protocolKey ? { protocolKey } : {}),
    ...(publicGatewayEndpoint ? { publicGatewayEndpoint } : {}),
    ...(effectivePolicyHash ? { effectivePolicyHash } : {}),
    ...(runtimeHash ? { runtimeHash } : {}),
    warnings
  }

  return Object.keys(result).length > 1 || warnings.length > 0 ? result : null
}

function apiModeFromApiFormat(raw) {
  const normalized = String(raw || '').trim().toLowerCase().replace(/-/g, '_')

  if (normalized === 'anthropic' || normalized === 'anthropic_messages') {
    return 'anthropic_messages'
  }

  if (normalized === 'codex' || normalized === 'codex_responses' || normalized === 'responses') {
    return 'codex_responses'
  }

  if (
    normalized === 'chat' ||
    normalized === 'chat_completions' ||
    normalized === 'openai' ||
    normalized === 'openai_chat' ||
    normalized === 'openai_compatible'
  ) {
    return 'chat_completions'
  }

  return 'chat_completions'
}

function resolveManifestApiMode(manifest) {
  const normalizedProfiles = asArray(manifest?.modelProfiles).map(normalizeModelProfile).filter(Boolean)
  const defaultModel = manifest?.defaultModel || asArray(manifest?.allowedModels)[0] || ''
  const currentModel = manifest?.currentModel || manifest?.selectedModel || defaultModel
  const currentModelProfileId = String(manifest?.currentModelProfileId || manifest?.defaultModelProfileId || '').trim()
  const currentProfile = currentModelProfileId
    ? normalizedProfiles.find(profile => String(profile.id || '').trim() === currentModelProfileId)
    : normalizedProfiles.find(profile => profile.model === currentModel || profile.id === currentModel)
      || normalizedProfiles.find(profile => profile.isDefault)
      || normalizedProfiles[0]
  const apiMode = manifest?.apiMode || manifest?.api_mode || currentProfile?.apiMode
  if (apiMode) {
    return apiModeFromApiFormat(apiMode)
  }

  const apiFormat = manifest?.transport || manifest?.apiFormat || currentProfile?.apiFormat

  return apiModeFromApiFormat(apiFormat)
}

function scrubSecretFields(value) {
  if (Array.isArray(value)) {
    return value.map(scrubSecretFields)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const result = {}
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = String(key || '').replace(/[_-]/g, '').toLowerCase()
    if (!NON_SECRET_TOKEN_FIELDS.has(normalizedKey) && /secret|token|api[_-]?key|password|credential/i.test(key)) {
      continue
    }

    result[key] = scrubSecretFields(item)
  }

  return result
}

function unquoteYamlScalar(value) {
  const trimmed = String(value || '').trim()
  const withoutComment = trimmed.replace(/\s+#.*$/, '').trim()

  if (!withoutComment) {
    return ''
  }

  if ((withoutComment.startsWith('"') && withoutComment.endsWith('"')) || (withoutComment.startsWith("'") && withoutComment.endsWith("'"))) {
    try {
      return JSON.parse(withoutComment)
    } catch {
      return withoutComment.slice(1, -1)
    }
  }

  return withoutComment
}

function supportedDisplayLanguage(value) {
  const language = String(value || '').trim().toLowerCase()

  return SUPPORTED_DISPLAY_LANGUAGES.has(language) ? language : null
}

function readManagedConfigDisplayLanguage({ configPath, fsImpl = fs }) {
  let contents = ''
  try {
    contents = fsImpl.readFileSync(configPath, 'utf8')
  } catch {
    return null
  }

  const lines = String(contents || '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const displayMatch = lines[index].match(/^(\s*)display\s*:\s*(?:#.*)?$/)
    if (!displayMatch) {
      continue
    }

    const displayIndent = displayMatch[1].length
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (!line.trim() || line.trim().startsWith('#')) {
        continue
      }

      const indent = line.match(/^\s*/)[0].length
      if (indent <= displayIndent) {
        break
      }

      const languageMatch = line.match(/^\s*language\s*:\s*(.+?)\s*$/)
      if (languageMatch) {
        return supportedDisplayLanguage(unquoteYamlScalar(languageMatch[1]))
      }
    }
  }

  return null
}

function resolveRole({ bootstrap = null, manifest = null } = {}) {
  return manifest?.roles || manifest?.role || bootstrap?.roles || bootstrap?.role || null
}

function normalizeToolPolicyItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return null
  }

  const key = String(item.key || '').trim()
  if (!key) {
    return null
  }

  const normalized = {
    key,
    status: item.status || 'available',
    ...(item.displayName != null ? { displayName: item.displayName } : {}),
    ...(item.description != null ? { description: item.description } : {}),
    ...(item.category != null ? { category: item.category } : {}),
    ...(item.riskLevel != null ? { riskLevel: item.riskLevel } : {}),
    ...(item.source != null ? { source: item.source } : {}),
    ...(item.localizedDisplay != null ? { localizedDisplay: item.localizedDisplay } : {}),
    ...(item.reason != null ? { reason: item.reason } : {})
  }

  return scrubSecretFields(normalized)
}

function normalizeToolPolicyItems(items) {
  return asArray(items).map(item => normalizeToolPolicyItem(item)).filter(Boolean)
}

function normalizeCapabilityFlags(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') {
          return item
        }

        return normalizeToolPolicyItem(item)
      })
      .filter(Boolean)
  }

  if (value && typeof value === 'object') {
    return scrubSecretFields(value)
  }

  return {}
}

function normalizeToolPolicySnapshot(manifest) {
  const snapshot = manifest?.toolPolicySnapshot
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null
  }

  return scrubSecretFields({
    skills: normalizeToolPolicyItems(snapshot.skills),
    toolSets: normalizeToolPolicyItems(snapshot.toolSets),
    tools: normalizeToolPolicyItems(snapshot.tools),
    mcpServers: normalizeToolPolicyItems(snapshot.mcpServers),
    capabilityFlags: normalizeCapabilityFlags(snapshot.capabilityFlags),
    policyVersion: snapshot.policyVersion || manifest?.policyVersion || null,
    policyHash: snapshot.policyHash || manifest?.policyHash || null,
    generatedAt: snapshot.generatedAt || manifest?.generatedAt || null
  })
}

function policyRefreshMetadata(policy) {
  return {
    generatedAt: String(policy?.generatedAt || policy?.toolPolicySnapshot?.generatedAt || '').trim() || null,
    policyHash: String(policy?.policyHash || policy?.toolPolicySnapshot?.policyHash || '').trim() || null,
    policyVersion: String(policy?.policyVersion || policy?.toolPolicySnapshot?.policyVersion || '').trim() || null
  }
}

function hasValidToolPolicyItems(items) {
  if (!Array.isArray(items)) {
    return false
  }

  const seen = new Set()
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return false
    }

    const key = item.key
    if (typeof key !== 'string' || key !== key.trim() || !TOOL_POLICY_KEY_PATTERN.test(key)) {
      return false
    }

    if (typeof item.status !== 'string' || !TOOL_POLICY_STATUSES.has(item.status)) {
      return false
    }

    const canonicalKey = key.toLocaleLowerCase('en-US')
    if (seen.has(canonicalKey)) {
      return false
    }
    seen.add(canonicalKey)
  }

  return true
}

function hasSafePolicyMetadataValue(value, maxLength = 512) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !hasControlCharacters(value)
}

function hasConsistentPolicyMetadata(policy) {
  const snapshot = policy?.toolPolicySnapshot
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return false
  }

  for (const field of ['generatedAt', 'policyHash']) {
    const topLevel = policy[field]
    const nested = snapshot[field]
    if (
      !hasSafePolicyMetadataValue(topLevel) ||
      !hasSafePolicyMetadataValue(nested) ||
      topLevel !== nested
    ) {
      return false
    }
  }

  return hasSafePolicyMetadataValue(policy.policyVersion) &&
    hasSafePolicyMetadataValue(snapshot.policyVersion)
}

function hasValidRolePolicyValues(values) {
  if (!Array.isArray(values)) {
    return false
  }

  const seen = new Set()
  for (const value of values) {
    if (
      typeof value !== 'string' ||
      value !== value.trim() ||
      !ROLE_POLICY_VALUE_PATTERN.test(value) ||
      seen.has(value)
    ) {
      return false
    }
    seen.add(value)
  }

  return true
}

function isValidManagedPolicySnapshot(policy, { bootstrapContract = false } = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return false
  }

  if (!hasValidRolePolicyValues(policy.lockedSurfaces)) {
    return false
  }

  if (bootstrapContract) {
    if (!hasValidRolePolicyValues(policy.capabilities)) {
      return false
    }
  } else if (Array.isArray(policy.capabilities)) {
    if (!hasValidRolePolicyValues(policy.capabilities)) {
      return false
    }
  } else if (!policy.capabilities || typeof policy.capabilities !== 'object') {
    // Initial managed snapshots carry the model-capability record from the
    // runtime manifest. Refreshed snapshots carry role capabilities as a list.
    return false
  }

  const rawSnapshot = policy.toolPolicySnapshot
  if (!hasConsistentPolicyMetadata(policy)) {
    return false
  }

  for (const collection of TOOL_POLICY_COLLECTIONS) {
    if (!hasValidToolPolicyItems(rawSnapshot[collection])) {
      return false
    }
  }

  const toolPolicySnapshot = normalizeToolPolicySnapshot({
    generatedAt: policy.generatedAt,
    policyHash: policy.policyHash,
    policyVersion: policy.policyVersion,
    toolPolicySnapshot: policy.toolPolicySnapshot
  })
  const metadata = policyRefreshMetadata(policy)

  return Boolean(toolPolicySnapshot && metadata.generatedAt && metadata.policyHash && metadata.policyVersion)
}

function validateManagedBootstrap(bootstrap) {
  if (!isValidManagedPolicySnapshot(bootstrap, { bootstrapContract: true })) {
    const error = new Error('Enterprise policy bootstrap payload is invalid.')
    error.code = 'enterprise_policy_payload_invalid'
    throw error
  }

  return bootstrap
}

function readManagedPolicySnapshot({ fsImpl = fs, hermesHome } = {}) {
  const policyPath = path.join(String(hermesHome || ''), 'enterprise-policy.json')

  if (!hermesHome || !fsImpl.existsSync(policyPath)) {
    return { policy: null, policyPath, reason: 'missing', valid: false }
  }

  try {
    const policy = JSON.parse(fsImpl.readFileSync(policyPath, 'utf8'))

    return isValidManagedPolicySnapshot(policy)
      ? { policy, policyPath, reason: null, valid: true }
      : { policy: null, policyPath, reason: 'invalid', valid: false }
  } catch {
    return { policy: null, policyPath, reason: 'invalid', valid: false }
  }
}

function buildRefreshedPolicySnapshot({ bootstrap, currentPolicy = null } = {}) {
  if (!bootstrap || typeof bootstrap !== 'object' || Array.isArray(bootstrap)) {
    throw new Error('Enterprise policy bootstrap payload is required.')
  }

  validateManagedBootstrap(bootstrap)

  const toolPolicySnapshot = normalizeToolPolicySnapshot({
    generatedAt: bootstrap.generatedAt,
    policyHash: bootstrap.policyHash,
    policyVersion: bootstrap.policyVersion,
    toolPolicySnapshot: bootstrap.toolPolicySnapshot
  })
  const metadata = policyRefreshMetadata({
    generatedAt: bootstrap.generatedAt,
    policyHash: bootstrap.policyHash,
    policyVersion: bootstrap.policyVersion,
    toolPolicySnapshot
  })

  const canonicalToolPolicySnapshot = {
    ...toolPolicySnapshot,
    generatedAt: metadata.generatedAt,
    policyHash: metadata.policyHash
  }

  const base = isValidManagedPolicySnapshot(currentPolicy) ? scrubSecretFields(currentPolicy) : {}

  return {
    allowedModels: asArray(base.allowedModels).map(String).filter(Boolean),
    auxiliaryPolicy: scrubSecretFields(base.auxiliaryPolicy || {}),
    apiMode: base.apiMode || null,
    capabilities: [...bootstrap.capabilities],
    currentModel: base.currentModel || null,
    currentModelProfileId: base.currentModelProfileId || null,
    defaultModel: base.defaultModel || null,
    generatedAt: metadata.generatedAt,
    lockedSurfaces: [...bootstrap.lockedSurfaces],
    manifestId: base.manifestId || null,
    modelProfiles: asArray(base.modelProfiles),
    modelRuntimeHash: base.modelRuntimeHash || null,
    policyHash: metadata.policyHash,
    policyVersion: metadata.policyVersion,
    protocolSnapshot: scrubSecretFields(base.protocolSnapshot || {}),
    providerRuntime: normalizeProviderRuntimeMetadata(base.providerRuntime),
    role: resolveRole({ bootstrap }),
    runtimeDefaults: scrubSecretFields(base.runtimeDefaults || {}),
    runtimeLimits: scrubSecretFields(base.runtimeLimits || {}),
    sessionId: base.sessionId || null,
    toolPolicySnapshot: canonicalToolPolicySnapshot,
    uiPolicy: normalizeEnterpriseUiPolicy({ bootstrap }),
    user: scrubSecretFields(bootstrap.user || bootstrap.account || null)
  }
}

function replaceManagedPolicySnapshot({ bootstrap, fsImpl = fs, hermesHome } = {}) {
  if (!hermesHome) {
    throw new Error('Managed Hermes home path is required.')
  }

  const current = readManagedPolicySnapshot({ fsImpl, hermesHome })
  const policy = buildRefreshedPolicySnapshot({ bootstrap, currentPolicy: current.policy })
  const policyPath = path.join(hermesHome, 'enterprise-policy.json')
  const temporaryPath = path.join(
    hermesHome,
    `.enterprise-policy.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  )

  fsImpl.mkdirSync(hermesHome, { recursive: true })
  try {
    fsImpl.writeFileSync(temporaryPath, JSON.stringify(policy, null, 2), { encoding: 'utf8', mode: 0o600 })
    fsImpl.renameSync(temporaryPath, policyPath)
  } catch (error) {
    try {
      if (fsImpl.existsSync(temporaryPath)) fsImpl.unlinkSync(temporaryPath)
    } catch {
      // Preserve the original write error; a leftover temp file is never used as policy.
    }
    throw error
  }

  return {
    ...policyRefreshMetadata(policy),
    policy,
    policyPath,
    replacedExistingPolicy: current.valid
  }
}

function modelProfileKey(profile) {
  return String(profile?.id || profile?.model || profile?.name || '').trim()
}

function mergedModelProfiles(manifestProfiles, fetchedProfiles) {
  const result = []
  const seen = new Set()

  for (const rawProfile of [...asArray(manifestProfiles), ...asArray(fetchedProfiles)]) {
    const profile = normalizeModelProfile(rawProfile)

    if (!profile) {
      continue
    }

    const key = modelProfileKey(profile)

    if (key && seen.has(key)) {
      continue
    }

    if (key) {
      seen.add(key)
    }

    result.push(profile)
  }

  return result
}

function publicEnterpriseState({ bootstrap = null, manifest = null, modelProfiles = [] } = {}) {
  const allowedModels = asArray(manifest?.allowedModels).map(String).filter(Boolean)
  const lockedSurfaces = asArray(manifest?.lockedSurfaces || bootstrap?.lockedSurfaces).map(String).filter(Boolean)
  const normalizedProfiles = mergedModelProfiles(manifest?.modelProfiles, modelProfiles)
  const defaultModel = manifest?.defaultModel || normalizedProfiles.find(profile => profile.isDefault)?.model || allowedModels[0] || null
  const currentModel = manifest?.currentModel || manifest?.selectedModel || defaultModel
  const currentModelProfileId = String(manifest?.currentModelProfileId || manifest?.defaultModelProfileId || '').trim()
  const currentModelProfile = currentModelProfileId
    ? normalizedProfiles.find(profile => String(profile.id || '').trim() === currentModelProfileId) || null
    : normalizedProfiles.find(profile => profile.model === currentModel || profile.id === currentModel) || null
  const providerRuntime = normalizeProviderRuntimeMetadata(manifest?.providerRuntime)
    || currentModelProfile?.providerRuntime
    || null

  return {
    allowedModels,
    authenticated: true,
    apiMode: resolveManifestApiMode(manifest),
    auxiliaryPolicy: scrubSecretFields(manifest?.auxiliaryPolicy || {}),
    capabilities: scrubSecretFields(manifest?.capabilities || bootstrap?.capabilities || {}),
    currentModel,
    currentModelProfileId: currentModelProfile?.id || null,
    defaultModel,
    enabled: true,
    lockedSurfaces,
    modelProfiles: normalizedProfiles,
    modelRuntimeHash: manifest?.modelRuntimeHash || null,
    generatedAt: manifest?.generatedAt || manifest?.toolPolicySnapshot?.generatedAt || null,
    policyHash: manifest?.policyHash || manifest?.toolPolicySnapshot?.policyHash || null,
    policyVersion: manifest?.policyVersion || bootstrap?.policyVersion || null,
    policyRefreshError: null,
    policyRefreshStatus: manifest?.policyHash || manifest?.toolPolicySnapshot?.policyHash ? 'current' : 'idle',
    policyStale: false,
    providerRuntime,
    protocolSnapshot: scrubSecretFields(manifest?.protocolSnapshot || {}),
    role: resolveRole({ bootstrap, manifest }),
    runtimeDefaults: scrubSecretFields(manifest?.runtimeDefaults || {}),
    runtimeLimits: scrubSecretFields(manifest?.runtimeLimits || {}),
    status: 'authenticated',
    toolPolicySnapshot: normalizeToolPolicySnapshot(manifest),
    uiPolicy: normalizeEnterpriseUiPolicy({ bootstrap, manifest }),
    user: bootstrap?.user || bootstrap?.account || null
  }
}

function buildManagedConfigYaml({ manifest, displayLanguage = ENTERPRISE_UI_POLICY_DEFAULT.defaultLocale }) {
  const gatewayBaseUrl = normalizeGatewayApiBaseUrl(manifest.gatewayApiBaseUrl || manifest.gatewayBaseUrl)
  const defaultModel = manifest.defaultModel || asArray(manifest.allowedModels)[0] || ''
  const apiMode = resolveManifestApiMode(manifest)
  const config = {
    agent: {
      api_max_retries: 1
    },
    display: {
      language: supportedDisplayLanguage(displayLanguage) || ENTERPRISE_UI_POLICY_DEFAULT.defaultLocale
    },
    model: {
      provider: MANAGED_PROVIDER,
      default: defaultModel,
      api_mode: apiMode
    },
    providers: {
      [MANAGED_PROVIDER]: {
        base_url: gatewayBaseUrl,
        key_env: GATEWAY_TOKEN_ENV,
        api_mode: apiMode,
        transport: apiMode
      }
    },
    managed: {
      enterprise_gateway: true,
      manifest_id: manifest.manifestId || null,
      policy_version: manifest.policyVersion || null,
      session_id: manifest.sessionId || null
    }
  }

  return `${yamlBlock(config)}\n`
}

function buildPolicySnapshot({ bootstrap = null, manifest = null, modelProfiles = [] } = {}) {
  const publicState = publicEnterpriseState({ bootstrap, manifest, modelProfiles })

  return {
    allowedModels: publicState.allowedModels,
    auxiliaryPolicy: publicState.auxiliaryPolicy,
    capabilities: publicState.capabilities,
    apiMode: publicState.apiMode,
    currentModel: publicState.currentModel,
    currentModelProfileId: publicState.currentModelProfileId,
    defaultModel: publicState.defaultModel,
    lockedSurfaces: publicState.lockedSurfaces,
    manifestId: manifest?.manifestId || null,
    modelProfiles: publicState.modelProfiles,
    modelRuntimeHash: publicState.modelRuntimeHash,
    generatedAt: publicState.generatedAt,
    policyHash: publicState.policyHash,
    policyVersion: manifest?.policyVersion || bootstrap?.policyVersion || null,
    providerRuntime: publicState.providerRuntime,
    protocolSnapshot: publicState.protocolSnapshot,
    role: resolveRole({ bootstrap, manifest }),
    runtimeDefaults: publicState.runtimeDefaults,
    runtimeLimits: publicState.runtimeLimits,
    sessionId: manifest?.sessionId || null,
    toolPolicySnapshot: publicState.toolPolicySnapshot,
    uiPolicy: publicState.uiPolicy,
    user: bootstrap?.user || bootstrap?.account || null
  }
}

function writeManagedRuntimeHome({ bootstrap, fsImpl = fs, hermesHome, manifest, modelProfiles = [] }) {
  if (!hermesHome) {
    throw new Error('Managed Hermes home path is required.')
  }

  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Runtime manifest is required.')
  }

  const gatewayToken = String(manifest.gatewayToken || '').trim()
  if (!gatewayToken) {
    throw new Error('Runtime manifest is missing gatewayToken.')
  }

  const policyPath = path.join(hermesHome, 'enterprise-policy.json')
  const configPath = path.join(hermesHome, 'config.yaml')
  const envPath = path.join(hermesHome, '.env')

  fsImpl.mkdirSync(hermesHome, { recursive: true })
  fsImpl.mkdirSync(path.join(hermesHome, 'logs'), { recursive: true })
  fsImpl.writeFileSync(
    configPath,
    buildManagedConfigYaml({
      manifest,
      displayLanguage: readManagedConfigDisplayLanguage({ configPath, fsImpl })
    }),
    'utf8'
  )
  fsImpl.writeFileSync(policyPath, JSON.stringify(buildPolicySnapshot({ bootstrap, manifest, modelProfiles }), null, 2), 'utf8')
  fsImpl.writeFileSync(
    envPath,
    [
      dotenvLine(GATEWAY_TOKEN_ENV, gatewayToken),
      'HERMES_ENTERPRISE_MANAGED=1',
      'HERMES_MODEL_CONTROL_MANAGED=1',
      dotenvLine('HERMES_ENTERPRISE_TOOL_POLICY_FILE', policyPath)
    ].join('\n') + '\n',
    'utf8'
  )

  return {
    configPath,
    env: {
      [GATEWAY_TOKEN_ENV]: gatewayToken,
      HERMES_ENTERPRISE_MANAGED: '1',
      HERMES_ENTERPRISE_TOOL_POLICY_FILE: policyPath,
      HERMES_HOME: hermesHome,
      HERMES_MODEL_CONTROL_MANAGED: '1'
    },
    envPath,
    hermesHome,
    policyPath,
    publicState: publicEnterpriseState({ bootstrap, manifest, modelProfiles })
  }
}

function resolveManagedHermesHome(userDataPath, user = null) {
  return path.join(userDataPath, 'enterprise', 'users', enterpriseUserPathSegment(user), 'hermes-home')
}

module.exports = {
  GATEWAY_TOKEN_ENV,
  ENTERPRISE_UI_POLICY_DEFAULT,
  MANAGED_PROVIDER,
  buildManagedConfigYaml,
  buildPolicySnapshot,
  buildRefreshedPolicySnapshot,
  enterpriseUserPathSegment,
  normalizeGatewayApiBaseUrl,
  normalizeEnterpriseUiPolicy,
  normalizeProviderRuntimeMetadata,
  normalizeToolPolicySnapshot,
  policyRefreshMetadata,
  publicEnterpriseState,
  readManagedPolicySnapshot,
  readManagedConfigDisplayLanguage,
  resolveRole,
  resolveManagedHermesHome,
  replaceManagedPolicySnapshot,
  scrubSecretFields,
  validateManagedBootstrap,
  writeManagedRuntimeHome,
  yamlBlock
}
