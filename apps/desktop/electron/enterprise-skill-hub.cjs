const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { finished } = require('node:stream/promises')

const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
const SHA256_RE = /^[a-f0-9]{64}$/i
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TERMINAL_RECOVERY_CODES = new Set([
  'install_operation_not_found',
  'skill_install_receipt_ineligible',
  'skill_install_receipt_recovery_expired'
])
const FRESH_CREATE_REJECTION_CODES = new Set([
  'client_operation_id_conflict',
  'desktop_active_role_required',
  'desktop_session_required',
  'install_operation_pending_limit',
  'install_operation_reconciliation_invalid',
  'package_revision_changed',
  'skill_policy_denied',
  'skills_manage_required'
])
const TRANSIENT_RECOVERY_CODES = new Set([
  'enterprise_skill_download_failed',
  'gateway-offline',
  'gateway-timeout',
  'local_backend_unavailable',
  'request-canceled',
  'skill_install_receipt_unavailable'
])

class EnterpriseSkillHubError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'EnterpriseSkillHubError'
    this.code = code || 'enterprise_skill_hub_error'
    this.status = options.status || null
  }
}

function encodePathSegment(value, label) {
  const text = String(value || '').trim()
  if (!text || text.includes('/') || text.includes('\\')) {
    throw new EnterpriseSkillHubError('invalid_request', `${label} is required.`)
  }
  return encodeURIComponent(text)
}

function integer(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function normalizePolicyStatus(value) {
  const status = String(value || '')
  return ['available', 'blocked', 'defaultEnabled', 'recommended', 'restricted', 'teamShared', 'userCreated'].includes(
    status
  )
    ? status
    : 'restricted'
}

function normalizeCatalogItem(value) {
  const item = value && typeof value === 'object' ? value : {}
  return {
    key: String(item.key || ''),
    name: String(item.name || item.key || ''),
    description: String(item.description || ''),
    category: String(item.category || ''),
    declaredVersion: item.declaredVersion == null ? null : String(item.declaredVersion),
    currentRevision: integer(item.currentRevision),
    artifactSha256: String(item.artifactSha256 || '').toLowerCase(),
    artifactSizeBytes: integer(item.artifactSizeBytes),
    fileCount: integer(item.fileCount),
    publishedAt: item.publishedAt == null ? null : String(item.publishedAt),
    policyStatus: normalizePolicyStatus(item.policyStatus),
    policyReason: item.policyReason == null ? null : String(item.policyReason)
  }
}

function normalizeInstalledItem(value) {
  const item = value && typeof value === 'object' ? value : {}
  const normalized = {
    key: String(item.key || ''),
    name: String(item.name || ''),
    revision: integer(item.revision),
    artifactSha256: String(item.artifactSha256 || '').toLowerCase(),
    state: String(item.state || '')
  }
  if (
    !normalized.key ||
    !normalized.name ||
    normalized.revision < 1 ||
    !SHA256_RE.test(normalized.artifactSha256) ||
    !normalized.state
  ) {
    throw new EnterpriseSkillHubError(
      'local_install_response_invalid',
      'The local Hermes backend returned an invalid enterprise skill install record.'
    )
  }
  return normalized
}

function installedItems(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : []
  return rows.map(normalizeInstalledItem).filter(item => item.key)
}

function withInstallState(item, installed) {
  const local = installed.find(row => row.key === item.key) || null
  const installedRevision = local?.revision || null
  const installedArtifactSha256 = local?.artifactSha256 || null
  let installState = 'not-installed'

  if (local) {
    installState =
      installedRevision === item.currentRevision && installedArtifactSha256 === item.artifactSha256
        ? 'installed'
        : 'update-not-supported'
  }

  return {
    ...item,
    installState,
    installedArtifactSha256,
    installedRevision
  }
}

async function readJsonResponse(response, options = {}) {
  const signal = options.signal
  const checkpoint = options.checkpoint || (() => {})
  const cancellationError = () =>
    new EnterpriseSkillHubError('request-canceled', 'Enterprise access changed while reading the response.')
  if (signal?.aborted) throw cancellationError()
  let rejectAbort
  const abortPromise = new Promise((_, reject) => {
    rejectAbort = reject
  })
  const abort = () => {
    response.body?.destroy?.()
    void response.body?.cancel?.().catch?.(() => undefined)
    rejectAbort(cancellationError())
  }
  signal?.addEventListener?.('abort', abort, { once: true })
  let text
  try {
    text = await Promise.race([
      (async () => {
        checkpoint()
        const value = await response.text()
        checkpoint()
        return value
      })(),
      abortPromise
    ])
  } catch (error) {
    if (signal?.aborted) {
      throw cancellationError()
    }
    throw error
  } finally {
    signal?.removeEventListener?.('abort', abort)
  }
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

async function responseError(response, fallbackCode, options) {
  let payload = null
  try {
    payload = await readJsonResponse(response, options)
  } catch (error) {
    if (error?.code === 'request-canceled' || options?.signal?.aborted) throw error
  }
  const code = String(payload?.code || payload?.errorCode || fallbackCode || 'enterprise_skill_hub_error')
  const message = String(payload?.message || payload?.error || `${response.status} ${response.statusText}`.trim())
  return new EnterpriseSkillHubError(code, message, { status: response.status })
}

function requireDesktopToken(authStore) {
  const token = String(authStore?.readSession?.()?.desktopToken || '').trim()
  if (!token) {
    throw new EnterpriseSkillHubError(
      'desktop_session_required',
      'Sign in to your enterprise account to use Skill Hub.',
      {
        status: 401
      }
    )
  }
  if (!token.startsWith('dsk_')) {
    throw new EnterpriseSkillHubError('desktop_session_required', 'The stored enterprise desktop session is invalid.', {
      status: 401
    })
  }
  return token
}

function catalogRows(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : []
  return rows.map(normalizeCatalogItem).filter(item => item.key && item.currentRevision > 0)
}

function normalizeCatalogPage(payload, installed) {
  const items = catalogRows(payload).map(item => withInstallState(item, installed))
  return {
    items,
    page: integer(payload?.page, 1) || 1,
    pageSize: integer(payload?.pageSize, items.length),
    total: integer(payload?.total, items.length)
  }
}

function validSha(value, label) {
  const sha = String(value || '')
    .trim()
    .toLowerCase()
  if (!SHA256_RE.test(sha)) {
    throw new EnterpriseSkillHubError('artifact_metadata_invalid', `${label} is missing or invalid.`)
  }
  return sha
}

function strictPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

function canonicalGuid(value) {
  const text = String(value || '').trim()
  return GUID_RE.test(text) && text === text.toLowerCase() ? text : null
}

function requireManagedUserId(context) {
  const userId = canonicalGuid(context?.userId)
  if (!userId) {
    throw new EnterpriseSkillHubError(
      'enterprise_managed_user_invalid',
      'The managed enterprise user identity is invalid.',
      { status: 409 }
    )
  }
  return userId
}

function requireOperationOwner(operation, context) {
  const userId = requireManagedUserId(context)
  if (canonicalGuid(operation?.desktopUserId) !== userId) {
    throw new EnterpriseSkillHubError(
      'install_operation_user_mismatch',
      'The enterprise install operation belongs to a different managed user.',
      { status: 409 }
    )
  }
  return userId
}

function isTerminalRecoveryAbsence(error) {
  return TERMINAL_RECOVERY_CODES.has(String(error?.code || ''))
}

function isFreshCreateRejection(error) {
  return FRESH_CREATE_REJECTION_CODES.has(String(error?.code || error?.errorCode || ''))
}

function isTransientRecoveryError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.httpStatus)
  const code = String(error?.code || error?.errorCode || '')
  return (
    TRANSIENT_RECOVERY_CODES.has(code) ||
    error?.name === 'AbortError' ||
    error instanceof TypeError ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  )
}

