const { createEnterpriseGatewayClient } = require('./enterprise-gateway-client.cjs')
const {
  findEnterpriseDesktopConfig,
  normalizeEnterpriseDesktopGatewayUrl
} = require('./enterprise-desktop-config.cjs')
const {
  ENTERPRISE_UI_POLICY_DEFAULT,
  enterpriseUserId,
  readManagedPolicySnapshot,
  replaceManagedPolicySnapshot,
  resolveManagedHermesHome,
  validateManagedBootstrap,
  writeManagedRuntimeHome
} = require('./enterprise-runtime-home.cjs')

const ENTERPRISE_PROFILE_PREFIX = 'enterprise-profile:'
const TERMINAL_AUTH_STATUSES = new Set([401, 403])
const LKG_TRANSPORT_ERROR_CODES = new Set([
  'eai_again',
  'econnaborted',
  'econnrefused',
  'econnreset',
  'ehostunreach',
  'enetdown',
  'enetunreach',
  'enotfound',
  'etimedout',
  'gateway-offline',
  'gateway-timeout',
  'und_err_connect_timeout',
  'und_err_headers_timeout',
  'und_err_socket'
])
const OPERATION_SUPERSEDED = 'enterprise_operation_superseded'

class EnterpriseRuntimeOperationError extends Error {
  constructor(message = 'Enterprise operation was superseded by a newer authentication or lifecycle state.') {
    super(message)
    this.name = 'EnterpriseRuntimeOperationError'
    this.code = OPERATION_SUPERSEDED
  }
}

function numericStatus(error) {
  const status = Number(error?.status ?? error?.statusCode)
  return Number.isInteger(status) ? status : null
}

function isTerminalAuthError(error) {
  return TERMINAL_AUTH_STATUSES.has(numericStatus(error))
}

function canUseLastKnownGoodPolicy(error) {
  if (error?.code === 'enterprise_policy_payload_invalid') return false
  const status = numericStatus(error)
  if (status === null) {
    return LKG_TRANSPORT_ERROR_CODES.has(String(error?.code || '').trim().toLowerCase())
  }
  return status === 408 || status === 429 || status >= 500
}

function terminalPolicyState(error) {
  const status = numericStatus(error)
  if (TERMINAL_AUTH_STATUSES.has(status)) return 'unauthenticated'
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return 'blocked'
  if (['enterprise_policy_payload_invalid', 'enterprise_policy_user_mismatch'].includes(error?.code)) return 'blocked'
  return null
}

