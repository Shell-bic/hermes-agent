const { createEnterpriseGatewayClient, normalizeEnterpriseGatewayBaseUrl } = require('./enterprise-gateway-client.cjs')
const {
  ENTERPRISE_UI_POLICY_DEFAULT,
  resolveManagedHermesHome,
  writeManagedRuntimeHome
} = require('./enterprise-runtime-home.cjs')

const ENTERPRISE_PROFILE_PREFIX = 'enterprise-profile:'

function resolveEnterpriseRuntimeOptions(env = process.env) {
  const gatewayUrl = String(env.HERMES_ENTERPRISE_GATEWAY_URL || env.HERMES_DESKTOP_ENTERPRISE_GATEWAY_URL || '').trim()
  const enabled = gatewayUrl.length > 0 || env.HERMES_ENTERPRISE_DESKTOP === '1'

  return {
    enabled,
    gatewayUrl: gatewayUrl ? normalizeEnterpriseGatewayBaseUrl(gatewayUrl) : ''
  }
}

function disabledState() {
  return {
    allowedModels: [],
    authenticated: false,
    apiMode: null,
    auxiliaryPolicy: {},
    capabilities: {},
    currentModel: null,
    currentModelProfileId: null,
    defaultModel: null,
    enabled: false,
    generatedAt: null,
    lockedSurfaces: [],
    modelRuntimeHash: null,
    modelProfiles: [],
    policyHash: null,
    policyVersion: null,
    protocolSnapshot: null,
    role: null,
    runtimeDefaults: {},
    runtimeLimits: {},
    status: 'disabled',
    toolPolicySnapshot: null,
    user: null
  }
}

function unauthenticatedState(error = null) {
  return {
    ...disabledState(),
    enabled: true,
    error,
    status: error ? 'error' : 'unauthenticated',
    uiPolicy: ENTERPRISE_UI_POLICY_DEFAULT
  }
}

function enterpriseProfileIdFromSelection(selection) {
  const value = String(selection || '').trim()

  return value.startsWith(ENTERPRISE_PROFILE_PREFIX) ? value.slice(ENTERPRISE_PROFILE_PREFIX.length).trim() : ''
}

function profileValues(profile) {
  if (!profile || typeof profile !== 'object') {
    return []
  }

  return [profile.id, profile.model, profile.name, `${ENTERPRISE_PROFILE_PREFIX}${profile.id || ''}`]
    .map(value => String(value || '').trim())
    .filter(Boolean)
}

function findProfileForSelection(modelProfiles, selection) {
  const value = String(selection || '').trim()
  if (!value) {
    return null
  }

  const profileId = enterpriseProfileIdFromSelection(value)

  for (const profile of modelProfiles || []) {
    if (profileId && String(profile?.id || '').trim() === profileId) {
      return profile
    }

    if (profileValues(profile).includes(value)) {
      return profile
    }
  }

  return null
}

function runtimeManifestRequestBody({ modelProfiles = [], preferredModel } = {}) {
  const model = String(preferredModel || '').trim()

  if (!model) {
    return {}
  }

  const profile = findProfileForSelection(modelProfiles, model)
  if (profile?.id) {
    return {
      preferredModel: String(profile.model || '').trim() || model,
      preferredModelProfileId: String(profile.id).trim()
    }
  }

  const profileId = enterpriseProfileIdFromSelection(model)

  return profileId ? { preferredModelProfileId: profileId } : { preferredModel: model }
}

function preferredModelFromPublicState(state) {
  const profileId = String(state?.currentModelProfileId || '').trim()
  if (profileId) {
    return `${ENTERPRISE_PROFILE_PREFIX}${profileId}`
  }

  return String(state?.currentModel || '').trim()
}

function modelProfileValues(profile) {
  return profileValues(profile)
}

function extractModelProfilesResponse(payload, seen = new Set()) {
  if (Array.isArray(payload)) {
    return payload
  }

  if (!payload || typeof payload !== 'object' || seen.has(payload)) {
    return []
  }

  seen.add(payload)

  for (const key of ['modelProfiles', 'profiles', 'items', 'models', 'results', 'data']) {
    const value = payload[key]
    if (Array.isArray(value)) {
      return value
    }

    const nested = extractModelProfilesResponse(value, seen)
    if (nested.length > 0) {
      return nested
    }
  }

  return []
}

function publicStateAllowsModel(state, model) {
  const requested = String(model || '').trim()
  if (!requested) {
    return false
  }

  const allowedModels = Array.isArray(state?.allowedModels) ? state.allowedModels.map(item => String(item || '').trim()) : []
  if (allowedModels.includes(requested)) {
    return true
  }

  const profiles = Array.isArray(state?.modelProfiles) ? state.modelProfiles : []
  return profiles.some(profile => modelProfileValues(profile).includes(requested))
}

class EnterpriseRuntime {
  constructor({
    authStore,
    client,
    enabled,
    gatewayUrl,
    homeWriter = writeManagedRuntimeHome,
    managedHermesHome,
    rememberLog = () => {},
    userDataPath
  } = {}) {
    this.enabled = Boolean(enabled)
    this.gatewayUrl = gatewayUrl || ''
    this.authStore = authStore
    this.client = client || (this.enabled && this.gatewayUrl ? createEnterpriseGatewayClient({ baseUrl: this.gatewayUrl }) : null)
    this.homeWriter = homeWriter
    this.managedHermesHome = managedHermesHome || ''
    this.userDataPath = userDataPath || ''
    this.rememberLog = rememberLog
    this.lastPublicState = this.enabled ? unauthenticatedState() : disabledState()
    this.lastLaunch = null
  }

