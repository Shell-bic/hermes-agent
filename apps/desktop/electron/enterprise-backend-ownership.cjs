const BACKEND_OWNERSHIP_ERROR_CODES = Object.freeze({
  START_ABORTED: 'enterprise_backend_start_aborted',
  STOP_FAILED: 'enterprise_backend_stop_failed'
})

class EnterpriseBackendOwnershipError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'EnterpriseBackendOwnershipError'
    this.code = code
  }
}

async function runBackendStartSequence({ managed = false, prepareLaunch, resolveRuntime, spawnBackend } = {}) {
  if (typeof resolveRuntime !== 'function') {
    throw new TypeError('Backend runtime resolution must be deferred.')
  }
  if (managed && typeof prepareLaunch !== 'function') {
    throw new TypeError('Managed backend policy preparation must be deferred.')
  }
  if (typeof spawnBackend !== 'function') {
    throw new TypeError('Backend spawn must be deferred.')
  }

  const enterpriseLaunch = managed ? await prepareLaunch() : { enabled: false }
  const backend = await resolveRuntime(enterpriseLaunch)
  const spawned = await spawnBackend({ backend, enterpriseLaunch })

  return { backend, enterpriseLaunch, spawned }
}

async function stopOwnedBackendsForMaintenance({ lifecycle, managed = false, ownership, reasonCode } = {}) {
  if (!ownership) throw new TypeError('Backend ownership is required for maintenance teardown.')

  if (managed) {
    if (!lifecycle) throw new TypeError('Enterprise lifecycle is required for managed maintenance teardown.')
    const state = lifecycle.getSnapshot().state
    if (state === 'running' || state === 'recovering' || state === 'revoking') {
      await lifecycle.revoke({ reasonCode, terminalState: 'blocked' })
    } else if (state === 'stop_failed') {
      await lifecycle.retryStop({ reasonCode, terminalState: 'blocked' })
    } else {
      await ownership.cancelPendingStarts()
      await ownership.stopOwnedProcesses()
    }
  } else {
    await ownership.cancelPendingStarts()
    await ownership.stopOwnedProcesses()
  }

  if (managed && lifecycle.getSnapshot().state === 'stop_failed') {
    throw new EnterpriseBackendOwnershipError(
      BACKEND_OWNERSHIP_ERROR_CODES.STOP_FAILED,
      'Enterprise backend process trees are still alive.'
    )
  }
  if (await ownership.verifyResourcesGone() !== true) {
    throw new EnterpriseBackendOwnershipError(
      BACKEND_OWNERSHIP_ERROR_CODES.STOP_FAILED,
      'Backend resources remain after maintenance teardown.'
    )
  }
  return true
}

async function runBackendMaintenanceHandoff({ continueHandoff, stopBackends, verifyReady = null } = {}) {
  if (typeof stopBackends !== 'function' || typeof continueHandoff !== 'function') {
    throw new TypeError('Maintenance teardown and handoff must be deferred.')
  }

  await stopBackends()
  if (verifyReady && await verifyReady() !== true) {
    throw new EnterpriseBackendOwnershipError(
      BACKEND_OWNERSHIP_ERROR_CODES.STOP_FAILED,
      'Backend maintenance handoff is not safe to continue.'
    )
  }
  return continueHandoff()
}

