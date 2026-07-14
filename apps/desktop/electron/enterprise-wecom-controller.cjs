const crypto = require('node:crypto')

const WE_COM_METHOD = 'wecom-qr'
const PASSWORD_METHOD = 'password'
const KNOWN_REMOTE_STATES = new Set(['pending', 'verified', 'expired', 'denied', 'canceled', 'error'])
const PUBLIC_ERROR_CODES = new Set([
  'gateway-offline',
  'method-disabled',
  'out-of-scope',
  'qr-denied',
  'qr-error',
  'qr-expired',
  'service-unavailable'
])
const SERVER_ERROR_CODE_MAP = new Map([
  ['authorization-denied', 'qr-denied'],
  ['auth-service-offline', 'service-unavailable'],
  ['auth-service-timeout', 'service-unavailable'],
  ['auth-service-unavailable', 'service-unavailable'],
  ['gateway-offline', 'gateway-offline'],
  ['gateway-timeout', 'gateway-offline'],
  ['out-of-scope', 'out-of-scope'],
  ['service-unavailable', 'service-unavailable'],
  ['transaction-expired', 'qr-expired'],
  ['wecom-authorization-denied', 'qr-denied'],
  ['wecom-corp-mismatch', 'qr-denied'],
  ['wecom-out-of-scope', 'out-of-scope'],
  ['wecom-service-unavailable', 'service-unavailable'],
  ['wecom-transaction-expired', 'qr-expired'],
  ['wecom-user-not-in-scope', 'out-of-scope']
])

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function createVerifier(randomBytes = crypto.randomBytes) {
  return base64Url(randomBytes(32))
}

function createChallenge(verifier, createHash = crypto.createHash) {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url')
}

function asUtcIso(value) {
  const time = Date.parse(String(value || ''))
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function normalizeAuthorizationOrigin(value) {
  try {
    const parsed = new URL(String(value || ''))
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null
    }
    return parsed.origin
  } catch {
    return null
  }
}

