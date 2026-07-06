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

function asArray(value) {
  return Array.isArray(value) ? value : []
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

  return {
    apiFormat: profile.apiFormat || profile.transport || null,
    auxiliaryPolicy: scrubSecretFields(profile.auxiliaryPolicy || {}),
    capabilities: scrubSecretFields(profile.capabilities || {}),
    displayName: profile.displayName || profile.name || profile.model || profile.id || null,
    id,
    isDefault: Boolean(profile.isDefault),
    model,
    modelProviderId: profile.modelProviderId || profile.providerId || null,
    name: profile.name || profile.displayName || profile.model || profile.id || null,
    pricing: scrubSecretFields(profile.pricing || {}),
    provider,
    providerName: profile.providerName || provider?.name || null,
    providerType: profile.providerType || provider?.type || null,
    runtimeDefaults: scrubSecretFields(profile.runtimeDefaults || {})
  }
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
  const currentProfile = normalizedProfiles.find(profile => profile.model === currentModel || profile.id === currentModel)
    || normalizedProfiles.find(profile => profile.isDefault)
    || normalizedProfiles[0]
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
    if (/secret|token|api[_-]?key|password|credential/i.test(key)) {
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

function publicEnterpriseState({ bootstrap = null, manifest = null, modelProfiles = [] } = {}) {
  const allowedModels = asArray(manifest?.allowedModels).map(String).filter(Boolean)
  const lockedSurfaces = asArray(manifest?.lockedSurfaces || bootstrap?.lockedSurfaces).map(String).filter(Boolean)
  const normalizedProfiles = asArray(manifest?.modelProfiles || modelProfiles)
    .map(normalizeModelProfile)
    .filter(Boolean)
  const defaultModel = manifest?.defaultModel || normalizedProfiles.find(profile => profile.isDefault)?.model || allowedModels[0] || null
  const currentModel = manifest?.currentModel || manifest?.selectedModel || defaultModel
  const currentModelProfile =
    normalizedProfiles.find(profile => profile.model === currentModel || profile.id === currentModel) || null

  return {
    allowedModels,
    authenticated: true,
    auxiliaryPolicy: scrubSecretFields(manifest?.auxiliaryPolicy || {}),
    capabilities: scrubSecretFields(manifest?.capabilities || bootstrap?.capabilities || {}),
    currentModel,
    currentModelProfileId: currentModelProfile?.id || null,
    defaultModel,
    enabled: true,
    lockedSurfaces,
    modelProfiles: normalizedProfiles,
    policyVersion: manifest?.policyVersion || bootstrap?.policyVersion || null,
    role: resolveRole({ bootstrap, manifest }),
    runtimeDefaults: scrubSecretFields(manifest?.runtimeDefaults || {}),
    status: 'authenticated',
    uiPolicy: normalizeEnterpriseUiPolicy({ bootstrap, manifest }),
    user: bootstrap?.user || bootstrap?.account || null
  }
}

function buildManagedConfigYaml({ manifest, displayLanguage = ENTERPRISE_UI_POLICY_DEFAULT.defaultLocale }) {
  const gatewayBaseUrl = normalizeGatewayApiBaseUrl(manifest.gatewayApiBaseUrl || manifest.gatewayBaseUrl)
  const defaultModel = manifest.defaultModel || asArray(manifest.allowedModels)[0] || ''
  const apiMode = resolveManifestApiMode(manifest)
  const config = {
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
    currentModel: publicState.currentModel,
    currentModelProfileId: publicState.currentModelProfileId,
    defaultModel: publicState.defaultModel,
    lockedSurfaces: publicState.lockedSurfaces,
    manifestId: manifest?.manifestId || null,
    modelProfiles: publicState.modelProfiles,
    policyVersion: manifest?.policyVersion || bootstrap?.policyVersion || null,
    role: resolveRole({ bootstrap, manifest }),
    runtimeDefaults: publicState.runtimeDefaults,
    sessionId: manifest?.sessionId || null,
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
  enterpriseUserPathSegment,
  normalizeGatewayApiBaseUrl,
  normalizeEnterpriseUiPolicy,
  publicEnterpriseState,
  readManagedConfigDisplayLanguage,
  resolveRole,
  resolveManagedHermesHome,
  scrubSecretFields,
  writeManagedRuntimeHome,
  yamlBlock
}