  isEnabled() {
    return this.enabled
  }

  hasStoredSession() {
    return Boolean(this.authStore?.readSession()?.desktopToken)
  }

  getPublicState() {
    if (!this.enabled) {
      return disabledState()
    }

    const cached = this.authStore?.readPublicSession?.()
    if (cached && this.lastPublicState.status === 'unauthenticated') {
      return {
        ...this.lastPublicState,
        authenticated: true,
        status: 'authenticated',
        user: cached.user || null
      }
    }

    return this.lastPublicState
  }

  async login(credentials) {
    if (!this.enabled) {
      return disabledState()
    }

    const session = await this.client.login(credentials)
    this.authStore.writeSession(session)
    this.lastPublicState = {
      ...unauthenticatedState(),
      authenticated: true,
      error: null,
      status: 'authenticated',
      user: session.user || null
    }

    return this.lastPublicState
  }

  async logout() {
    if (!this.enabled) {
      return disabledState()
    }

    const session = this.authStore.readSession()

    if (session?.desktopToken) {
      await this.client.logout(session.desktopToken).catch(error => {
        this.rememberLog(`[enterprise] logout request failed: ${error.message}`)
      })
    }

    this.authStore.clear()
    this.lastLaunch = null
    this.lastPublicState = unauthenticatedState()

    return this.lastPublicState
  }

  async refreshPublicState() {
    if (!this.enabled) {
      return disabledState()
    }

    const session = this.authStore.readSession()

    if (!session?.desktopToken) {
      this.lastPublicState = unauthenticatedState()
      return this.lastPublicState
    }

    try {
      const me = await this.client.me(session.desktopToken)
      this.lastPublicState = {
        ...this.lastPublicState,
        authenticated: true,
        error: null,
        status: 'authenticated',
        user: me?.user || me?.account || session.user || null
      }
    } catch (error) {
      this.lastPublicState = unauthenticatedState(error.message)
    }

    return this.lastPublicState
  }

  managedHomeFor({ bootstrap = null, session = null } = {}) {
    if (this.managedHermesHome) {
      return this.managedHermesHome
    }

    const user = bootstrap?.user || bootstrap?.account || session?.user || null
    if (!this.userDataPath) {
      return ''
    }

    return resolveManagedHermesHome(this.userDataPath, user)
  }

  async prepareLaunch({ preferredModel } = {}) {
    if (!this.enabled) {
      return { enabled: false }
    }

    const session = this.authStore.readSession()

    if (!session?.desktopToken) {
      this.lastPublicState = unauthenticatedState('Enterprise sign-in is required before starting Hermes.')
      throw new Error('Enterprise sign-in is required before starting Hermes.')
    }

    const [bootstrap, modelProfilesPayload] = await Promise.all([
      this.client.bootstrap(session.desktopToken),
      this.client.modelProfiles(session.desktopToken)
    ])
    const modelProfiles = extractModelProfilesResponse(modelProfilesPayload)
    const effectivePreferredModel = preferredModel || preferredModelFromPublicState(this.lastPublicState)

    const manifest = await this.client.runtimeManifest(
      session.desktopToken,
      runtimeManifestRequestBody({ modelProfiles, preferredModel: effectivePreferredModel })
    )

    const launch = this.homeWriter({
      bootstrap,
      hermesHome: this.managedHomeFor({ bootstrap, session }),
      manifest,
      modelProfiles
    })

    this.lastLaunch = launch
    this.lastPublicState = launch.publicState

    return {
      enabled: true,
      env: launch.env,
      hermesHome: launch.hermesHome,
      publicState: launch.publicState
    }
  }

  async selectModel(preferredModel) {
    if (!this.enabled) {
      return disabledState()
    }

    const model = String(preferredModel || '').trim()
    if (!model) {
      throw new Error('Enterprise model selection requires a model.')
    }

    const session = this.authStore.readSession()
    if (!session?.desktopToken) {
      this.lastPublicState = unauthenticatedState('Enterprise sign-in is required before selecting a model.')
      throw new Error('Enterprise sign-in is required before selecting a model.')
    }

    if (!publicStateAllowsModel(this.lastPublicState, model)) {
      throw new Error(`Model is not allowed by enterprise policy: ${model}`)
    }

    const [bootstrap, modelProfiles] = await Promise.all([
      this.client.bootstrap(session.desktopToken),
      this.client.modelProfiles(session.desktopToken)
    ])
    const profiles = extractModelProfilesResponse(modelProfiles)
    const manifest = await this.client.runtimeManifest(
      session.desktopToken,
      runtimeManifestRequestBody({ modelProfiles: profiles, preferredModel: model })
    )

    const launch = this.homeWriter({
      bootstrap,
      hermesHome: this.managedHomeFor({ bootstrap, session }),
      manifest,
      modelProfiles: profiles
    })

    this.lastLaunch = launch
    this.lastPublicState = launch.publicState

    return this.lastPublicState
  }
}

function createEnterpriseRuntime(options) {
  return new EnterpriseRuntime(options)
}

module.exports = {
  EnterpriseRuntime,
  createEnterpriseRuntime,
  disabledState,
  extractModelProfilesResponse,
  publicStateAllowsModel,
  resolveEnterpriseRuntimeOptions,
  runtimeManifestRequestBody,
  unauthenticatedState
}