function validateAuthorizationUrl(value, expectedOrigin) {
  try {
    const parsed = new URL(String(value || ''))
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.origin !== expectedOrigin ||
      parsed.search ||
      parsed.hash ||
      !/^\/wecom\/login\/[A-Za-z0-9_-]{16,128}$/.test(parsed.pathname)
    ) {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

function stableErrorCode(error, fallback = 'qr-error') {
  const raw = String(error?.code || '').trim().toLowerCase().replace(/_/g, '-')
  if (SERVER_ERROR_CODE_MAP.has(raw)) {
    return SERVER_ERROR_CODE_MAP.get(raw)
  }
  if (Number(error?.status) >= 500) {
    return 'service-unavailable'
  }
  return PUBLIC_ERROR_CODES.has(raw) ? raw : fallback
}

function createInitialPublicState() {
  return {
    defaultMethod: null,
    enterpriseDisplayName: null,
    errorCode: null,
    expiresAt: null,
    methods: [],
    selectedMethod: null,
    status: 'idle',
    user: null
  }
}

function clonePublicState(state) {
  return {
    defaultMethod: state.defaultMethod,
    enterpriseDisplayName: state.enterpriseDisplayName,
    errorCode: state.errorCode,
    expiresAt: state.expiresAt,
    methods: [...state.methods],
    selectedMethod: state.selectedMethod,
    status: state.status,
    user: state.user || null
  }
}

class EnterpriseWeComController {
  constructor({
    client,
    clearIntervalImpl = clearInterval,
    clearTimeoutImpl = clearTimeout,
    createHash = crypto.createHash,
    disposeWaitMs,
    now = Date.now,
    onAuthenticated = async () => {},
    onState = () => {},
    pollIntervalMs = 1500,
    qrView,
    randomBytes = crypto.randomBytes,
    rememberLog = () => {},
    runtime,
    setIntervalImpl = setInterval,
    setTimeoutImpl = setTimeout
  } = {}) {
    this.client = client
    this.runtime = runtime
    this.qrView = qrView
    this.randomBytes = randomBytes
    this.createHash = createHash
    this.now = now
    this.onAuthenticated = onAuthenticated
    this.onState = onState
    this.rememberLog = rememberLog
    this.pollIntervalMs = Math.max(1000, Math.min(2000, Number(pollIntervalMs) || 1500))
    const configuredDisposeWait = Number(disposeWaitMs)
    const gatewayTimeoutMs = Math.max(100, Number(client?.timeoutMs) || 10000)
    this.disposeWaitMs = Number.isFinite(configuredDisposeWait) && configuredDisposeWait >= 0
      ? configuredDisposeWait
      : gatewayTimeoutMs * 2 + 250
    this.setIntervalImpl = setIntervalImpl
    this.clearIntervalImpl = clearIntervalImpl
    this.setTimeoutImpl = setTimeoutImpl
    this.clearTimeoutImpl = clearTimeoutImpl
    this.publicState = createInitialPublicState()
    this.transaction = null
    this.pollTimer = null
    this.initializationPromise = null
    this.pollPromise = null
    this.redeemPromise = null
    this.operationAbortController = null
    this.generation = 0
    this.weComAuthorizationOrigin = null
    this.disposing = false
    this.disposePromise = null
    this.permanentDispose = false
    this.backgroundCancellationTasks = new Set()
  }

  getPublicState() {
    return clonePublicState(this.publicState)
  }

  updatePublicState(patch) {
    this.publicState = { ...this.publicState, ...patch }
    const state = this.getPublicState()
    this.onState(state)
    return state
  }

  async initialize() {
    if (this.disposing) {
      if (this.permanentDispose || !this.disposePromise) {
        return this.getPublicState()
      }
      await this.disposePromise.catch(() => undefined)
      if (this.disposing || this.permanentDispose) {
        return this.getPublicState()
      }
    }
    if (this.initializationPromise) {
      return this.initializationPromise
    }

    this.initializationPromise = this.loadMethodsAndStart().finally(() => {
      this.initializationPromise = null
    })
    return this.initializationPromise
  }

  async retry() {
    if (this.publicState.methods.length === 0) {
      return this.initialize()
    }

    return this.start()
  }

  async loadMethodsAndStart() {
    if (!this.client) {
      return this.updatePublicState({ errorCode: 'gateway-offline', status: 'gateway-offline' })
    }

    this.updatePublicState({ errorCode: null, status: 'methods-loading' })
    try {
      const result = await this.client.loginMethods()
      if (this.disposing) {
        return this.getPublicState()
      }
      let methods = Array.isArray(result?.methods)
        ? result.methods.filter(method => method === WE_COM_METHOD || method === PASSWORD_METHOD)
        : []
      this.weComAuthorizationOrigin = normalizeAuthorizationOrigin(result?.weComAuthorizationOrigin)
      if (!this.weComAuthorizationOrigin) {
        methods = methods.filter(method => method !== WE_COM_METHOD)
      }
      const defaultMethod = methods.includes(result?.defaultMethod) ? result.defaultMethod : methods[0] || null
      const selectedMethod = defaultMethod

      this.updatePublicState({
        defaultMethod,
        enterpriseDisplayName: result?.enterpriseDisplayName || null,
        errorCode: methods.length > 0 ? null : 'method-disabled',
        methods,
        selectedMethod,
        status: methods.length > 0 ? 'idle' : 'qr-error'
      })

      if (selectedMethod === WE_COM_METHOD) {
        return this.start()
      }

      return this.updatePublicState({ status: selectedMethod === PASSWORD_METHOD ? 'password-ready' : 'qr-error' })
    } catch (error) {
      return this.updatePublicState({ errorCode: stableErrorCode(error, 'gateway-offline'), status: 'gateway-offline' })
    }
  }

  async selectMethod(method) {
    if (this.disposing) {
      return this.getPublicState()
    }
    const selectedMethod = String(method || '').trim()
    if (this.redeemPromise || this.publicState.status === 'qr-verified') {
      return this.getPublicState()
    }
    if (!this.publicState.methods.includes(selectedMethod)) {
      return this.updatePublicState({ errorCode: 'method-disabled', status: 'qr-error' })
    }

    if (selectedMethod === PASSWORD_METHOD) {
      await this.cancel({ nextStatus: 'password-ready', notifyRemote: true })
      if (this.disposing) {
        return this.getPublicState()
      }
      return this.updatePublicState({ errorCode: null, selectedMethod, status: 'password-ready' })
    }

    this.updatePublicState({ errorCode: null, selectedMethod })
    return this.start()
  }

  async start() {
    if (this.disposing) {
      return this.getPublicState()
    }
    if (this.redeemPromise || this.publicState.status === 'qr-verified') {
      return this.getPublicState()
    }
    if (!this.publicState.methods.includes(WE_COM_METHOD)) {
      return this.updatePublicState({ errorCode: 'method-disabled', status: 'qr-error' })
    }

    await this.cancel({ nextStatus: 'qr-preparing', notifyRemote: true, preserveSelection: true })
    const generation = ++this.generation
    const operationAbortController = new AbortController()
    this.operationAbortController = operationAbortController
    const verifier = createVerifier(this.randomBytes)
    const challenge = createChallenge(verifier, this.createHash)
    this.updatePublicState({
      errorCode: null,
      expiresAt: null,
      selectedMethod: WE_COM_METHOD,
      status: 'qr-preparing',
      user: null
    })

    try {
      const response = await this.client.startWeCom({ challenge, signal: operationAbortController.signal })
      if (this.disposing || generation !== this.generation) {
        return this.getPublicState()
      }
      const transactionId = String(response?.transactionId || '').trim()
      const authorizationUrl = validateAuthorizationUrl(response?.authorizationUrl, this.weComAuthorizationOrigin)
      const expiresAt = asUtcIso(response?.expiresAt)
      if (!transactionId || !authorizationUrl || !expiresAt || Date.parse(expiresAt) <= this.now()) {
        throw Object.assign(new Error('Invalid enterprise WeCom start response.'), { code: 'qr-error' })
      }

      this.transaction = { authorizationUrl, expiresAt, generation, transactionId, verifier }
      await this.qrView?.open(authorizationUrl, { authorizationOrigin: this.weComAuthorizationOrigin })
      if (this.disposing || generation !== this.generation || this.transaction?.generation !== generation) {
        return this.getPublicState()
      }
      this.updatePublicState({
        enterpriseDisplayName: response?.enterpriseDisplayName || this.publicState.enterpriseDisplayName,
        errorCode: null,
        expiresAt,
        status: 'qr-pending'
      })
      this.startPolling()
      return this.getPublicState()
    } catch (error) {
      if (this.disposing || generation !== this.generation) {
        return this.getPublicState()
      }
      await this.failTransaction(stableErrorCode(error), error)
      return this.getPublicState()
    }
  }

  startPolling() {
    if (this.disposing) {
      return
    }
    this.stopPolling()
    this.pollTimer = this.setIntervalImpl(() => void this.poll(), this.pollIntervalMs)
    this.pollTimer?.unref?.()
  }

  stopPolling() {
    if (this.pollTimer) {
      this.clearIntervalImpl(this.pollTimer)
      this.pollTimer = null
    }
  }

  async poll() {
    if (this.disposing) {
      return this.getPublicState()
    }
    if (!this.transaction || this.pollPromise || this.redeemPromise) {
      return this.getPublicState()
    }
    if (Date.parse(this.transaction.expiresAt) <= this.now()) {
      await this.expire()
      return this.getPublicState()
    }

    this.pollPromise = this.pollTransaction().finally(() => {
      this.pollPromise = null
    })
    return this.pollPromise
  }

  async pollTransaction() {
    const active = this.transaction
    try {
      const response = await this.client.weComStatus(active.transactionId, {
        signal: this.operationAbortController?.signal
      })
      if (this.transaction !== active) {
        return this.getPublicState()
      }

      const remoteStatus = String(response?.status || '').trim().toLowerCase()
      if (!KNOWN_REMOTE_STATES.has(remoteStatus)) {
        await this.failTransaction('qr-error')
        return this.getPublicState()
      }

      const responseExpiry = asUtcIso(response?.expiresAt)
      if (responseExpiry && Date.parse(responseExpiry) < Date.parse(active.expiresAt)) {
        active.expiresAt = responseExpiry
      }

      if (remoteStatus === 'pending') {
        return this.updatePublicState({ errorCode: null, expiresAt: active.expiresAt, status: 'qr-pending' })
      }
      if (remoteStatus === 'verified') {
        this.updatePublicState({ errorCode: null, expiresAt: active.expiresAt, status: 'qr-verified' })
        return this.redeem(active)
      }
      if (remoteStatus === 'expired') {
        await this.expire()
        return this.getPublicState()
      }
      if (remoteStatus === 'denied') {
        const code = stableErrorCode({ code: response?.errorCode }, 'qr-denied')
        await this.failTransaction(code === 'out-of-scope' ? code : 'qr-denied')
        return this.getPublicState()
      }
      if (remoteStatus === 'canceled') {
        await this.cancel({ nextStatus: 'qr-canceled', notifyRemote: false, preserveSelection: true })
        return this.getPublicState()
      }

      await this.failTransaction(stableErrorCode({ code: response?.errorCode }))
      return this.getPublicState()
    } catch (error) {
      if (this.transaction !== active) {
        return this.getPublicState()
      }
      const errorCode = stableErrorCode(error, 'gateway-offline')
      if (errorCode === 'gateway-offline' || errorCode === 'service-unavailable') {
        return this.updatePublicState({ errorCode, status: 'gateway-offline' })
      }
      await this.failTransaction(errorCode)
      return this.getPublicState()
    }
  }

  async redeem(active = this.transaction) {
    if (this.disposing || !active || this.transaction !== active || this.redeemPromise) {
      return this.getPublicState()
    }

    this.stopPolling()
    this.redeemPromise = (async () => {
      let session = null
      let sessionPersisted = false
      try {
        session = await this.client.redeemWeCom({
          signal: this.operationAbortController?.signal,
          transactionId: active.transactionId,
          verifier: active.verifier
        })
        if (this.disposing || this.transaction !== active) {
          await this.revokeIssuedSession(session, { persisted: false })
          return this.getPublicState()
        }

        const runtimeState = await this.runtime.acceptLoginSession(session)
        sessionPersisted = true
        if (this.disposing || this.transaction !== active) {
          await this.revokeIssuedSession(session, { persisted: true })
          return this.getPublicState()
        }

        this.transaction = null
        this.operationAbortController = null
        await this.qrView?.destroy()
        if (this.disposing) {
          await this.revokeIssuedSession(session, { persisted: true })
          return this.getPublicState()
        }
        const state = this.updatePublicState({
          errorCode: null,
          expiresAt: null,
          status: 'success',
          user: runtimeState?.user || session?.user || null
        })
        try {
          await this.onAuthenticated(state)
        } catch (error) {
          this.rememberLog(`[enterprise] post-authentication hook failed: ${error?.message || error}`)
        }
        return state
      } catch (error) {
        if (this.disposing) {
          if (session?.desktopToken && sessionPersisted) {
            await this.revokeIssuedSession(session, { persisted: true })
          }
          return this.getPublicState()
        }
        await this.failTransaction(stableErrorCode(error))
        return this.getPublicState()
      }
    })().finally(() => {
      this.redeemPromise = null
    })

    return this.redeemPromise
  }

  async revokeIssuedSession(session, { persisted = false } = {}) {
    if (!session?.desktopToken) {
      return
    }

    try {
      if (persisted && this.runtime?.logout) {
        await this.runtime.logout()
      } else {
        await this.client?.logout?.(session.desktopToken)
      }
    } catch (error) {
      this.rememberLog(`[enterprise] shutdown session revoke failed: ${error?.message || error}`)
    }
  }

  async expire() {
    this.generation += 1
    this.operationAbortController?.abort()
    this.operationAbortController = null
    this.stopPolling()
    this.transaction = null
    await this.qrView?.destroy()
    return this.updatePublicState({ errorCode: 'qr-expired', expiresAt: null, status: 'qr-expired' })
  }

  async failTransaction(errorCode = 'qr-error') {
    if (this.disposing) {
      return this.getPublicState()
    }
    const active = this.transaction
    this.generation += 1
    this.operationAbortController?.abort()
    this.operationAbortController = null
    this.stopPolling()
    this.transaction = null
    await this.qrView?.destroy()
    const code = PUBLIC_ERROR_CODES.has(errorCode) ? errorCode : 'qr-error'
    const status = code === 'out-of-scope' ? 'out-of-scope' : code === 'gateway-offline' ? 'gateway-offline' : 'qr-error'
    const state = this.updatePublicState({ errorCode: code, expiresAt: null, status })
    this.cancelRemoteInBackground(active?.transactionId)
    return state
  }

  async cancel({ force = false, nextStatus = 'qr-canceled', notifyRemote = true, preserveSelection = false } = {}) {
    if (this.disposing) {
      return this.getPublicState()
    }
    if (!force && (this.redeemPromise || this.publicState.status === 'qr-verified')) {
      return this.getPublicState()
    }
    const active = this.transaction
    this.generation += 1
    this.operationAbortController?.abort()
    this.operationAbortController = null
    this.stopPolling()
    this.transaction = null
    await this.qrView?.destroy()
    const state = this.updatePublicState({
      errorCode: null,
      expiresAt: null,
      selectedMethod: preserveSelection ? this.publicState.selectedMethod : null,
      status: nextStatus
    })
    if (notifyRemote) {
      this.cancelRemoteInBackground(active?.transactionId)
    }
    return state
  }

  cancelRemoteInBackground(transactionId) {
    if (!transactionId || !this.client) {
      return
    }

    let request
    try {
      request = this.client.cancelWeCom(transactionId)
    } catch {
      this.rememberLog('[enterprise] background QR cancellation could not be started')
      return
    }

    const task = Promise.resolve(request).catch(() => {
      this.rememberLog('[enterprise] background QR cancellation did not complete')
    })
    this.backgroundCancellationTasks.add(task)
    void task.then(() => this.backgroundCancellationTasks.delete(task))
  }

  setBounds(bounds) {
    if (this.disposing) {
      return this.getPublicState()
    }
    this.qrView?.setBounds(bounds)
    return this.getPublicState()
  }

  boundedWait(promise, timeoutMs = this.disposeWaitMs, onTimeout = () => {}) {
    let timeoutId = null
    const timeout = new Promise(resolve => {
      timeoutId = this.setTimeoutImpl(() => {
        try {
          onTimeout()
        } finally {
          resolve()
        }
      }, timeoutMs)
      timeoutId?.unref?.()
    })

    return Promise.race([Promise.resolve(promise).catch(() => undefined), timeout]).finally(() => {
      if (timeoutId) {
        this.clearTimeoutImpl(timeoutId)
      }
    })
  }

  dispose({ permanent = true } = {}) {
    this.permanentDispose = this.permanentDispose || permanent
    if (this.disposePromise) {
      return this.disposePromise
    }

    this.disposing = true
    const active = this.transaction
    const redeemInFlight = this.redeemPromise
    const redeemAbortController = redeemInFlight ? this.operationAbortController : null
    this.generation += 1
    this.stopPolling()
    this.transaction = null
    if (!redeemInFlight) {
      this.operationAbortController?.abort()
    }
    this.operationAbortController = null
    this.publicState = {
      ...this.publicState,
      errorCode: null,
      expiresAt: null,
      status: 'idle'
    }

    const cleanup = [
      Promise.resolve().then(() => this.qrView?.destroy()).catch(() => undefined),
      ...this.backgroundCancellationTasks
    ]
    if (active?.transactionId && this.client) {
      cleanup.push(Promise.resolve().then(() => this.client.cancelWeCom(active.transactionId)).catch(() => undefined))
    }
    if (redeemInFlight) {
      cleanup.push(redeemInFlight.catch(() => undefined))
    }

    this.disposePromise = this.boundedWait(Promise.allSettled(cleanup), this.disposeWaitMs, () => {
      redeemAbortController?.abort()
    }).then(() => {
      const state = this.getPublicState()
      if (!this.permanentDispose) {
        this.disposing = false
        this.disposePromise = null
      }
      return state
    })
    return this.disposePromise
  }
}

function createEnterpriseWeComController(options) {
  return new EnterpriseWeComController(options)
}

module.exports = {
  EnterpriseWeComController,
  PASSWORD_METHOD,
  WE_COM_METHOD,
  asUtcIso,
  createChallenge,
  createEnterpriseWeComController,
  createInitialPublicState,
  createVerifier,
  normalizeAuthorizationOrigin,
  stableErrorCode,
  validateAuthorizationUrl
}
