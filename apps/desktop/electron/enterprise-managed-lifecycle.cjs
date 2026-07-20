const LIFECYCLE_STATES = Object.freeze([
  'unauthenticated',
  'recovering',
  'running',
  'revoking',
  'blocked',
  'stop_failed'
])

const LIFECYCLE_ERROR_CODES = Object.freeze({
  EFFECT_DENIED: 'enterprise_lifecycle_effect_denied',
  INVALID_TRANSITION: 'enterprise_lifecycle_invalid_transition',
  IPC_DENIED: 'enterprise_lifecycle_ipc_denied',
  INVALID_TERMINAL_STATE: 'enterprise_lifecycle_invalid_terminal_state',
  RETRY_NOT_ALLOWED: 'enterprise_lifecycle_retry_not_allowed'
})

const TERMINAL_STATES = new Set(['blocked', 'unauthenticated'])
const RECOVERY_EFFECTS = new Set(['ensureBackend', 'gatewayWsUrl', 'spawn'])
const LEGAL_TRANSITIONS = Object.freeze({
  unauthenticated: new Set(['recovering']),
  recovering: new Set(['running', 'revoking']),
  running: new Set(['revoking']),
  revoking: new Set(['blocked', 'unauthenticated', 'stop_failed']),
  blocked: new Set(['recovering']),
  stop_failed: new Set()
})

class EnterpriseLifecycleError extends Error {
  constructor(code, state) {
    super(`${code} while enterprise lifecycle is ${state}`)
    this.name = 'EnterpriseLifecycleError'
    this.code = code
    this.state = state
  }
}

function sanitizedReasonCode(reasonCode, fallback = 'enterprise_lifecycle_state_changed') {
  if (typeof reasonCode !== 'string') return fallback
  const normalized = reasonCode.trim().toLowerCase()
  if (!/^[a-z0-9_.-]{1,96}$/.test(normalized)) return fallback
  return normalized
}

function isLifecycleTransitionAllowed(fromState, toState) {
  return Boolean(LEGAL_TRANSITIONS[fromState]?.has(toState))
}