function normalizeGatewayRecoveryError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.httpStatus)
  if (error?.code || error?.errorCode || Number.isFinite(status) || error?.name === 'AbortError') return error
  return new EnterpriseSkillHubError(
    'gateway-offline',
    'The enterprise Gateway is unavailable during install recovery.',
    { cause: error }
  )
}

function isLifecycleCancellation(error) {
  return [
    'enterprise_lifecycle_effect_denied',
    'enterprise_lifecycle_ipc_denied',
    'enterprise_operation_superseded',
    'request-canceled'
  ].includes(String(error?.code || ''))
}

function normalizeGatewayInstallOperation(value, expected = null) {
  const input = value && typeof value === 'object' ? value : {}
  const operation = {
    operationId: String(input.operationId || '').trim().toLowerCase(),
    clientOperationId: String(input.clientOperationId || '').trim(),
    status: String(input.status || '').trim(),
    key: String(input.skillKey || input.key || '').trim(),
    revision: strictPositiveInteger(input.packageRevision ?? input.revision),
    artifactSha256: String(input.artifactSha256 || '').trim().toLowerCase(),
    materializedContentHash: String(input.materializedContentHash || '').trim().toLowerCase(),
    installAuthorizationHash: String(input.installAuthorizationHash || '').trim().toLowerCase(),
    expiresAt: String(input.expiresAt || '').trim(),
    desktopUserId: String(input.desktopUserId || '').trim(),
    tenantId: input.tenantId == null ? null : String(input.tenantId).trim(),
    materializationBindingSchemaVersion:
      typeof input.materializationBindingSchemaVersion === 'number' &&
      Number.isSafeInteger(input.materializationBindingSchemaVersion)
        ? input.materializationBindingSchemaVersion
        : 0,
    materializationRecoveryExpiresAt: String(input.materializationRecoveryExpiresAt || '').trim()
  }
  if (
    !GUID_RE.test(operation.operationId) ||
    canonicalGuid(operation.desktopUserId) !== operation.desktopUserId ||
    operation.materializationBindingSchemaVersion !== 2 ||
    !operation.clientOperationId ||
    !operation.key ||
    operation.revision < 1 ||
    !SHA256_RE.test(operation.artifactSha256) ||
    !SHA256_RE.test(operation.materializedContentHash) ||
    !SHA256_RE.test(operation.installAuthorizationHash) ||
    !Number.isFinite(Date.parse(operation.expiresAt)) ||
    !Number.isFinite(Date.parse(operation.materializationRecoveryExpiresAt)) ||
    !['pending', 'commit-authorized', 'expired'].includes(operation.status)
  ) {
    throw new EnterpriseSkillHubError(
      'install_operation_response_invalid',
      'The enterprise Gateway returned an invalid install operation.'
    )
  }
  if (
    expected &&
    (
      ['operationId', 'clientOperationId', 'key', 'revision', 'artifactSha256', 'materializedContentHash', 'installAuthorizationHash', 'desktopUserId', 'tenantId', 'materializationBindingSchemaVersion'].some(
        field => expected[field] !== operation[field]
      ) || Date.parse(expected.materializationRecoveryExpiresAt) !== Date.parse(operation.materializationRecoveryExpiresAt)
    )
  ) {
    throw new EnterpriseSkillHubError(
      'install_operation_binding_mismatch',
      'The enterprise install operation no longer matches its authorized package.',
      { status: 409 }
    )
  }
  return operation
}

