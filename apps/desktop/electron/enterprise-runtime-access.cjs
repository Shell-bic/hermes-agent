class EnterpriseOperationSupersededError extends Error {
  constructor() {
    super('Enterprise operation was superseded by a lifecycle transition.')
    this.name = 'EnterpriseOperationSupersededError'
    this.code = 'enterprise_operation_superseded'
  }
}

function createEnterpriseRuntimeAccess(options = {}) {
  const getLifecycle = options.getLifecycle
  const isManaged = typeof options.isManaged === 'function' ? options.isManaged : () => true

  function lifecycle() {
    const value = getLifecycle?.()
    if (!value) throw new Error('Enterprise lifecycle is not initialized.')
    return value
  }

  function acquire(effectName, { allowRecovery = false, ipc = false } = {}) {
    if (!isManaged()) return null
    const current = lifecycle()
    const lease = current.acquireLease()
    if (ipc) current.guardIpc(effectName, lease)
    else current.guardEffect(effectName, lease, { recovery: allowRecovery })
    return lease
  }

  function checkpoint(effectName, lease, { allowRecovery = false, ipc = false } = {}) {
    if (!isManaged()) return true
    const current = lifecycle()
    if (ipc) current.guardIpc(effectName, lease)
    else current.guardEffect(effectName, lease, { recovery: allowRecovery })
    return true
  }

  function begin(effectName, accessOptions = {}) {
    const lease = acquire(effectName, accessOptions)
    const controller = new AbortController()
    let finished = false
    let unsubscribe = null

    if (isManaged()) {
      const current = lifecycle()
      if (typeof current.subscribe !== 'function' || typeof current.isLeaseCurrent !== 'function') {
        throw new TypeError('Managed enterprise lifecycle must support subscriptions and lease checks.')
      }
      const abortIfStale = () => {
        if (!finished && !current.isLeaseCurrent(lease)) {
          controller.abort(new EnterpriseOperationSupersededError())
        }
      }
      unsubscribe = current.subscribe(abortIfStale)
      try {
        // Close the acquire -> subscribe race: a revoke between those two
        // statements must fail here before the caller can start an effect.
        checkpoint(effectName, lease, accessOptions)
      } catch (error) {
        abortIfStale()
        unsubscribe?.()
        unsubscribe = null
        throw error
      }
    }

    function finish(finishOptions = {}) {
      if (finished) return
      if (finishOptions.abort === true && !controller.signal.aborted) {
        controller.abort(finishOptions.reason || new EnterpriseOperationSupersededError())
      }
      finished = true
      unsubscribe?.()
      unsubscribe = null
    }

    return Object.freeze({
      cancel: reason => finish({ abort: true, reason }),
      checkpoint: () => checkpoint(effectName, lease, accessOptions),
      finish,
      lease,
      signal: controller.signal
    })
  }

  async function run(effectName, operation, accessOptions = {}) {
    const active = begin(effectName, accessOptions)
    try {
      const value = await operation(active.lease, active.signal)
      active.checkpoint()
      active.finish()
      return value
    } catch (error) {
      active.cancel(error)
      throw error
    } finally {
      active.finish()
    }
  }

  return Object.freeze({ acquire, begin, checkpoint, run })
}

module.exports = { createEnterpriseRuntimeAccess, EnterpriseOperationSupersededError }