function createEnterpriseManagedLifecycle(options = {}) {
  const effects = {
    cancelPendingStarts: async () => {},
    closeWindowConnections: async () => {},
    stopOwnedProcesses: async () => {},
    verifyResourcesGone: async () => true,
    ...options.effects
  }
  const publish = typeof options.publish === 'function' ? options.publish : () => {}

  let state = options.hasSession === true ? 'recovering' : 'unauthenticated'
  let lifecycleEpoch = 0
  let authEpoch = 0
  let reasonCode = options.hasSession === true
    ? 'enterprise_session_recovery_required'
    : 'enterprise_auth_required'
  let revokePromise = null
  let retryPromise = null

  function getSnapshot() {
    return Object.freeze({
      state,
      lifecycleEpoch,
      authEpoch,
      reasonCode
    })
  }

  function emit() {
    const event = getSnapshot()
    publish(event)
    return event
  }

  function setState(nextState, nextReasonCode) {
    state = nextState
    reasonCode = sanitizedReasonCode(nextReasonCode)
    return emit()
  }

  function transition(nextState, transitionOptions = {}) {
    if (!LIFECYCLE_STATES.includes(nextState) || !isLifecycleTransitionAllowed(state, nextState)) {
      throw new EnterpriseLifecycleError(LIFECYCLE_ERROR_CODES.INVALID_TRANSITION, state)
    }

    if (nextState === 'revoking' || nextState === 'recovering') {
      lifecycleEpoch += 1
    }
    return setState(nextState, transitionOptions.reasonCode)
  }

  function beginRecovery(transitionOptions = {}) {
    return transition('recovering', transitionOptions)
  }

  function markRunning(transitionOptions = {}) {
    return transition('running', transitionOptions)
  }

  function acquireLease() {
    return Object.freeze({ lifecycleEpoch, authEpoch })
  }

  function isLeaseCurrent(lease) {
    return Boolean(
      lease &&
      lease.lifecycleEpoch === lifecycleEpoch &&
      lease.authEpoch === authEpoch
    )
  }

  function advanceAuthEpoch(nextReasonCode = 'enterprise_auth_epoch_advanced') {
    authEpoch += 1
    reasonCode = sanitizedReasonCode(nextReasonCode)
    emit()
    return acquireLease()
  }

  function guardEffect(_effectName, lease, guardOptions = {}) {
    const recoveryAllowed = guardOptions.recovery === true && RECOVERY_EFFECTS.has(_effectName)
    const allowedState = state === 'running' || (recoveryAllowed && state === 'recovering')
    if (!allowedState || !isLeaseCurrent(lease)) {
      throw new EnterpriseLifecycleError(LIFECYCLE_ERROR_CODES.EFFECT_DENIED, state)
    }
    return true
  }

  function guardIpc(_channel, lease) {
    if (state !== 'running' || !isLeaseCurrent(lease)) {
      throw new EnterpriseLifecycleError(LIFECYCLE_ERROR_CODES.IPC_DENIED, state)
    }
    return true
  }

  async function runCleanupEffects() {
    let failed = false
    for (const effectName of [
      'cancelPendingStarts',
      'closeWindowConnections',
      'stopOwnedProcesses'
    ]) {
      try {
        await effects[effectName]()
      } catch {
        failed = true
      }
    }

    try {
      const resourcesGone = await effects.verifyResourcesGone()
      if (resourcesGone !== true) failed = true
    } catch {
      failed = true
    }
    return !failed
  }

  function revoke(revokeOptions = {}) {
    if (revokePromise) return revokePromise
    const terminalState = revokeOptions.terminalState
    if (!TERMINAL_STATES.has(terminalState)) {
      return Promise.reject(new EnterpriseLifecycleError(
        LIFECYCLE_ERROR_CODES.INVALID_TERMINAL_STATE,
        state
      ))
    }
    if (state !== 'running' && state !== 'recovering') {
      return Promise.reject(new EnterpriseLifecycleError(
        LIFECYCLE_ERROR_CODES.INVALID_TRANSITION,
        state
      ))
    }

    transition('revoking', { reasonCode: revokeOptions.reasonCode })
    revokePromise = runCleanupEffects()
      .then(succeeded => {
        if (!succeeded) {
          return setState('stop_failed', 'enterprise_runtime_stop_failed')
        }
        return setState(terminalState, revokeOptions.reasonCode)
      })
      .finally(() => {
        revokePromise = null
      })
    return revokePromise
  }

  function retryStop(retryOptions = {}) {
    if (retryPromise) return retryPromise
    const terminalState = retryOptions.terminalState
    if (!TERMINAL_STATES.has(terminalState)) {
      return Promise.reject(new EnterpriseLifecycleError(
        LIFECYCLE_ERROR_CODES.INVALID_TERMINAL_STATE,
        state
      ))
    }
    if (state !== 'stop_failed') {
      return Promise.reject(new EnterpriseLifecycleError(
        LIFECYCLE_ERROR_CODES.RETRY_NOT_ALLOWED,
        state
      ))
    }

    retryPromise = runCleanupEffects()
      .then(succeeded => {
        if (!succeeded) {
          return setState('stop_failed', 'enterprise_runtime_stop_failed')
        }
        return setState(terminalState, retryOptions.reasonCode)
      })
      .finally(() => {
        retryPromise = null
      })
    return retryPromise
  }

  emit()

  return Object.freeze({
    acquireLease,
    advanceAuthEpoch,
    beginRecovery,
    getSnapshot,
    guardEffect,
    guardIpc,
    isLeaseCurrent,
    markRunning,
    retryStop,
    revoke
  })
}

module.exports = {
  createEnterpriseManagedLifecycle,
  EnterpriseLifecycleError,
  isLifecycleTransitionAllowed,
  LIFECYCLE_ERROR_CODES,
  LIFECYCLE_STATES
}