function normalizeGatewayInstallResponse(value, expected = null) {
  const payload = value && typeof value === 'object' ? value : {}
  const operation = normalizeGatewayInstallOperation(payload.operation, expected)
  return {
    operation,
    materializationReceipt: String(payload.materializationReceipt || '').trim() || null
  }
}

function operationBody(operation, receipt = null) {
  return {
    clientOperationId: operation.clientOperationId,
    key: operation.key,
    revision: operation.revision,
    artifactSha256: operation.artifactSha256,
    materializedContentHash: operation.materializedContentHash,
    installAuthorizationHash: operation.installAuthorizationHash,
    desktopUserId: operation.desktopUserId,
    tenantId: operation.tenantId,
    materializationBindingSchemaVersion: operation.materializationBindingSchemaVersion,
    materializationRecoveryExpiresAt: operation.materializationRecoveryExpiresAt,
    ...(receipt ? { receipt } : {})
  }
}

function safeOperation(operation, state) {
  return {
    operationId: operation.operationId,
    key: operation.key,
    revision: operation.revision,
    state
  }
}

async function writeVerifiedArtifact({
  response,
  destination,
  expectedSha256,
  expectedSize,
  maxArtifactBytes,
  signal,
  checkpoint = () => {}
}) {
  if (!response.ok) {
    throw await responseError(response, 'enterprise_skill_download_failed', { signal, checkpoint })
  }

  const contentLengthText = String(response.headers.get('content-length') || '').trim()
  const contentLength = Number(contentLengthText)
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new EnterpriseSkillHubError(
      'artifact_length_missing',
      'The package response did not include a valid Content-Length.'
    )
  }
  if (contentLength > maxArtifactBytes || expectedSize > maxArtifactBytes) {
    throw new EnterpriseSkillHubError(
      'artifact_too_large',
      'The enterprise skill package exceeds the desktop size limit.'
    )
  }
  if (expectedSize !== contentLength) {
    throw new EnterpriseSkillHubError(
      'artifact_length_mismatch',
      'The package length no longer matches the catalog metadata.'
    )
  }

  const headerSha = validSha(response.headers.get('x-hermes-artifact-sha256'), 'Package SHA-256 header')
  if (headerSha !== expectedSha256) {
    throw new EnterpriseSkillHubError(
      'artifact_hash_mismatch',
      'The package SHA-256 header does not match the catalog.'
    )
  }
  if (!response.body) {
    throw new EnterpriseSkillHubError('artifact_body_missing', 'The package response did not include a body.')
  }

  const hash = crypto.createHash('sha256')
  const output = fs.createWriteStream(destination, { flags: 'wx' })
  const outputFinished = finished(output)
  void outputFinished.catch(() => undefined)
  let bytes = 0
  const abort = () => {
    const error = new EnterpriseSkillHubError(
      'request-canceled',
      'Enterprise access changed while the package was downloading.'
    )
    output.destroy(error)
    response.body?.destroy?.(error)
    void response.body?.cancel?.(error).catch?.(() => undefined)
  }
  signal?.addEventListener?.('abort', abort, { once: true })

  try {
    checkpoint()
    for await (const chunk of response.body) {
      if (signal?.aborted) abort()
      checkpoint()
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maxArtifactBytes || bytes > contentLength) {
        throw new EnterpriseSkillHubError('artifact_too_large', 'The package stream exceeded its declared size.')
      }
      hash.update(buffer)
      if (!output.write(buffer)) {
        await new Promise((resolve, reject) => {
          output.once('drain', resolve)
          output.once('error', reject)
        })
      }
    }
    output.end()
    await outputFinished
    checkpoint()
  } catch (error) {
    output.destroy()
    await outputFinished.catch(() => undefined)
    if (!error?.code && error?.name !== 'AbortError') {
      throw new EnterpriseSkillHubError(
        'enterprise_skill_download_failed',
        'The enterprise skill package download was interrupted.',
        { cause: error }
      )
    }
    throw error
  } finally {
    signal?.removeEventListener?.('abort', abort)
  }

  if (bytes !== contentLength || bytes !== expectedSize) {
    throw new EnterpriseSkillHubError(
      'artifact_length_mismatch',
      'The package download was truncated or changed in transit.'
    )
  }
  const actualSha256 = hash.digest('hex')
  if (actualSha256 !== expectedSha256) {
    throw new EnterpriseSkillHubError('artifact_hash_mismatch', 'The downloaded package failed SHA-256 verification.')
  }
  return { artifactSha256: actualSha256, artifactSizeBytes: bytes }
}

