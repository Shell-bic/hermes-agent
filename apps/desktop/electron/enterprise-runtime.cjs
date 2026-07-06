const { createEnterpriseGatewayClient, normalizeEnterpriseGatewayBaseUrl } = require('./enterprise-gateway-client.cjs')
const {
  ENTERPRISE_UI_POLICY_DEFAULT,
  resolveManagedHermesHome,
  writeManagedRuntimeHome
} = require('./enterprise-runtime-home.cjs')

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
    auxiliaryPolicy: {},
    capabilities: {},
    currentModel: null,
    currentModelProfileId: null,
    defaultModel: null,
    enabled: false,
    lockedSurfaces: [],
    modelProfiles: [],
    policyVersion: null,
    role: null,
    runtimeDefaults: {},
    status: 'disabled',
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

function runtimeManifestRequestBody({ preferredModel } = {}) {
  const model = String(preferredModel || '').trim()

  return model ? { preferredModel: model } : {}
}

function modelProfileValues(profile) {
  if (!profile || typeof profile !== 'object') {
    return []
  }

  return [profile.id, profile.model, profile.name].map(value => String(value || '').trim()).filter(Boolean)
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

    const [bootstrap, modelProfiles] = await Promise.all([
      this.client.bootstrap(session.desktopToken),
      this.client.modelProfiles(session.desktopToken)
    ])

    const manifest = await this.client.runtimeManifest(
      session.desktopToken,
      runtimeManifestRequestBody({ preferredModel })
    )

    const launch = this.homeWriter({
      bootstrap,
      hermesHome: this.managedHomeFor({ bootstrap, session }),
      manifest,
      modelProfiles: Array.isArray(modelProfiles) ? modelProfiles : modelProfiles?.modelProfiles || modelProfiles?.profiles || []
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
    const profiles = Array.isArray(modelProfiles) ? modelProfiles : modelProfiles?.modelProfiles || modelProfiles?.profiles || []
    const manifest = await this.client.runtimeManifest(
      session.desktopToken,
      runtimeManifestRequestBody({ preferredModel: model })
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
  publicStateAllowsModel,
  resolveEnterpriseRuntimeOptions,
  runtimeManifestRequestBody,
  unauthenticatedState
}
