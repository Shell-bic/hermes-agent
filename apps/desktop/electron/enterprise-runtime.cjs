const { createEnterpriseGatewayClient } = require('./enterprise-gateway-client.cjs')
const { createEnterprisePublicError } = require('./enterprise-public-error.cjs')
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
const TERMINAL_AUTH_STATUSES = new Set([401])
const TERMINAL_POLICY_CODES = new Set([
  'desktop_active_role_required',
  'desktop_bootstrap_contract_header_invalid',
  'desktop_bootstrap_contract_upgrade_required',
  'enterprise_desktop_contract_too_old',
  'enterprise_gateway_contract_invalid',
  'enterprise_gateway_contract_too_old',
  'enterprise_policy_payload_invalid',
  'enterprise_policy_user_mismatch'
])
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
  if (TERMINAL_POLICY_CODES.has(error?.code)) return 'blocked'
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
    gatewayUrl,
    ...(config.weComGatewayRunnerExperiment === true ? { weComGatewayRunnerExperiment: true } : {})
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

function blockedState({ error, session, terminalError } = {}) {
  return {
    ...disabledState(),
    authenticated: Boolean(session?.desktopToken),
    enabled: true,
    error: error || terminalError?.message || 'Enterprise policy blocked Desktop startup.',
    status: 'error',
    terminalError: terminalError || null,
    uiPolicy: ENTERPRISE_UI_POLICY_DEFAULT,
    user: session?.user || null
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
    this.policyRefreshOperation = null
    this.policyRefreshSessionKey = null
    this.latestOperations = new Map()
  }

  lifecycle() {
    return this.getLifecycle?.() || null
  }

  beginOperation({ advanceAuth = false, allowedStates = null, reasonCode = 'enterprise_operation_started' } = {}) {
    const lifecycle = this.lifecycle()
    if (!lifecycle) return null
    if (Array.isArray(allowedStates) && !allowedStates.includes(lifecycle.getSnapshot().state)) {
      throw new EnterpriseRuntimeOperationError()
    }
    return advanceAuth ? lifecycle.advanceAuthEpoch(reasonCode) : lifecycle.acquireLease()
  }

  beginLatestOperation(scope, options = {}) {
    const generation = (this.latestOperations.get(scope) || 0) + 1
    const lease = this.beginOperation(options)
    this.latestOperations.set(scope, generation)
    return Object.freeze({ generation, lease, scope })
  }

  latestCheckpoint(operation, options) {
    this.checkpoint(operation?.lease, options)
    if (!operation || this.latestOperations.get(operation.scope) !== operation.generation) {
      throw new EnterpriseRuntimeOperationError()
    }
    return true
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

  async awaitCheckpoint(lease, operation, options) {
    this.checkpoint(lease, options)
    if (typeof operation !== 'function') {
      throw new TypeError('Enterprise runtime guarded awaits require a deferred operation function.')
    }
    const value = await operation()
    this.checkpoint(lease, options)
    return value
  }

  async awaitLatestCheckpoint(latestOperation, operation, options) {
    this.latestCheckpoint(latestOperation, options)
    if (typeof operation !== 'function') {
      throw new TypeError('Enterprise runtime guarded awaits require a deferred operation function.')
    }
    const value = await operation()
    this.latestCheckpoint(latestOperation, options)
    return value
  }

  async enterTerminalState(error, lease, terminalState = 'unauthenticated') {
    this.checkpoint(lease)
    const terminalLease = this.beginOperation({
      advanceAuth: true,
      reasonCode: 'enterprise_auth_rejected'
    })
    this.checkpoint(terminalLease)
    const session = this.authStore.readSession()
    if (terminalState === 'unauthenticated') {
      this.authStore.clear()
    }
    this.checkpoint(terminalLease)
    this.lastLaunch = null
    if (this.onTerminalAuth) {
      await this.onTerminalAuth({
        reasonCode: 'enterprise_auth_rejected',
        status: numericStatus(error),
        terminalState
      })
    }
    const terminalError = createEnterprisePublicError(error, {
      lifecycle: this.lifecycle(),
      useCurrentEpoch: true
    })
    this.lastPublicState = terminalState === 'unauthenticated'
      ? { ...unauthenticatedState(terminalError.message), terminalError }
      : blockedState({ session, terminalError })
    return this.lastPublicState
  }

  isEnabled() {
    return this.enabled
  }

  hasStoredSession() {
    return Boolean(this.authStore?.readSession()?.desktopToken)
  }

  getDesktopToken() {
    if (!this.enabled) return ''
    return String(this.authStore?.readSession()?.desktopToken || '').trim()
  }

  getGatewayToken() {
    if (!this.enabled) return ''
    return String(this.lastLaunch?.env?.COMPANY_GATEWAY_TOKEN || '').trim()
  }

  getManagedHermesHome() {
    if (!this.enabled) return ''
    return String(this.lastLaunch?.hermesHome || this.managedHomeFor({ session: this.authStore?.readSession?.() })).trim()
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

    const allowedStates = ['unauthenticated', 'recovering', 'running']
    const lease = this.beginOperation({ advanceAuth: true, allowedStates, reasonCode: 'enterprise_login_started' })
    const session = await this.awaitCheckpoint(lease, () => this.client.login(credentials), {
      states: allowedStates
    })
    return this.acceptLoginSessionWithLease(session, lease)
  }

  async acceptLoginSession(session) {
    if (!this.enabled) {
      return disabledState()
    }

    const lease = this.beginOperation({
      advanceAuth: true,
      allowedStates: ['unauthenticated', 'recovering', 'running'],
      reasonCode: 'enterprise_login_session_received'
    })
    return this.acceptLoginSessionWithLease(session, lease)
  }

  async acceptLoginSessionWithLease(session, lease) {
    const checkpointOptions = { states: ['unauthenticated', 'recovering', 'running'] }

    try {
      this.checkpoint(lease, checkpointOptions)
      this.authStore.writeSession(session)
      this.checkpoint(lease, checkpointOptions)
    } catch (error) {
      const leaseCurrent = !lease || this.lifecycle()?.isLeaseCurrent(lease)
      if (leaseCurrent) {
        this.authStore.clear?.()
      }
      if (leaseCurrent && session?.desktopToken) {
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

    const lease = this.beginOperation({
      advanceAuth: true,
      allowedStates: ['blocked', 'recovering', 'running', 'unauthenticated'],
      reasonCode: 'enterprise_logout_started'
    })
    this.checkpoint(lease)
    const session = this.authStore.readSession()

    if (session?.desktopToken) {
      await this.awaitCheckpoint(
        lease,
        () => this.client.logout(session.desktopToken).catch(error => {
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

    const operation = this.beginLatestOperation('runtimeState')
    const lease = operation.lease
    const session = this.authStore.readSession()

    if (!session?.desktopToken) {
      this.latestCheckpoint(operation)
      this.lastPublicState = unauthenticatedState()
      return this.lastPublicState
    }

    try {
      const checkpointOptions = { states: ['recovering', 'running'] }
      const me = await this.awaitLatestCheckpoint(operation, () => this.client.me(session.desktopToken), checkpointOptions)
      const expectedUserId = enterpriseUserId(session.user)
      const actualUser = me?.user || me?.account || null
      const actualUserId = enterpriseUserId(actualUser)
      if (!expectedUserId || !actualUserId || expectedUserId !== actualUserId) {
        const error = new Error('Enterprise account response does not match the authenticated desktop session.')
        error.code = 'enterprise_policy_user_mismatch'
        throw error
      }
      this.latestCheckpoint(operation, checkpointOptions)
      this.lastPublicState = {
        ...this.lastPublicState,
        authenticated: true,
        error: null,
        status: 'authenticated',
        user: actualUser
      }
    } catch (error) {
      this.latestCheckpoint(operation)
      const terminalState = terminalPolicyState(error)
      if (terminalState) {
        return this.enterTerminalState(error, lease, terminalState)
      }
      this.lastPublicState = unauthenticatedState(error.message)
    }

    return this.lastPublicState
  }

  refreshPolicy() {
    const session = this.authStore.readSession()
    const sessionKey = `${enterpriseUserId(session?.user) || ''}:${String(session?.desktopToken || '')}`
    const priorLeaseCurrent = !this.policyRefreshLease || this.lifecycle()?.isLeaseCurrent(this.policyRefreshLease)
    const priorOperationCurrent = this.policyRefreshOperation &&
      this.latestOperations.get(this.policyRefreshOperation.scope) === this.policyRefreshOperation.generation
    if (this.policyRefreshPromise && priorLeaseCurrent && priorOperationCurrent && this.policyRefreshSessionKey === sessionKey) {
      return this.policyRefreshPromise
    }

    const operation = this.beginLatestOperation('runtimeState')
    const lease = operation.lease
    let operationWithCleanup
    operationWithCleanup = this.refreshPolicyOnce({ operation, session }).finally(() => {
      if (this.policyRefreshPromise === operationWithCleanup) {
        this.policyRefreshPromise = null
        this.policyRefreshLease = null
        this.policyRefreshOperation = null
        this.policyRefreshSessionKey = null
      }
    })
    this.policyRefreshPromise = operationWithCleanup
    this.policyRefreshLease = lease
    this.policyRefreshOperation = operation
    this.policyRefreshSessionKey = sessionKey

    return operationWithCleanup
  }

  async refreshPolicyOnce({ operation = this.beginLatestOperation('runtimeState'), session = this.authStore.readSession() } = {}) {
    if (!this.enabled) {
      return disabledState()
    }

    const lease = operation.lease
    const checkpointOptions = { states: ['recovering', 'running'] }
    if (!session?.desktopToken) {
      this.latestCheckpoint(operation)
      this.lastPublicState = unauthenticatedState('Enterprise sign-in is required before refreshing policy.')
      return this.lastPublicState
    }

    const expectedUserId = enterpriseUserId(session.user)
    const hermesHome = this.managedHomeFor({ session })

    try {
      const bootstrap = await this.awaitLatestCheckpoint(
        operation,
        () => this.client.bootstrap(session.desktopToken),
        checkpointOptions
      )
      // Do not derive or bind a managed identity from an authenticated 200
      // until the complete bootstrap contract has passed validation.
      validateManagedBootstrap(bootstrap)
      this.latestCheckpoint(operation, checkpointOptions)
      const bootstrapUserId = enterpriseUserId(bootstrap?.user || bootstrap?.account)
      if (!bootstrapUserId || (expectedUserId && expectedUserId !== bootstrapUserId)) {
        const error = new Error('Enterprise policy bootstrap user does not match the authenticated desktop session.')
        error.code = 'enterprise_policy_user_mismatch'
        throw error
      }
      const bootstrapHome = this.managedHomeFor({ bootstrap, session })
      this.latestCheckpoint(operation, checkpointOptions)
      this.bindManagedIdentity({ bootstrap, hermesHome: bootstrapHome, session })
      this.latestCheckpoint(operation, checkpointOptions)
      const result = this.policyWriter({ bootstrap, hermesHome: bootstrapHome })
      this.latestCheckpoint(operation, checkpointOptions)
      this.lastPublicState = publicStateWithPolicy(this.lastPublicState, result.policy, {
        status: 'current',
        stale: false
      })
      this.rememberLog('[enterprise-policy] refresh succeeded')
    } catch (error) {
      this.latestCheckpoint(operation)
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
      this.latestCheckpoint(operation)

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

    const operation = this.beginLatestOperation('runtimeState')
    const lease = operation.lease
    const checkpointOptions = { states: ['recovering', 'running'] }
    const session = this.authStore.readSession()

    if (!session?.desktopToken) {
      this.latestCheckpoint(operation)
      this.lastPublicState = unauthenticatedState('Enterprise sign-in is required before starting Hermes.')
      throw new Error('Enterprise sign-in is required before starting Hermes.')
    }

    try {
      const bootstrap = await this.awaitLatestCheckpoint(
        operation,
        () => this.client.bootstrap(session.desktopToken),
        checkpointOptions
      )
      validateManagedBootstrap(bootstrap)
      this.latestCheckpoint(operation, checkpointOptions)
      const expectedUserId = enterpriseUserId(session.user)
      const bootstrapUserId = enterpriseUserId(bootstrap?.user || bootstrap?.account)
      if (!bootstrapUserId || (expectedUserId && expectedUserId !== bootstrapUserId)) {
        const error = new Error('Enterprise runtime bootstrap user does not match the authenticated desktop session.')
        error.code = 'enterprise_policy_user_mismatch'
        throw error
      }
      const modelProfilesPayload = await this.awaitLatestCheckpoint(
        operation,
        () => this.client.modelProfiles(session.desktopToken),
        checkpointOptions
      )
      const modelProfiles = extractModelProfilesResponse(modelProfilesPayload)
      const effectivePreferredModel = preferredModel || preferredModelFromPublicState(this.lastPublicState)

      const manifest = await this.awaitLatestCheckpoint(
        operation,
        () => this.client.runtimeManifest(
          session.desktopToken,
          runtimeManifestRequestBody({ modelProfiles, preferredModel: effectivePreferredModel })
        ),
        checkpointOptions
      )

      this.latestCheckpoint(operation, checkpointOptions)
      const hermesHome = this.bindManagedIdentity({
        bootstrap,
        hermesHome: this.managedHomeFor({ bootstrap, session }),
        session
      })
      this.latestCheckpoint(operation, checkpointOptions)
      const launch = this.homeWriter({
        bootstrap,
        hermesHome,
        manifest,
        modelProfiles
      })
      this.latestCheckpoint(operation, checkpointOptions)

      this.lastLaunch = launch
      this.lastPublicState = launch.publicState

      return {
        enabled: true,
        env: launch.env,
        hermesHome: launch.hermesHome,
        publicState: launch.publicState
      }
    } catch (error) {
      this.latestCheckpoint(operation)
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

    const operation = this.beginLatestOperation('runtimeState')
    const lease = operation.lease
    const checkpointOptions = { states: ['recovering', 'running'] }
    const session = this.authStore.readSession()
    if (!session?.desktopToken) {
      this.latestCheckpoint(operation)
      this.lastPublicState = unauthenticatedState('Enterprise sign-in is required before selecting a model.')
      throw new Error('Enterprise sign-in is required before selecting a model.')
    }

    if (!publicStateAllowsModel(this.lastPublicState, model)) {
      throw new Error(`Model is not allowed by enterprise policy: ${model}`)
    }

    try {
      this.latestCheckpoint(operation, checkpointOptions)
      const bootstrap = await this.awaitLatestCheckpoint(
        operation,
        () => this.client.bootstrap(session.desktopToken),
        checkpointOptions
      )
      validateManagedBootstrap(bootstrap)
      this.latestCheckpoint(operation, checkpointOptions)
      const expectedUserId = enterpriseUserId(session.user)
      const bootstrapUserId = enterpriseUserId(bootstrap?.user || bootstrap?.account)
      if (!bootstrapUserId || (expectedUserId && expectedUserId !== bootstrapUserId)) {
        const error = new Error('Enterprise runtime bootstrap user does not match the authenticated desktop session.')
        error.code = 'enterprise_policy_user_mismatch'
        throw error
      }
      const modelProfiles = await this.awaitLatestCheckpoint(
        operation,
        () => this.client.modelProfiles(session.desktopToken),
        checkpointOptions
      )
      const profiles = extractModelProfilesResponse(modelProfiles)
      const manifest = await this.awaitLatestCheckpoint(
        operation,
        () => this.client.runtimeManifest(
          session.desktopToken,
          runtimeManifestRequestBody({ modelProfiles: profiles, preferredModel: model })
        ),
        checkpointOptions
      )

      this.latestCheckpoint(operation, checkpointOptions)
      const hermesHome = this.bindManagedIdentity({
        bootstrap,
        hermesHome: this.managedHomeFor({ bootstrap, session }),
        session
      })
      this.latestCheckpoint(operation, checkpointOptions)
      const launch = this.homeWriter({
        bootstrap,
        hermesHome,
        manifest,
        modelProfiles: profiles
      })
      this.latestCheckpoint(operation, checkpointOptions)

      this.lastLaunch = launch
      this.lastPublicState = launch.publicState

      return this.lastPublicState
    } catch (error) {
      this.latestCheckpoint(operation)
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
  blockedState,
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