class EnterpriseSkillHub {
  constructor({
    authStore,
    client,
    fetchImpl = globalThis.fetch,
    getManagedContext,
    getRuntimeAccess,
    isManaged = false,
    localConnection,
    maxArtifactBytes,
    operationStore,
    runtimeAccess
  } = {}) {
    this.authStore = authStore
    this.client = client
    this.fetchImpl = fetchImpl
    this.getManagedContext = getManagedContext
    this.getRuntimeAccess = getRuntimeAccess
    this.isManaged = typeof isManaged === 'function' ? isManaged : () => isManaged === true
    this.localConnection = localConnection
    this.operationStore = operationStore
    this.runtimeAccess = runtimeAccess
    this.installFlight = null
    this.recoveryFlight = null
    this.maxArtifactBytes = integer(maxArtifactBytes, DEFAULT_MAX_ARTIFACT_BYTES) || DEFAULT_MAX_ARTIFACT_BYTES
  }

  beginOperation(effectName) {
    const runtimeAccess = this.getRuntimeAccess?.() || this.runtimeAccess
    if (runtimeAccess?.begin) {
      return runtimeAccess.begin(effectName, { ipc: true })
    }
    if (this.isManaged()) {
      throw new EnterpriseSkillHubError(
        'enterprise_runtime_access_unavailable',
        'Enterprise runtime access is unavailable.'
      )
    }
    const controller = new AbortController()
    return Object.freeze({ checkpoint: () => true, finish: () => {}, lease: null, signal: controller.signal })
  }

  async runOperation(effectName, operation) {
    const active = this.beginOperation(effectName)
    try {
      const value = await operation(active)
      active.checkpoint()
      return value
    } catch (error) {
      if (error && !Number.isSafeInteger(error.lifecycleEpoch) && Number.isSafeInteger(active.lease?.lifecycleEpoch)) {
        error.lifecycleEpoch = active.lease.lifecycleEpoch
      }
      active.cancel?.(error)
      throw error
    } finally {
      active.finish()
    }
  }

  async localRequest(pathname, options = {}, active = null) {
    if (typeof this.fetchImpl !== 'function' || typeof this.localConnection !== 'function') {
      throw new EnterpriseSkillHubError('local_backend_unavailable', 'The local Hermes backend is unavailable.')
    }
    active?.checkpoint()
    const connection = await this.localConnection({ signal: active?.signal })
    active?.checkpoint()
    const rawBaseUrl = typeof connection?.baseUrl === 'string' ? connection.baseUrl : ''
    const localMatch = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(rawBaseUrl)
    const localPort = localMatch ? Number(localMatch[1]) : 0
    if (
      connection?.mode !== 'local' ||
      !localMatch ||
      !Number.isSafeInteger(localPort) ||
      localPort < 1 ||
      localPort > 65535 ||
      String(localPort) !== localMatch[1] ||
      typeof connection?.token !== 'string' ||
      !connection.token
    ) {
      throw new EnterpriseSkillHubError(
        'local_backend_connection_invalid',
        'The local Hermes backend connection is invalid.'
      )
    }
    if (
      typeof pathname !== 'string' ||
      !pathname.startsWith('/api/skills/enterprise/') ||
      pathname.startsWith('//') ||
      pathname.includes('\\')
    ) {
      throw new EnterpriseSkillHubError(
        'local_backend_path_invalid',
        'The local Hermes backend request path is invalid.'
      )
    }
    let targetUrl
    try {
      const localOrigin = new URL(rawBaseUrl).origin
      targetUrl = new URL(pathname, `${rawBaseUrl}/`)
      if (targetUrl.origin !== localOrigin || !targetUrl.pathname.startsWith('/api/skills/enterprise/')) {
        throw new Error('non-local target')
      }
    } catch {
      throw new EnterpriseSkillHubError(
        'local_backend_path_invalid',
        'The local Hermes backend request path is invalid.'
      )
    }
    const headers = {
      Accept: 'application/json',
      ...(options.headers || {}),
      'X-Hermes-Session-Token': connection.token
    }
    const body = options.body
    const abortBody = () =>
      body?.destroy?.(
        new EnterpriseSkillHubError(
          'request-canceled',
          'Enterprise access changed while the local request was running.'
        )
      )
    active?.signal?.addEventListener?.('abort', abortBody, { once: true })
    let response
    try {
      response = await this.fetchImpl(targetUrl, {
        ...options,
        headers,
        redirect: 'error',
        signal: active?.signal
      })
    } finally {
      active?.signal?.removeEventListener?.('abort', abortBody)
      if (active?.signal?.aborted) abortBody()
    }
    active?.checkpoint()
    if (!response.ok) {
      throw await responseError(response, 'enterprise_skill_install_failed', {
        checkpoint: active?.checkpoint,
        signal: active?.signal
      })
    }
    return response
  }