function resolveEnterpriseRuntimeOptions(env = process.env, { configPaths = [], readFileSync } = {}) {
  const { config, configPath } = findEnterpriseDesktopConfig(configPaths, { readFileSync })
  const hasDeploymentConfig = configPath !== null
  const rawGatewayUrl = hasDeploymentConfig
    ? config.gatewayUrl
    : String(env.HERMES_ENTERPRISE_GATEWAY_URL || env.HERMES_DESKTOP_ENTERPRISE_GATEWAY_URL || '').trim()
  const gatewayUrl = rawGatewayUrl
    ? normalizeEnterpriseDesktopGatewayUrl(rawGatewayUrl, hasDeploymentConfig ? configPath : 'environment')
    : ''
  const enabled = hasDeploymentConfig
    ? config.enabled
    : gatewayUrl.length > 0 || env.HERMES_ENTERPRISE_DESKTOP === '1'

  return {
    enabled,
    gatewayUrl
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
    policyRefreshError: null,
    policyRefreshStatus: 'idle',
    policyStale: false,
    policyVersion: null,
    providerRuntime: null,
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

function policyRefreshFailureMessage(error) {
  const status = Number(error?.status)

  return Number.isInteger(status) && status >= 400 && status <= 599
    ? `Enterprise policy refresh failed (HTTP ${status}).`
    : 'Enterprise policy refresh failed.'
}

function policyRefreshFailureCategory(error) {
  const status = Number(error?.status)
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return 'http_error'
  }

  return error?.code === 'enterprise_policy_payload_invalid' ? 'payload_invalid' : 'io_error'
}

function publicStateWithPolicy(state, policy, refresh = {}) {
  return {
    ...state,
    authenticated: true,
    capabilities: policy.capabilities || {},
    generatedAt: policy.generatedAt || null,
    lockedSurfaces: Array.isArray(policy.lockedSurfaces) ? policy.lockedSurfaces : [],
    policyHash: policy.policyHash || null,
    policyRefreshError: refresh.error || null,
    policyRefreshStatus: refresh.status || 'current',
    policyStale: Boolean(refresh.stale),
    policyVersion: policy.policyVersion || null,
    role: policy.role || null,
    status: 'authenticated',
    toolPolicySnapshot: policy.toolPolicySnapshot || null,
    uiPolicy: policy.uiPolicy || ENTERPRISE_UI_POLICY_DEFAULT,
    user: policy.user || state.user || null
  }
}

class EnterpriseRuntime {
  constructor({
    authStore,
    client,
    enabled,
    gatewayUrl,
    getLifecycle = null,
    homeWriter = writeManagedRuntimeHome,
    managedIdentityBinder = null,
    managedHermesHome,
    policyReader = readManagedPolicySnapshot,
    policyWriter = replaceManagedPolicySnapshot,
    rememberLog = () => {},
    onTerminalAuth = null,
    userDataPath
  } = {}) {
    this.enabled = Boolean(enabled)
    this.gatewayUrl = gatewayUrl || ''
    this.getLifecycle = typeof getLifecycle === 'function' ? getLifecycle : null
    this.authStore = authStore
    this.client = client || (this.enabled && this.gatewayUrl ? createEnterpriseGatewayClient({ baseUrl: this.gatewayUrl }) : null)
    this.homeWriter = homeWriter
    this.managedIdentityBinder = typeof managedIdentityBinder === 'function' ? managedIdentityBinder : null
    this.managedHermesHome = managedHermesHome || ''
    this.policyReader = policyReader
    this.policyWriter = policyWriter
    this.userDataPath = userDataPath || ''
    this.rememberLog = rememberLog
    this.onTerminalAuth = typeof onTerminalAuth === 'function' ? onTerminalAuth : null
    this.lastPublicState = this.enabled ? unauthenticatedState() : disabledState()
    this.lastLaunch = null
    this.policyRefreshPromise = null
    this.policyRefreshLease = null
    this.policyRefreshSessionKey = null
  }

  lifecycle() {
    return this.getLifecycle?.() || null
  }

  beginOperation({ advanceAuth = false, reasonCode = 'enterprise_operation_started' } = {}) {
    const lifecycle = this.lifecycle()
    if (!lifecycle) return null
    return advanceAuth ? lifecycle.advanceAuthEpoch(reasonCode) : lifecycle.acquireLease()
  }

  checkpoint(lease, { states = null } = {}) {
    if (!lease) return true
    const lifecycle = this.lifecycle()
    if (!lifecycle || !lifecycle.isLeaseCurrent(lease)) {
      throw new EnterpriseRuntimeOperationError()
    }
    if (Array.isArray(states) && !states.includes(lifecycle.getSnapshot().state)) {
      throw new EnterpriseRuntimeOperationError()
    }
    return true
  }

  async awaitCheckpoint(lease, promise, options) {
    this.checkpoint(lease, options)
    const value = await promise
    this.checkpoint(lease, options)
    return value
  }

  async enterTerminalState(error, lease, terminalState = 'unauthenticated') {
    this.checkpoint(lease)
    const terminalLease = this.beginOperation({
      advanceAuth: true,
      reasonCode: 'enterprise_auth_rejected'
    })
    this.checkpoint(terminalLease)
    if (terminalState === 'unauthenticated') {
      this.authStore.clear()
    }
    this.checkpoint(terminalLease)
    this.lastLaunch = null
    this.lastPublicState = unauthenticatedState(error?.message || 'Enterprise sign-in is required.')
    if (this.onTerminalAuth) {
      await this.onTerminalAuth({
        reasonCode: 'enterprise_auth_rejected',
        status: numericStatus(error),
        terminalState
      })
    }
    return this.lastPublicState
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

    return this.lastPublicState
  }

  async login(credentials) {
    if (!this.enabled) {
      return disabledState()
    }

    const lease = this.beginOperation({ advanceAuth: true, reasonCode: 'enterprise_login_started' })
    const session = await this.awaitCheckpoint(lease, this.client.login(credentials), {
      states: ['unauthenticated', 'recovering', 'running']
    })
    return this.acceptLoginSessionWithLease(session, lease)
  }

  async acceptLoginSession(session) {
    if (!this.enabled) {
      return disabledState()
    }

    const lease = this.beginOperation({ advanceAuth: true, reasonCode: 'enterprise_login_session_received' })
    return this.acceptLoginSessionWithLease(session, lease)
  }

  async acceptLoginSessionWithLease(session, lease) {
    const checkpointOptions = { states: ['unauthenticated', 'recovering', 'running'] }

    try {
      this.checkpoint(lease, checkpointOptions)
      this.authStore.writeSession(session)
      this.checkpoint(lease, checkpointOptions)
    } catch (error) {
      if (!lease || this.lifecycle()?.isLeaseCurrent(lease)) {
        this.authStore.clear?.()
      }
      if (session?.desktopToken) {
        await this.client.logout(session.desktopToken).catch(logoutError => {
          this.rememberLog(`[enterprise] rejected session revoke failed: ${logoutError.message}`)
        })
      }
      throw error
    }
    this.checkpoint(lease, checkpointOptions)
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

    const lease = this.beginOperation({ advanceAuth: true, reasonCode: 'enterprise_logout_started' })
    this.checkpoint(lease)
    const session = this.authStore.readSession()

    if (session?.desktopToken) {
      await this.awaitCheckpoint(
        lease,
        this.client.logout(session.desktopToken).catch(error => {
          this.rememberLog(`[enterprise] logout request failed: ${error.message}`)
        })
      )
    }

    this.checkpoint(lease)
    this.authStore.clear()
    this.checkpoint(lease)
    this.lastLaunch = null
    this.lastPublicState = unauthenticatedState()

    return this.lastPublicState
  }

  async refreshPublicState() {
    if (!this.enabled) {
      return disabledState()
    }

    const lease = this.beginOperation()
    const session = this.authStore.readSession()

    if (!session?.desktopToken) {
      this.checkpoint(lease)
      this.lastPublicState = unauthenticatedState()
      return this.lastPublicState
    }

    try {
      const me = await this.awaitCheckpoint(lease, this.client.me(session.desktopToken), {
        states: ['recovering', 'running']
      })
      this.checkpoint(lease, { states: ['recovering', 'running'] })
      this.lastPublicState = {
        ...this.lastPublicState,
        authenticated: true,
        error: null,
        status: 'authenticated',
        user: me?.user || me?.account || session.user || null
      }
    } catch (error) {
      this.checkpoint(lease)
      if (isTerminalAuthError(error)) {
        return this.enterTerminalState(error, lease, 'unauthenticated')
      }
      this.lastPublicState = unauthenticatedState(error.message)
    }

    return this.lastPublicState
  }

  refreshPolicy() {
    const lease = this.beginOperation()
    const session = this.authStore.readSession()
    const sessionKey = `${enterpriseUserId(session?.user) || ''}:${String(session?.desktopToken || '')}`
    const priorLeaseCurrent = !this.policyRefreshLease || this.lifecycle()?.isLeaseCurrent(this.policyRefreshLease)
    if (this.policyRefreshPromise && priorLeaseCurrent && this.policyRefreshSessionKey === sessionKey) {
      return this.policyRefreshPromise
    }

    let operationWithCleanup
    operationWithCleanup = this.refreshPolicyOnce({ lease, session }).finally(() => {
      if (this.policyRefreshPromise === operationWithCleanup) {
        this.policyRefreshPromise = null
        this.policyRefreshLease = null
        this.policyRefreshSessionKey = null
      }
    })
    this.policyRefreshPromise = operationWithCleanup
    this.policyRefreshLease = lease
    this.policyRefreshSessionKey = sessionKey

    return operationWithCleanup
  }

  async refreshPolicyOnce({ lease = this.beginOperation(), session = this.authStore.readSession() } = {}) {
    if (!this.enabled) {
      return disabledState()
    }

    if (!session?.desktopToken) {
      this.checkpoint(lease)
      this.lastPublicState = unauthenticatedState('Enterprise sign-in is required before refreshing policy.')
      return this.lastPublicState
    }

    const expectedUserId = enterpriseUserId(session.user)
    const hermesHome = this.managedHomeFor({ session })

    try {
      const bootstrap = await this.awaitCheckpoint(lease, this.client.bootstrap(session.desktopToken), {
        states: ['recovering', 'running']
      })
      // Do not derive or bind a managed identity from an authenticated 200
      // until the complete bootstrap contract has passed validation.
      validateManagedBootstrap(bootstrap)
      this.checkpoint(lease, { states: ['recovering', 'running'] })
      const bootstrapUserId = enterpriseUserId(bootstrap?.user || bootstrap?.account)
      if (!bootstrapUserId || (expectedUserId && expectedUserId !== bootstrapUserId)) {
        const error = new Error('Enterprise policy bootstrap user does not match the authenticated desktop session.')
        error.code = 'enterprise_policy_user_mismatch'
        throw error
      }
      const bootstrapHome = this.managedHomeFor({ bootstrap, session })
      this.checkpoint(lease, { states: ['recovering', 'running'] })
      this.bindManagedIdentity({ bootstrap, hermesHome: bootstrapHome, session })
      this.checkpoint(lease, { states: ['recovering', 'running'] })
      const result = this.policyWriter({ bootstrap, hermesHome: bootstrapHome })
      this.checkpoint(lease, { states: ['recovering', 'running'] })
      this.lastPublicState = publicStateWithPolicy(this.lastPublicState, result.policy, {
        status: 'current',
        stale: false
      })
      this.rememberLog('[enterprise-policy] refresh succeeded')
    } catch (error) {
      this.checkpoint(lease)
      const message = policyRefreshFailureMessage(error)
      const category = policyRefreshFailureCategory(error)
      const status = numericStatus(error) ?? 'n/a'

      const terminalState = terminalPolicyState(error)
      if (terminalState) {
        this.rememberLog(`[enterprise-policy] refresh failed category=${category} status=${status} lastKnownGood=false`)
        return this.enterTerminalState(error, lease, terminalState)
      }

      const mayUseLkg = canUseLastKnownGoodPolicy(error) && Boolean(expectedUserId)
      const cached = mayUseLkg
        ? this.policyReader({ expectedUserId, hermesHome })
        : { policy: null, reason: 'fallback_not_allowed', valid: false }

      this.rememberLog(`[enterprise-policy] refresh failed category=${category} status=${status} lastKnownGood=${cached.valid}`)

      if (cached.valid) {
        this.lastPublicState = publicStateWithPolicy(this.lastPublicState, cached.policy, {
          error: message,
          status: 'stale',
          stale: true
        })
      } else {
        this.lastPublicState = {
          ...this.lastPublicState,
          authenticated: true,
          generatedAt: null,
          policyHash: null,
          policyRefreshError: message,
          policyRefreshStatus: 'failed',
          policyStale: false,
          policyVersion: null,
          status: 'authenticated',
          toolPolicySnapshot: null
        }
      }
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

  bindManagedIdentity({ bootstrap = null, hermesHome, session = null } = {}) {
    const user = bootstrap?.user || bootstrap?.account || session?.user || null
    this.managedIdentityBinder?.({ hermesHome, user })
    return hermesHome
  }

  async prepareLaunch({ preferredModel } = {}) {
    if (!this.enabled) {
      return { enabled: false }
    }

    const lease = this.beginOperation()
    const checkpointOptions = { states: ['recovering', 'running'] }
    const session = this.authStore.readSession()

    if (!session?.desktopToken) {
      this.checkpoint(lease)
      this.lastPublicState = unauthenticatedState('Enterprise sign-in is required before starting Hermes.')
      throw new Error('Enterprise sign-in is required before starting Hermes.')
    }

    try {
      const bootstrap = await this.awaitCheckpoint(lease, this.client.bootstrap(session.desktopToken), checkpointOptions)
      validateManagedBootstrap(bootstrap)
      this.checkpoint(lease, checkpointOptions)
      const expectedUserId = enterpriseUserId(session.user)
      const bootstrapUserId = enterpriseUserId(bootstrap?.user || bootstrap?.account)
      if (!bootstrapUserId || (expectedUserId && expectedUserId !== bootstrapUserId)) {
        const error = new Error('Enterprise runtime bootstrap user does not match the authenticated desktop session.')
        error.code = 'enterprise_policy_user_mismatch'
        throw error
      }
      const modelProfilesPayload = await this.awaitCheckpoint(
        lease,
        this.client.modelProfiles(session.desktopToken),
        checkpointOptions
      )
      const modelProfiles = extractModelProfilesResponse(modelProfilesPayload)
      const effectivePreferredModel = preferredModel || preferredModelFromPublicState(this.lastPublicState)

      const manifest = await this.awaitCheckpoint(
        lease,
        this.client.runtimeManifest(
          session.desktopToken,
          runtimeManifestRequestBody({ modelProfiles, preferredModel: effectivePreferredModel })
        ),
        checkpointOptions
      )

      this.checkpoint(lease, checkpointOptions)
      const hermesHome = this.bindManagedIdentity({
        bootstrap,
        hermesHome: this.managedHomeFor({ bootstrap, session }),
        session
      })
      this.checkpoint(lease, checkpointOptions)
      const launch = this.homeWriter({
        bootstrap,
        hermesHome,
        manifest,
        modelProfiles
      })
      this.checkpoint(lease, checkpointOptions)

      this.lastLaunch = launch
      this.lastPublicState = launch.publicState

      return {
        enabled: true,
        env: launch.env,
        hermesHome: launch.hermesHome,
        publicState: launch.publicState
      }
    } catch (error) {
      this.checkpoint(lease)
      const terminalState = terminalPolicyState(error)
      if (terminalState) await this.enterTerminalState(error, lease, terminalState)
      throw error
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

    const lease = this.beginOperation()
    const checkpointOptions = { states: ['recovering', 'running'] }
    const session = this.authStore.readSession()
    if (!session?.desktopToken) {
      this.checkpoint(lease)
      this.lastPublicState = unauthenticatedState('Enterprise sign-in is required before selecting a model.')
      throw new Error('Enterprise sign-in is required before selecting a model.')
    }

    if (!publicStateAllowsModel(this.lastPublicState, model)) {
      throw new Error(`Model is not allowed by enterprise policy: ${model}`)
    }

    try {
      this.checkpoint(lease, checkpointOptions)
      const bootstrap = await this.awaitCheckpoint(lease, this.client.bootstrap(session.desktopToken), checkpointOptions)
      validateManagedBootstrap(bootstrap)
      this.checkpoint(lease, checkpointOptions)
      const expectedUserId = enterpriseUserId(session.user)
      const bootstrapUserId = enterpriseUserId(bootstrap?.user || bootstrap?.account)
      if (!bootstrapUserId || (expectedUserId && expectedUserId !== bootstrapUserId)) {
        const error = new Error('Enterprise runtime bootstrap user does not match the authenticated desktop session.')
        error.code = 'enterprise_policy_user_mismatch'
        throw error
      }
      const modelProfiles = await this.awaitCheckpoint(
        lease,
        this.client.modelProfiles(session.desktopToken),
        checkpointOptions
      )
      const profiles = extractModelProfilesResponse(modelProfiles)
      const manifest = await this.awaitCheckpoint(
        lease,
        this.client.runtimeManifest(
          session.desktopToken,
          runtimeManifestRequestBody({ modelProfiles: profiles, preferredModel: model })
        ),
        checkpointOptions
      )

      this.checkpoint(lease, checkpointOptions)
      const hermesHome = this.bindManagedIdentity({
        bootstrap,
        hermesHome: this.managedHomeFor({ bootstrap, session }),
        session
      })
      this.checkpoint(lease, checkpointOptions)
      const launch = this.homeWriter({
        bootstrap,
        hermesHome,
        manifest,
        modelProfiles: profiles
      })
      this.checkpoint(lease, checkpointOptions)

      this.lastLaunch = launch
      this.lastPublicState = launch.publicState

      return this.lastPublicState
    } catch (error) {
      this.checkpoint(lease)
      const terminalState = terminalPolicyState(error)
      if (terminalState) await this.enterTerminalState(error, lease, terminalState)
      throw error
    }
  }
}

function createEnterpriseRuntime(options) {
  return new EnterpriseRuntime(options)
}

module.exports = {
  canUseLastKnownGoodPolicy,
  EnterpriseRuntime,
  EnterpriseRuntimeOperationError,
  createEnterpriseRuntime,
  disabledState,
  extractModelProfilesResponse,
  publicStateAllowsModel,
  policyRefreshFailureCategory,
  resolveEnterpriseRuntimeOptions,
  runtimeManifestRequestBody,
  policyRefreshFailureMessage,
  publicStateWithPolicy,
  unauthenticatedState
}
