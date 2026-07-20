const {
  createEnterprisePublicError,
  enterprisePublicFailure,
  enterprisePublicResult
} = require('./enterprise-public-error.cjs')

function terminalStatus(error) {
  const value = Number(error?.httpStatus ?? error?.status ?? error?.statusCode)
  return Number.isInteger(value) ? value : null
}

function createEnterpriseApiIpcHandler(options = {}) {
  const assertTrusted = options.assertTrusted
  const getLifecycle = options.getLifecycle
  const getPendingResponse = options.getPendingResponse || (() => undefined)
  const isManaged = options.isManaged || (() => true)
  const guard = options.guard
  const handleRawRequest = options.handleRawRequest
  const runtimeAccess = options.runtimeAccess

  if (!guard?.handleApiRequest || !runtimeAccess?.begin || typeof handleRawRequest !== 'function') {
    throw new TypeError('Enterprise API IPC wiring is incomplete.')
  }

  function lifecycle() {
    const current = getLifecycle?.()
    if (!current?.getSnapshot || !current?.revoke) {
      throw new TypeError('Enterprise API IPC requires a managed lifecycle.')
    }
    return current
  }

  function safeLifecycleSnapshot() {
    try {
      return getLifecycle?.()?.getSnapshot?.() || null
    } catch {
      return null
    }
  }

  async function run(event, request) {
    try {
      assertTrusted?.(event)
    } catch {
      return enterprisePublicFailure(createEnterprisePublicError({
        code: 'enterprise_untrusted_renderer',
        status: 403
      }, { lifecycle: safeLifecycleSnapshot() }))
    }

    let managed
    try {
      managed = isManaged() === true
    } catch (error) {
      return enterprisePublicFailure(createEnterprisePublicError(error))
    }
    let currentLifecycle = null
    if (managed) {
      try {
        currentLifecycle = lifecycle()
      } catch (error) {
        return enterprisePublicFailure(createEnterprisePublicError(error, { lifecycle: safeLifecycleSnapshot() }))
      }
    }
    const initialSnapshot = currentLifecycle?.getSnapshot() || { lifecycleEpoch: 0 }
    const pending = getPendingResponse(request)
    if (pending !== undefined) return enterprisePublicResult(pending)

    let active = null
    try {
      active = runtimeAccess.begin('hermes:api', { ipc: true })
      const raw = await guard.handleApiRequest(request, normalized => handleRawRequest(normalized, active))
      active.checkpoint()
      active.finish()
      return enterprisePublicResult(raw)
    } catch (error) {
      active?.cancel?.(error)
      const status = terminalStatus(error)
      const state = currentLifecycle?.getSnapshot().state
      let terminalTransition = false
      if (managed && (status === 401 || status === 403 || status === 426) && (state === 'running' || state === 'recovering')) {
        await currentLifecycle.revoke({
          reasonCode: status === 401
            ? 'enterprise_auth_expired'
            : status === 426
              ? 'enterprise_contract_upgrade_required'
              : 'enterprise_policy_denied',
          terminalState: status === 401 ? 'unauthenticated' : 'blocked'
        })
        terminalTransition = true
      }
      const publicError = !managed && (status === 401 || status === 403 || status === 426)
        ? { code: 'local_backend_request_failed', status }
        : error
      return enterprisePublicFailure(createEnterprisePublicError(publicError, {
        lifecycle: currentLifecycle?.getSnapshot() || null,
        operationEpoch: active?.lease?.lifecycleEpoch ?? initialSnapshot.lifecycleEpoch,
        useCurrentEpoch: terminalTransition
      }))
    } finally {
      active?.finish()
    }
  }

  return Object.freeze({ run })
}

module.exports = { createEnterpriseApiIpcHandler, terminalStatus }