  async getInstalled(active) {
    const response = await this.localRequest('/api/skills/enterprise/installed', {}, active)
    return installedItems(
      await readJsonResponse(response, {
        checkpoint: active?.checkpoint,
        signal: active?.signal
      })
    )
  }

  localOperationPath(operation, suffix = '') {
    const query = new URLSearchParams({
      artifactSha256: operation.artifactSha256,
      key: operation.key,
      revision: String(operation.revision)
    })
    return `/api/skills/enterprise/install-operations/${encodeURIComponent(operation.operationId)}${suffix}?${query}`
  }

  localOperationHeaders(operation) {
    return {
      'X-Hermes-Client-Operation-Id': operation.clientOperationId,
      'X-Hermes-Install-Authorization-Hash': operation.installAuthorizationHash,
      'X-Hermes-Desktop-User-Id': operation.desktopUserId,
      'X-Hermes-Materialization-Binding-Schema-Version': String(operation.materializationBindingSchemaVersion),
      'X-Hermes-Materialized-Content-Hash': operation.materializedContentHash,
      'X-Hermes-Materialization-Recovery-Expires-At': operation.materializationRecoveryExpiresAt,
      ...(operation.tenantId ? { 'X-Hermes-Tenant-Id': operation.tenantId } : {})
    }
  }

  async localOperationStatus(operation, active = null) {
    const response = await this.localRequest(this.localOperationPath(operation), {
      headers: this.localOperationHeaders(operation)
    }, active)
    return await readJsonResponse(response, { checkpoint: active?.checkpoint, signal: active?.signal })
  }

  async abortLocalOperation(operation, active = null) {
    const response = await this.localRequest(
      this.localOperationPath(operation, '/abort'),
      {
        body: JSON.stringify(operationBody(operation)),
        headers: { 'Content-Type': 'application/json', ...this.localOperationHeaders(operation) },
        method: 'POST'
      },
      active
    )
    const result = await readJsonResponse(response, { checkpoint: active?.checkpoint, signal: active?.signal })
    if (result?.state !== 'aborted' || result?.targetAbsent !== true) {
      throw new EnterpriseSkillHubError(
        'install_operation_abort_unconfirmed',
        'The local Hermes backend did not confirm that the install target is absent.',
        { status: 409 }
      )
    }
    return result
  }

  async materializeLocalOperation(operation, gatewayOperation, active = null) {
    const committedResponse = normalizeGatewayInstallResponse(gatewayOperation, operation)
    const committed = committedResponse.operation
    if (committed.status !== 'commit-authorized') {
      throw new EnterpriseSkillHubError(
        'install_operation_not_authorized',
        'The enterprise install operation is not authorized for materialization.',
        { status: 409 }
      )
    }
    if (!committedResponse.materializationReceipt) {
      throw new EnterpriseSkillHubError(
        'install_operation_receipt_required',
        'The Gateway did not provide a signed materialization receipt.',
        { status: 409 }
      )
    }
    const response = await this.localRequest(
      this.localOperationPath(operation, '/materialize'),
      {
        body: JSON.stringify(operationBody(operation, committedResponse.materializationReceipt)),
        headers: { 'Content-Type': 'application/json', ...this.localOperationHeaders(operation) },
        method: 'POST'
      },
      active
    )
    return normalizeInstalledItem(
      await readJsonResponse(response, { checkpoint: active?.checkpoint, signal: active?.signal })
    )
  }

  recoverPendingOperation(options = {}) {
    if (this.recoveryFlight) return this.recoveryFlight
    const promise = this.runOperation('enterprise:skill-hub:recover', active =>
      this.recoverPendingOperationOnce({ ...options, active })
    ).finally(() => {
      if (this.recoveryFlight === promise) this.recoveryFlight = null
    })
    this.recoveryFlight = promise
    return promise
  }