function createEnterpriseBackendOwnership(options = {}) {
  const getLifecycle = options.getLifecycle
  const isManaged = typeof options.isManaged === 'function' ? options.isManaged : () => true
  const listOwnedProcesses = options.listOwnedProcesses || (() => [])
  const clearOwnedProcess = options.clearOwnedProcess || (() => {})
  const gracefulStop = options.gracefulStop || (async () => {})
  const forceStopTree = options.forceStopTree || (async () => {})
  const waitForExit = options.waitForExit || (async () => {})
  const clearConnectionResources = options.clearConnectionResources || (() => {})
  const verifyConnectionResourcesGone = options.verifyConnectionResourcesGone || (() => true)
  const captureProcessIdentity = options.captureProcessIdentity || (process => process)
  const waitForProcessIdentity = options.waitForProcessIdentity || (async identity => identity)
  const probeProcessTree = options.probeProcessTree || (async process => {
    return process?.exitCode === null && process?.signalCode === null && process?.killed !== true
  })

  const pendingStarts = new Map()
  let nextStartId = 1
  let lastStopOwners = []

  function lifecycle() {
    const value = getLifecycle?.()
    if (!value) throw new Error('Enterprise lifecycle is not initialized.')
    return value
  }

  function beginStart(owner = {}) {
    const managed = isManaged() === true
    const controller = new AbortController()
    const ticket = {
      controller,
      id: nextStartId++,
      key: String(owner.key || 'backend'),
      lease: managed ? lifecycle().acquireLease() : null,
      managed,
      recovery: owner.recovery === true,
      settlePromise: Promise.resolve(),
      signal: controller.signal
    }
    if (managed) {
      lifecycle().guardEffect('spawn', ticket.lease, { recovery: ticket.recovery })
    }
    pendingStarts.set(ticket.id, ticket)
    return ticket
  }

  function checkpoint(ticket) {
    if (!ticket || ticket.signal?.aborted) {
      throw new EnterpriseBackendOwnershipError(
        BACKEND_OWNERSHIP_ERROR_CODES.START_ABORTED,
        'Enterprise backend start was canceled.'
      )
    }
    if (ticket.managed) {
      lifecycle().guardEffect('spawn', ticket.lease, { recovery: ticket.recovery })
    }
    return true
  }

  async function awaitCheckpoint(ticket, operation) {
    checkpoint(ticket)
    if (typeof operation !== 'function') {
      throw new TypeError('Enterprise backend guarded awaits require a deferred operation function.')
    }
    let onAbort
    const aborted = new Promise((_resolve, reject) => {
      onAbort = () => reject(new EnterpriseBackendOwnershipError(
        BACKEND_OWNERSHIP_ERROR_CODES.START_ABORTED,
        'Enterprise backend start was canceled.'
      ))
      ticket.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => {
          checkpoint(ticket)
          return operation(ticket.signal)
        }),
        aborted
      ])
      checkpoint(ticket)
      return value
    } finally {
      ticket.signal.removeEventListener('abort', onAbort)
    }
  }

  function finishStart(ticket) {
    if (ticket && pendingStarts.get(ticket.id) === ticket) {
      pendingStarts.delete(ticket.id)
    }
  }

  function trackStart(ticket, promise) {
    ticket.settlePromise = Promise.resolve(promise)
      .catch(() => undefined)
      .finally(() => finishStart(ticket))
    return promise
  }

  async function cancelPendingStarts() {
    const starts = [...pendingStarts.values()]
    for (const ticket of starts) ticket.controller.abort()
    await Promise.allSettled(starts.map(ticket => ticket.settlePromise))
  }

  async function cancelStart(ticket) {
    if (!ticket) return
    ticket.controller.abort()
    await Promise.allSettled([ticket.settlePromise])
  }

  function childIsCurrent(ticket, child, getCurrent) {
    if (!ticket || ticket.signal.aborted || getCurrent() !== child) return false
    return !ticket.managed || lifecycle().isLeaseCurrent(ticket.lease)
  }

  function bindChild(ticket, child, handlers = {}) {
    const getCurrent = handlers.getCurrent || (() => child)
    const clearCurrent = handlers.clearCurrent || (() => {})

    child.once('error', error => {
      if (!childIsCurrent(ticket, child, getCurrent)) return
      clearCurrent(child)
      handlers.onError?.(error)
    })
    child.once('exit', (code, signal) => {
      if (!childIsCurrent(ticket, child, getCurrent)) return
      clearCurrent(child)
      handlers.onExit?.(code, signal)
    })
  }

  function uniqueOwners(owners) {
    const seen = new Set()
    return owners.filter(owner => {
      const process = owner?.process
      if (!process) return false
      const identity = owner.processIdentity || captureProcessIdentity(process)
      if (seen.has(identity)) return false
      seen.add(identity)
      owner.processIdentity = identity
      return true
    })
  }

  async function processIsAlive(owner) {
    try {
      await waitForProcessIdentity(owner.processIdentity)
      return await probeProcessTree(owner.process, owner.processIdentity) === true
    } catch {
      return true
    }
  }

  async function stopOwners(owners) {
    const captured = uniqueOwners([...lastStopOwners, ...owners])

    for (const owner of captured) {
      if (!(await processIsAlive(owner))) {
        clearOwnedProcess(owner, owner.process)
        continue
      }
      try {
        await gracefulStop(owner.process, owner.processIdentity)
      } catch {
        // The force/probe sequence below remains authoritative.
      }
      try {
        await waitForExit(owner.process, owner.processIdentity)
      } catch {
        // Continue to the liveness probe.
      }
    }

    const stillAlive = []
    for (const owner of captured) {
      if (await processIsAlive(owner)) stillAlive.push(owner)
    }
    for (const owner of stillAlive) {
      try {
        await forceStopTree(owner.process, owner.processIdentity)
      } catch {
        // Continue to the final liveness probe.
      }
      try {
        await waitForExit(owner.process, owner.processIdentity)
      } catch {
        // Continue to the final liveness probe.
      }
    }

    const survivors = []
    for (const owner of captured) {
      if (await processIsAlive(owner)) survivors.push(owner)
      else clearOwnedProcess(owner, owner.process)
    }
    lastStopOwners = survivors
    if (survivors.length > 0) {
      throw new EnterpriseBackendOwnershipError(
        BACKEND_OWNERSHIP_ERROR_CODES.STOP_FAILED,
        'One or more enterprise backend process trees are still alive.'
      )
    }
  }

  async function stopOwnedProcesses() {
    const captured = listOwnedProcesses()
    clearConnectionResources()
    await stopOwners(captured)
  }

  async function verifyResourcesGone() {
    if (pendingStarts.size > 0 || await verifyConnectionResourcesGone() !== true) return false
    const owners = uniqueOwners([...listOwnedProcesses(), ...lastStopOwners])
    for (const owner of owners) {
      if (await processIsAlive(owner)) return false
    }
    return true
  }

  return Object.freeze({
    beginStart,
    awaitCheckpoint,
    bindChild,
    cancelPendingStarts,
    cancelStart,
    checkpoint,
    finishStart,
    lifecycleEffects: Object.freeze({
      cancelPendingStarts,
      stopOwnedProcesses,
      verifyResourcesGone
    }),
    stopOwnedProcesses,
    stopOwners,
    trackStart,
    verifyResourcesGone
  })
}

module.exports = {
  BACKEND_OWNERSHIP_ERROR_CODES,
  createEnterpriseBackendOwnership,
  EnterpriseBackendOwnershipError,
  runBackendStartSequence,
  runBackendMaintenanceHandoff,
  stopOwnedBackendsForMaintenance
}
