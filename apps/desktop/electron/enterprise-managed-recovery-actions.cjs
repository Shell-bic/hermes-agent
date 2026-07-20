const RECOVERY_ACTION_ERROR_CODES = Object.freeze({
  BUSY: 'enterprise_recovery_action_busy',
  INVALID_STATE: 'enterprise_recovery_action_invalid_state',
  SESSION_REQUIRED: 'desktop_session_required',
  STOP_FAILED: 'enterprise_runtime_stop_failed'
})

class EnterpriseRecoveryActionError extends Error {
  constructor(code) {
    super(code)
    this.name = 'EnterpriseRecoveryActionError'
    this.code = code
  }
}

function createEnterpriseManagedRecoveryActions(options = {}) {
  const getLifecycle = options.getLifecycle
  const hasSession = typeof options.hasSession === 'function' ? options.hasSession : () => false
  const beforeStart = typeof options.beforeStart === 'function' ? options.beforeStart : async () => {}
  const startBackend = options.startBackend
  let active = null

  if (typeof getLifecycle !== 'function' || typeof startBackend !== 'function') {
    throw new TypeError('Managed recovery actions require lifecycle and backend start access.')
  }

  function lifecycle() {
    const value = getLifecycle()
    if (!value) throw new TypeError('Managed recovery lifecycle is not initialized.')
    return value
  }

  function runSingleFlight(kind, operation) {
    if (active) {
      if (active.kind === kind) return active.promise
      return Promise.reject(new EnterpriseRecoveryActionError(RECOVERY_ACTION_ERROR_CODES.BUSY))
    }

    const promise = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (active?.promise === promise) active = null
      })
    active = { kind, promise }
    return promise
  }

  async function startOneControlledRecovery(reasonCode) {
    const current = lifecycle()
    if (!hasSession()) {
      throw new EnterpriseRecoveryActionError(RECOVERY_ACTION_ERROR_CODES.SESSION_REQUIRED)
    }
    if (current.getSnapshot().state !== 'blocked') {
      throw new EnterpriseRecoveryActionError(RECOVERY_ACTION_ERROR_CODES.INVALID_STATE)
    }

    current.beginRecovery({ reasonCode })
    try {
      await beforeStart()
      await startBackend()
      const snapshot = current.getSnapshot()
      if (snapshot.state !== 'running') {
        throw new EnterpriseRecoveryActionError(RECOVERY_ACTION_ERROR_CODES.INVALID_STATE)
      }
      return snapshot
    } catch (error) {
      const failedState = current.getSnapshot().state
      if (failedState === 'recovering' || failedState === 'running') {
        try {
          await current.revoke({
            reasonCode: 'enterprise_user_recovery_failed',
            terminalState: 'blocked'
          })
        } catch {
          // The authoritative lifecycle state below decides whether cleanup
          // reached blocked or must remain stop_failed.
        }
      }
      if (current.getSnapshot().state === 'stop_failed') {
        throw new EnterpriseRecoveryActionError(RECOVERY_ACTION_ERROR_CODES.STOP_FAILED)
      }
      throw error
    }
  }

  function refreshPolicy() {
    return runSingleFlight('refresh-policy', () =>
      startOneControlledRecovery('enterprise_user_requested_policy_refresh')
    )
  }

  function retryStop() {
    return runSingleFlight('retry-stop', async () => {
      const current = lifecycle()
      if (current.getSnapshot().state !== 'stop_failed') {
        throw new EnterpriseRecoveryActionError(RECOVERY_ACTION_ERROR_CODES.INVALID_STATE)
      }

      try {
        await current.retryStop({
          reasonCode: 'enterprise_user_requested_stop_retry',
          terminalState: 'blocked'
        })
      } catch (error) {
        if (current.getSnapshot().state === 'stop_failed') {
          throw new EnterpriseRecoveryActionError(RECOVERY_ACTION_ERROR_CODES.STOP_FAILED)
        }
        throw error
      }

      if (current.getSnapshot().state !== 'blocked') {
        throw new EnterpriseRecoveryActionError(RECOVERY_ACTION_ERROR_CODES.STOP_FAILED)
      }
      return startOneControlledRecovery('enterprise_user_requested_stop_recovery')
    })
  }

  return Object.freeze({ refreshPolicy, retryStop })
}

module.exports = {
  createEnterpriseManagedRecoveryActions,
  EnterpriseRecoveryActionError,
  RECOVERY_ACTION_ERROR_CODES
}