  async recoverPendingOperationOnce({ active, terminalCause = null } = {}) {
    active?.checkpoint()
    let stored = this.operationStore?.readOperation?.() || null
    if (!stored) return null
    const context = this.getManagedContext?.() || {}
    const currentUserId = requireManagedUserId(context)
    if (stored.userId !== currentUserId || stored.hermesHome !== String(context.hermesHome || '').trim()) {
      throw new EnterpriseSkillHubError(
        'enterprise_skill_install_recovery_unavailable',
        'The pending enterprise skill operation belongs to a different managed runtime.'
      )
    }
    if (stored.phase === 'creating') {
      let token
      try {
        token = requireDesktopToken(this.authStore)
        const created = await this.client.createSkillInstallOperation(token, {
            clientOperationId: stored.clientOperationId,
            skillKey: stored.key,
            packageRevision: stored.revision,
            artifactSha256: stored.artifactSha256
          }, { signal: active?.signal })
          .catch(error => { throw normalizeGatewayRecoveryError(error) })
        active?.checkpoint()
        const operation = normalizeGatewayInstallOperation(created?.operation)
        requireOperationOwner(operation, context)
        const reconciliationToken = String(created?.reconciliationToken || '').trim()
        if (
          operation.clientOperationId !== stored.clientOperationId ||
          operation.key !== stored.key ||
          operation.revision !== stored.revision ||
          operation.artifactSha256 !== stored.artifactSha256 ||
          !reconciliationToken.startsWith('srt_')
        ) {
          throw new EnterpriseSkillHubError('install_operation_response_invalid', 'Gateway operation replay was invalid.')
        }
        active?.checkpoint()
        stored = this.operationStore.writeOperation({ ...stored, ...operation, reconciliationToken })
      } catch (error) {
        if (isTerminalRecoveryAbsence(error)) {
          active?.checkpoint()
          this.operationStore.clear()
          if (terminalCause) throw error
          return safeOperation(stored, 'aborted')
        }
        if (isTransientRecoveryError(error)) return safeOperation(stored, 'reconciling')
        throw error
      }
    }
    requireOperationOwner(stored, context)
    let gatewayOperation
    try {
      const response = await this.client.getSkillInstallOperation(stored.operationId, {
          reconciliationToken: stored.reconciliationToken,
          signal: active?.signal
        }).catch(error => { throw normalizeGatewayRecoveryError(error) })
      requireOperationOwner(normalizeGatewayInstallResponse(response).operation, context)
      gatewayOperation = normalizeGatewayInstallResponse(response, stored)
      active?.checkpoint()
    } catch (error) {
      if (isTerminalRecoveryAbsence(error)) {
        try {
          await this.abortLocalOperation(stored, active)
        } catch (localError) {
          if (String(localError?.code || localError?.errorCode || '') !== 'install_operation_not_found') throw localError
        }
        active?.checkpoint()
        this.operationStore.clear()
        if (terminalCause) throw terminalCause
        return safeOperation(stored, 'aborted')
      }
      if (isTransientRecoveryError(error)) return safeOperation(stored, 'reconciling')
      throw error
    }

    if (gatewayOperation.operation.status === 'commit-authorized') {
      try {
        // Status is intentionally read before the idempotent materialize call;
        // it detects local corruption without treating "staged" as success.
        await this.localOperationStatus(stored, active)
        const installed = await this.materializeLocalOperation(stored, gatewayOperation, active)
        active?.checkpoint()
        this.operationStore.clear()
        return { installed, operation: safeOperation(stored, 'materialized') }
      } catch (error) {
        if (isTransientRecoveryError(error)) return safeOperation(stored, 'reconciling')
        throw error
      }
    }

    if (gatewayOperation.operation.status === 'pending') {
      if (terminalCause && !isTransientRecoveryError(terminalCause)) {
        try {
          await this.abortLocalOperation(stored, active)
        } catch (localError) {
          if (localError?.code !== 'install_operation_not_found') throw localError
        }
        active?.checkpoint()
        this.operationStore.clear()
        throw terminalCause
      }
      return safeOperation(stored, 'reconciling')
    }

    if (gatewayOperation.operation.status !== 'expired') {
      return safeOperation(stored, 'reconciling')
    }

    try {
      await this.abortLocalOperation(stored, active)
      active?.checkpoint()
      this.operationStore.clear()
    } catch (error) {
      if (isTransientRecoveryError(error)) return safeOperation(stored, 'reconciling')
      throw error
    }
    if (terminalCause) throw terminalCause
    return safeOperation(stored, 'aborted')
  }

  async reconcileBeforeUse() {
    const recovered = await this.recoverPendingOperation()
    if (recovered?.state === 'reconciling' || recovered?.operation?.state === 'reconciling') {
      throw new EnterpriseSkillHubError(
        'install_operation_reconciling',
        'An enterprise skill installation is still being reconciled.',
        { status: 202 }
      )
    }
    return recovered
  }

  pendingOperationState() {
    try {
      const stored = this.operationStore?.readOperation?.() || null
      return stored ? safeOperation(stored, 'reconciling') : null
    } catch {
      return { state: 'recovery-unavailable' }
    }
  }

  async list(query = {}) {
    return this.runOperation('enterprise:skill-hub:list', async active => {
      const token = requireDesktopToken(this.authStore)
      const [payload, installed] = await Promise.all([
        this.client.skillHubSkills(token, query, { signal: active.signal }),
        this.getInstalled(active).catch(error => {
          if (error?.status === 404) return []
          throw error
        })
      ])
      active.checkpoint()
      return { ...normalizeCatalogPage(payload, installed), pendingOperation: this.pendingOperationState() }
    })
  }

