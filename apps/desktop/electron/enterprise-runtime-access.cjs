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

  async function run(effectName, operation, accessOptions = {}) {
    const lease = acquire(effectName, accessOptions)
    const value = await operation(lease)
    checkpoint(effectName, lease, accessOptions)
    return value
  }

  return Object.freeze({ acquire, checkpoint, run })
}

module.exports = { createEnterpriseRuntimeAccess }