  async detail(key) {
    return this.runOperation('enterprise:skill-hub:detail', async active => {
      const token = requireDesktopToken(this.authStore)
      encodePathSegment(key, 'Skill key')
      const [payload, installed] = await Promise.all([
        this.client.skillHubSkill(token, key, { signal: active.signal }),
        this.getInstalled(active).catch(error => {
          if (error?.status === 404) return []
          throw error
        })
      ])
      active.checkpoint()
      return {
        ...withInstallState(normalizeCatalogItem(payload), installed),
        pendingOperation: this.pendingOperationState()
      }
    })
  }

  install(payload = {}) {
    const key = String(payload?.key || '').trim()
    const revision = integer(payload?.revision)
    if (this.installFlight) {
      if (this.installFlight.key === key && this.installFlight.revision === revision) {
        return this.installFlight.promise
      }
      return Promise.reject(
        new EnterpriseSkillHubError(
          'enterprise_skill_install_busy',
          'Another enterprise skill installation is already in progress.',
          { status: 409 }
        )
      )
    }

    const promise = this.installOnce(payload).finally(() => {
      if (this.installFlight?.promise === promise) this.installFlight = null
    })
    this.installFlight = { key, promise, revision }
    return promise
  }

  async installOnce({ key, revision } = {}) {
    const recovered = await this.reconcileBeforeUse()
    if (recovered?.installed && recovered.installed.key === String(key || '').trim()) {
      return this.runOperation('enterprise:skill-hub:install-result', async active => {
        const token = requireDesktopToken(this.authStore)
        const detail = normalizeCatalogItem(
          await this.client.skillHubSkill(token, key, { signal: active.signal })
        )
        active.checkpoint()
        return { item: withInstallState(detail, [recovered.installed]), installed: recovered.installed }
      })
    }
    if (!this.operationStore?.assertAvailable || !this.operationStore?.writeOperation) {
      throw new EnterpriseSkillHubError(
        'enterprise_skill_install_recovery_unavailable',
        'Secure enterprise skill installation recovery is unavailable.'
      )
    }
    this.operationStore.assertAvailable()

    let storedOperation = null
    let installContext = null
    try {
      installContext = await this.runOperation('enterprise:skill-hub:install', async active => {
      const token = requireDesktopToken(this.authStore)
      encodePathSegment(key, 'Skill key')
      const detail = normalizeCatalogItem(await this.client.skillHubSkill(token, key, { signal: active.signal }))
      active.checkpoint()
      const requestedRevision = integer(revision)

      if (detail.key !== String(key).trim()) {
        throw new EnterpriseSkillHubError(
          'package_revision_changed',
          'The enterprise catalog returned a different skill package.',
          { status: 409 }
        )
      }

      if (!requestedRevision || requestedRevision !== detail.currentRevision) {
        throw new EnterpriseSkillHubError(
          'package_revision_changed',
          'A newer package revision is available. Refresh Enterprise Discovery and try again.',
          { status: 409 }
        )
      }
      if (detail.policyStatus === 'blocked' || detail.policyStatus === 'restricted') {
        throw new EnterpriseSkillHubError(
          'skill_policy_denied',
          detail.policyReason || 'Enterprise policy does not allow this skill to be installed.',
          { status: 403 }
        )
      }

      const expectedSha256 = validSha(detail.artifactSha256, 'Catalog artifact SHA-256')
      if (!detail.artifactSizeBytes) {
        throw new EnterpriseSkillHubError(
          'artifact_metadata_invalid',
          'The catalog package size is missing or invalid.'
        )
      }

      const clientOperationId = `desktop-${crypto.randomUUID()}`
      const context = this.getManagedContext?.() || {}
      const currentUserId = requireManagedUserId(context)
      active.checkpoint()
      const intent = this.operationStore.writeIntent({
        clientOperationId,
        key: detail.key,
        revision: requestedRevision,
        artifactSha256: expectedSha256,
        userId: currentUserId,
        hermesHome: context.hermesHome
      })
      storedOperation = intent
      let created
      try {
        created = await this.client.createSkillInstallOperation(
          token,
          {
            clientOperationId,
            skillKey: detail.key,
            packageRevision: requestedRevision,
            artifactSha256: expectedSha256
          },
          { signal: active.signal }
        )
      } catch (error) {
        const recoveryError = normalizeGatewayRecoveryError(error)
        if (isFreshCreateRejection(recoveryError) || isTerminalRecoveryAbsence(recoveryError)) {
          active.checkpoint()
          this.operationStore.clear()
          storedOperation = null
        }
        throw recoveryError
      }
      active.checkpoint()
      const operation = normalizeGatewayInstallOperation(created?.operation)
      requireOperationOwner(operation, context)
      const reconciliationToken = String(created?.reconciliationToken || '').trim()
      if (
        operation.clientOperationId !== clientOperationId ||
        operation.key !== detail.key ||
        operation.revision !== requestedRevision ||
        operation.artifactSha256 !== expectedSha256 ||
        operation.status !== 'pending' ||
        !reconciliationToken.startsWith('srt_')
      ) {
        throw new EnterpriseSkillHubError(
          'install_operation_response_invalid',
          'The enterprise Gateway returned an invalid install authorization.'
        )
      }
      active.checkpoint()
      storedOperation = this.operationStore.writeOperation({ ...intent, ...operation, reconciliationToken })

      active.checkpoint()
      const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-enterprise-skill-'))
      const artifactPath = path.join(tempRoot, 'artifact.zip')
      try {
        const download = await this.client.downloadSkillPackage(token, detail.key, requestedRevision, {
          signal: active.signal
        })
        active.checkpoint()
        const verified = await writeVerifiedArtifact({
          response: download,
          destination: artifactPath,
          expectedSha256,
          expectedSize: detail.artifactSizeBytes,
          maxArtifactBytes: this.maxArtifactBytes,
          signal: active.signal,
          checkpoint: active.checkpoint
        })
        active.checkpoint()
        const stagePath = this.localOperationPath(operation, '/stage')
        const stageBody = fs.createReadStream(artifactPath)
        let stagedResponse
        try {
          stagedResponse = await this.localRequest(
            stagePath,
            {
              body: stageBody,
              duplex: 'half',
              headers: {
                'Content-Length': String(verified.artifactSizeBytes),
                'Content-Type': 'application/zip',
                'X-Hermes-Artifact-Sha256': verified.artifactSha256,
                'X-Hermes-Client-Operation-Id': operation.clientOperationId,
                'X-Hermes-Install-Authorization-Hash': operation.installAuthorizationHash,
                'X-Hermes-Desktop-User-Id': operation.desktopUserId,
                'X-Hermes-Materialization-Binding-Schema-Version': String(operation.materializationBindingSchemaVersion),
                'X-Hermes-Materialized-Content-Hash': operation.materializedContentHash,
                'X-Hermes-Materialization-Recovery-Expires-At': operation.materializationRecoveryExpiresAt,
                ...(operation.tenantId ? { 'X-Hermes-Tenant-Id': operation.tenantId } : {}),
                'X-Hermes-Operation-Expires-At': operation.expiresAt
              },
              method: 'POST'
            },
            active
          )
        } finally {
          stageBody.destroy()
        }
        const staged = await readJsonResponse(stagedResponse, {
          checkpoint: active.checkpoint,
          signal: active.signal
        })
        if (staged?.state !== 'staged' || staged?.operationId !== operation.operationId) {
          throw new EnterpriseSkillHubError(
            'local_stage_response_invalid',
            'The local Hermes backend did not durably stage the install operation.'
          )
        }
        const latest = normalizeCatalogItem(await this.client.skillHubSkill(token, key, { signal: active.signal }))
        active.checkpoint()
        if (
          latest.key !== detail.key ||
          latest.currentRevision !== requestedRevision ||
          latest.artifactSha256 !== expectedSha256 ||
          latest.artifactSizeBytes !== detail.artifactSizeBytes ||
          latest.policyStatus !== detail.policyStatus
        ) {
          throw new EnterpriseSkillHubError(
            'package_revision_changed',
            'The enterprise skill package changed before installation. Refresh and try again.',
            { status: 409 }
          )
        }
        if (latest.policyStatus === 'blocked' || latest.policyStatus === 'restricted') {
          throw new EnterpriseSkillHubError(
            'skill_policy_denied',
            'Enterprise policy no longer allows this skill to be installed.',
            { status: 403 }
          )
        }
        const committed = normalizeGatewayInstallResponse(
          await this.client.commitSkillInstallOperation(token, operation.operationId, { signal: active.signal }),
          operation
        )
        active.checkpoint()
        const installed = await this.materializeLocalOperation(operation, committed, active)
        active.checkpoint()
        this.operationStore.clear()
        return { committed, detail, installed, operation }
      } finally {
        await fs.promises.rm(tempRoot, { force: true, recursive: true }).catch(() => undefined)
      }
    })
    } catch (error) {
      if (!storedOperation) throw error
      if (isLifecycleCancellation(error)) throw error
      const reconciled = await this.recoverPendingOperation({ terminalCause: error })
      if (reconciled?.installed) {
        return {
          item: withInstallState(installContext?.detail || normalizeCatalogItem({ key: storedOperation.key }), [reconciled.installed]),
          installed: reconciled.installed
        }
      }
      throw new EnterpriseSkillHubError(
        'install_operation_reconciling',
        'The enterprise skill installation is being reconciled.',
        { status: 202 }
      )
    }

    return {
      item: withInstallState(installContext.detail, [installContext.installed]),
      installed: installContext.installed
    }
  }
}

function createEnterpriseSkillHub(options) {
  return new EnterpriseSkillHub(options)
}

module.exports = {
  DEFAULT_MAX_ARTIFACT_BYTES,
  EnterpriseSkillHub,
  EnterpriseSkillHubError,
  catalogRows,
  createEnterpriseSkillHub,
  normalizeCatalogItem,
  normalizeInstalledItem,
  readJsonResponse,
  requireDesktopToken,
  withInstallState,
  writeVerifiedArtifact
}
