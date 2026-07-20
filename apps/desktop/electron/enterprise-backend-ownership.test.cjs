const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { createEnterpriseManagedLifecycle } = require('./enterprise-managed-lifecycle.cjs')
const {
  createEnterpriseBackendOwnership,
  runBackendStartSequence,
  runBackendMaintenanceHandoff,
  runPlatformBackendMaintenanceHandoff,
  stopOwnedBackendsForMaintenance
} = require('./enterprise-backend-ownership.cjs')

function deferred() {
  let resolve
  const promise = new Promise(next => {
    resolve = next
  })
  return { promise, resolve }
}

function child(pid) {
  const value = new EventEmitter()
  value.pid = pid
  value.exitCode = null
  value.signalCode = null
  value.killed = false
  return value
}

function createHarness({ alive = new Set(), connectionResources = new Set(), stopCalls = [] } = {}) {
  const owned = new Map()
  let lifecycle
  const ownership = createEnterpriseBackendOwnership({
    clearConnectionResources: () => connectionResources.clear(),
    clearOwnedProcess: owner => owned.delete(owner.key),
    forceStopTree: async process => stopCalls.push(`force:${process.pid}`),
    getLifecycle: () => lifecycle,
    gracefulStop: async process => stopCalls.push(`graceful:${process.pid}`),
    isManaged: () => true,
    listOwnedProcesses: () => [...owned.values()],
    probeProcessTree: async process => alive.has(process.pid),
    verifyConnectionResourcesGone: () => connectionResources.size === 0,
    waitForExit: async process => stopCalls.push(`wait:${process.pid}`)
  })
  lifecycle = createEnterpriseManagedLifecycle({
    hasSession: true,
    effects: ownership.lifecycleEffects
  })
  return { connectionResources, lifecycle, owned, ownership }
}

test('managed policy preparation resolves before runtime resolution and spawn effects', async () => {
  const prepared = deferred()
  const calls = []
  const prerequisites = runBackendStartSequence({
    managed: true,
    prepareLaunch: async () => {
      calls.push('prepare:start')
      const launch = await prepared.promise
      calls.push('prepare:done')
      return launch
    },
    resolveRuntime: async launch => {
      calls.push(`runtime:${launch.hermesHome}`)
      return { command: 'python' }
    },
    spawnBackend: async ({ backend }) => {
      calls.push(`spawn:${backend.command}`)
      return { pid: 101 }
    }
  })

  await Promise.resolve()
  assert.deepEqual(calls, ['prepare:start'])
  prepared.resolve({ enabled: true, hermesHome: 'managed-home' })
  const result = await prerequisites

  assert.equal(result.enterpriseLaunch.hermesHome, 'managed-home')
  assert.equal(result.spawned.pid, 101)
  assert.deepEqual(calls, ['prepare:start', 'prepare:done', 'runtime:managed-home', 'spawn:python'])
})

test('rejected managed policy preparation prevents runtime resolution and spawn effects', async () => {
  const calls = []
  const start = runBackendStartSequence({
    managed: true,
    prepareLaunch: async () => {
      calls.push('prepare')
      throw Object.assign(new Error('revoked'), { code: 'enterprise_operation_superseded' })
    },
    resolveRuntime: async () => {
      calls.push('runtime')
      return { command: 'python' }
    },
    spawnBackend: async () => calls.push('spawn')
  })

  await assert.rejects(start, error => error.code === 'enterprise_operation_superseded')
  assert.deepEqual(calls, ['prepare'])
})

test('maintenance handoff stops and verifies ownership before destructive continuation', async () => {
  const calls = []
  const result = await runBackendMaintenanceHandoff({
    continueHandoff: async () => {
      calls.push('continue')
      return 'continued'
    },
    stopBackends: async () => calls.push('stop'),
    verifyReady: async () => {
      calls.push('verify')
      return true
    }
  })

  assert.equal(result, 'continued')
  assert.deepEqual(calls, ['stop', 'verify', 'continue'])
})

test('maintenance handoff never continues after stop or unlock verification failure', async t => {
  await t.test('stop failure', async () => {
    const calls = []
    await assert.rejects(runBackendMaintenanceHandoff({
      continueHandoff: async () => calls.push('continue'),
      stopBackends: async () => {
        calls.push('stop')
        throw new Error('stop failed')
      },
      verifyReady: async () => {
        calls.push('verify')
        return true
      }
    }), /stop failed/)
    assert.deepEqual(calls, ['stop'])
  })

  await t.test('unlock failure', async () => {
    const calls = []
    await assert.rejects(runBackendMaintenanceHandoff({
      continueHandoff: async () => calls.push('continue'),
      stopBackends: async () => calls.push('stop'),
      verifyReady: async () => {
        calls.push('verify')
        return false
      }
    }), error => error.code === 'enterprise_backend_stop_failed')
    assert.deepEqual(calls, ['stop', 'verify'])
  })
})

test('platform maintenance closes POSIX ownership and preserves the Windows readiness gate', async t => {
  await t.test('POSIX stop failure blocks destructive continuation', async () => {
    const calls = []
    await assert.rejects(runPlatformBackendMaintenanceHandoff({
      platform: 'linux',
      continueHandoff: async () => {
        calls.push('update')
        calls.push('rebuild')
        calls.push('swap')
      },
      stopBackends: async () => {
        calls.push('stop')
        throw new Error('posix stop failed')
      }
    }), /posix stop failed/)
    assert.deepEqual(calls, ['stop'])
  })

  await t.test('Windows still requires successful lock readiness verification', async () => {
    const calls = []
    await assert.rejects(runPlatformBackendMaintenanceHandoff({
      platform: 'win32',
      continueHandoff: async () => calls.push('continue'),
      stopBackends: async () => calls.push('stop'),
      verifyWindowsReady: async () => {
        calls.push('verify')
        return false
      }
    }), error => error.code === 'enterprise_backend_stop_failed')
    assert.deepEqual(calls, ['stop', 'verify'])
  })
})

test('pending start is aborted and cleanup waits for its guarded await to settle', async () => {
  const { lifecycle, ownership } = createHarness()
  const gate = deferred()
  const ticket = ownership.beginStart({ key: 'primary', recovery: true })
  const start = (async () => {
    await gate.promise
    ownership.checkpoint(ticket)
  })()
  ownership.trackStart(ticket, start)

  let cleanupSettled = false
  const cleanup = ownership.cancelPendingStarts().then(() => {
    cleanupSettled = true
  })
  await Promise.resolve()
  assert.equal(ticket.signal.aborted, true)
  assert.equal(cleanupSettled, false)

  gate.resolve()
  await assert.rejects(start, error => error.code === 'enterprise_backend_start_aborted')
  await cleanup
  assert.equal(cleanupSettled, true)
  assert.equal(lifecycle.getSnapshot().state, 'recovering')
})

test('every post-await checkpoint rejects a lease invalidated during revocation', async () => {
  const { lifecycle, ownership } = createHarness()
  const ticket = ownership.beginStart({ key: 'primary', recovery: true })
  lifecycle.markRunning()
  const oldLease = ticket.lease

  const revoke = lifecycle.revoke({ terminalState: 'blocked' })
  await revoke
  assert.equal(lifecycle.isLeaseCurrent(oldLease), false)
  assert.throws(() => ownership.checkpoint(ticket), error => {
    assert.ok([
      'enterprise_backend_start_aborted',
      'enterprise_lifecycle_effect_denied'
    ].includes(error.code))
    return true
  })
})

test('captured child identity and epoch prevent old events from clearing a replacement', () => {
  const { lifecycle, owned, ownership } = createHarness()
  lifecycle.markRunning()
  const oldChild = child(101)
  const newChild = child(202)
  const oldOwner = { key: 'pool:finance', process: oldChild }
  const newOwner = { key: 'pool:finance', process: newChild }
  owned.set(oldOwner.key, oldOwner)

  const ticket = ownership.beginStart({ key: oldOwner.key })
  ownership.bindChild(ticket, oldChild, {
    clearCurrent: () => owned.delete(oldOwner.key),
    getCurrent: () => owned.get(oldOwner.key)?.process || null
  })
  owned.set(newOwner.key, newOwner)

  oldChild.emit('error', new Error('old child error'))
  oldChild.emit('exit', 1, null)
  assert.equal(owned.get(newOwner.key).process, newChild)

  const replacementTicket = ownership.beginStart({ key: newOwner.key })
  ownership.bindChild(replacementTicket, newChild, {
    clearCurrent: () => owned.delete(newOwner.key),
    getCurrent: () => owned.get(newOwner.key)?.process || null
  })
  lifecycle.advanceAuthEpoch()
  newChild.emit('exit', 0, null)
  assert.equal(owned.get(newOwner.key).process, newChild)
})

test('terminal cleanup probes after force kill and stop_failed blocks spawn until explicit retry verifies gone', async () => {
  const alive = new Set([303])
  const stopCalls = []
  const { lifecycle, owned, ownership } = createHarness({ alive, stopCalls })
  lifecycle.markRunning()
  owned.set('primary', { key: 'primary', process: child(303) })

  await lifecycle.revoke({ terminalState: 'blocked', reasonCode: 'policy_denied' })
  assert.equal(lifecycle.getSnapshot().state, 'stop_failed')
  assert.deepEqual(stopCalls, ['graceful:303', 'wait:303', 'force:303', 'wait:303'])
  assert.throws(() => ownership.beginStart({ key: 'primary' }), error => {
    assert.equal(error.code, 'enterprise_lifecycle_effect_denied')
    return true
  })

  alive.delete(303)
  await lifecycle.retryStop({ terminalState: 'blocked', reasonCode: 'policy_denied' })
  assert.equal(lifecycle.getSnapshot().state, 'blocked')
  assert.equal(owned.has('primary'), false)
})

test('abort-aware start await lets revoke reach child stop even when readiness never resolves', async () => {
  const alive = new Set([404])
  const owned = new Map()
  const stopCalls = []
  let lifecycle
  const ownership = createEnterpriseBackendOwnership({
    clearOwnedProcess: owner => owned.delete(owner.key),
    forceStopTree: async process => {
      stopCalls.push(`force:${process.pid}`)
      alive.delete(process.pid)
    },
    getLifecycle: () => lifecycle,
    gracefulStop: async process => stopCalls.push(`graceful:${process.pid}`),
    isManaged: () => true,
    listOwnedProcesses: () => [...owned.values()],
    probeProcessTree: async process => alive.has(process.pid),
    waitForExit: async process => stopCalls.push(`wait:${process.pid}`)
  })
  lifecycle = createEnterpriseManagedLifecycle({ hasSession: true, effects: ownership.lifecycleEffects })
  const ticket = ownership.beginStart({ key: 'primary', recovery: true })
  owned.set('primary', { key: 'primary', process: child(404) })
  const never = new Promise(() => {})
  const start = ownership.awaitCheckpoint(ticket, () => never)
  ownership.trackStart(ticket, start)

  const revoke = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  await assert.rejects(start, error => error.code === 'enterprise_backend_start_aborted')
  await revoke

  assert.equal(lifecycle.getSnapshot().state, 'blocked')
  assert.deepEqual(stopCalls, ['graceful:404', 'wait:404', 'force:404', 'wait:404'])
  assert.equal(owned.size, 0)
})

test('revoke clears remote primary, remote pool, and pending descriptors before a fresh recovery', async () => {
  const connectionResources = new Set(['remote-primary', 'remote-pool:finance'])
  const { lifecycle, ownership } = createHarness({ connectionResources })
  const pending = ownership.beginStart({ key: 'pool:local-pending', recovery: true })
  const gate = deferred()
  const start = ownership.awaitCheckpoint(pending, () => gate.promise)
  ownership.trackStart(pending, start)

  const revoke = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  await assert.rejects(start, error => error.code === 'enterprise_backend_start_aborted')
  await revoke
  assert.equal(connectionResources.size, 0)
  assert.equal(lifecycle.getSnapshot().state, 'blocked')

  lifecycle.beginRecovery({ reasonCode: 'explicit_login' })
  const fresh = ownership.beginStart({ key: 'primary', recovery: true })
  assert.notEqual(fresh, pending)
  ownership.finishStart(fresh)
})

test('retryStop retains a pool survivor after connection registries were cleared', async () => {
  const alive = new Set([501, 502])
  const owned = new Map([
    ['primary', { key: 'primary', process: child(501) }],
    ['pool:finance', { key: 'pool:finance', process: child(502) }]
  ])
  let lifecycle
  let retryCanKillPool = false
  const ownership = createEnterpriseBackendOwnership({
    clearConnectionResources: () => owned.delete('pool:finance'),
    clearOwnedProcess: owner => owned.delete(owner.key),
    forceStopTree: async process => {
      if (process.pid === 501 || retryCanKillPool) alive.delete(process.pid)
    },
    getLifecycle: () => lifecycle,
    gracefulStop: async () => {},
    isManaged: () => true,
    listOwnedProcesses: () => [...owned.values()],
    probeProcessTree: async process => alive.has(process.pid),
    verifyConnectionResourcesGone: () => true,
    waitForExit: async () => {}
  })
  lifecycle = createEnterpriseManagedLifecycle({ hasSession: true, effects: ownership.lifecycleEffects })
  lifecycle.markRunning()

  await lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  assert.equal(lifecycle.getSnapshot().state, 'stop_failed')
  assert.deepEqual([...alive], [502])

  retryCanKillPool = true
  await lifecycle.retryStop({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  assert.equal(lifecycle.getSnapshot().state, 'blocked')
  assert.equal(alive.size, 0)
})

test('cancel before the guarded microtask prevents the next start stage from being invoked', async () => {
  const { ownership } = createHarness()
  const ticket = ownership.beginStart({ key: 'primary', recovery: true })
  let stageCalls = 0
  const stage = ownership.awaitCheckpoint(ticket, async () => {
    stageCalls += 1
  })
  const cancel = ownership.cancelStart(ticket)

  await assert.rejects(stage, error => error.code === 'enterprise_backend_start_aborted')
  await cancel
  assert.equal(stageCalls, 0)
})

test('process identity mismatch is treated as the owned instance already gone and never force-kills a reused PID', async () => {
  const stopCalls = []
  const ownedProcess = child(404)
  const owner = { key: 'primary', process: ownedProcess, processIdentity: 'instance-old' }
  const ownership = createEnterpriseBackendOwnership({
    clearOwnedProcess: () => {},
    forceStopTree: async () => stopCalls.push('force'),
    gracefulStop: async () => stopCalls.push('graceful'),
    listOwnedProcesses: () => [owner],
    probeProcessTree: async (_process, identity) => identity === 'instance-current',
    waitForExit: async () => stopCalls.push('wait')
  })

  await ownership.stopOwnedProcesses()

  assert.deepEqual(stopCalls, [])
  assert.equal(await ownership.verifyResourcesGone(), true)
})

test('revocation waits for in-flight identity capture and stops the captured process instance', async () => {
  const identityCapture = deferred()
  const ownedProcess = child(606)
  const identity = { capturePromise: identityCapture.promise, marker: null }
  const owned = new Map([['primary', { key: 'primary', process: ownedProcess, processIdentity: identity }]])
  const calls = []
  let alive = true
  let lifecycle
  const ownership = createEnterpriseBackendOwnership({
    clearOwnedProcess: owner => owned.delete(owner.key),
    forceStopTree: async () => {
      calls.push('force')
      alive = false
    },
    getLifecycle: () => lifecycle,
    gracefulStop: async (_process, captured) => calls.push(`graceful:${captured.marker}`),
    isManaged: () => true,
    listOwnedProcesses: () => [...owned.values()],
    probeProcessTree: async (_process, captured) => alive && captured.marker === 'instance-606',
    waitForExit: async () => calls.push('wait'),
    waitForProcessIdentity: async captured => captured.capturePromise
  })
  lifecycle = createEnterpriseManagedLifecycle({ hasSession: true, effects: ownership.lifecycleEffects })
  lifecycle.markRunning()

  let settled = false
  const revoke = lifecycle.revoke({ terminalState: 'blocked' }).then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.deepEqual(calls, [])

  identity.marker = 'instance-606'
  identityCapture.resolve(identity)
  await revoke

  assert.equal(lifecycle.getSnapshot().state, 'blocked')
  assert.deepEqual(calls, ['graceful:instance-606', 'wait', 'force', 'wait'])
  assert.equal(owned.size, 0)
})

test('maintenance during the post-spawn orchestration gap waits for identity and stops that instance', async () => {
  const identityCapture = deferred()
  const spawnReturned = deferred()
  const spawned = deferred()
  const ownedProcess = child(707)
  const owned = new Map()
  const calls = []
  let alive = true
  let lifecycle
  const ownership = createEnterpriseBackendOwnership({
    clearOwnedProcess: owner => owned.delete(owner.key),
    forceStopTree: async (_process, identity) => {
      calls.push(`force:${identity.marker}`)
      alive = false
    },
    getLifecycle: () => lifecycle,
    gracefulStop: async (_process, identity) => calls.push(`graceful:${identity.marker}`),
    isManaged: () => true,
    listOwnedProcesses: () => [...owned.values()],
    probeProcessTree: async (_process, identity) => alive && identity.marker === 'instance-707',
    waitForExit: async () => calls.push('wait'),
    waitForProcessIdentity: async identity => identity.capturePromise
  })
  lifecycle = createEnterpriseManagedLifecycle({ hasSession: true, effects: ownership.lifecycleEffects })
  lifecycle.markRunning()
  const ticket = ownership.beginStart({ key: 'primary' })
  const sequence = runBackendStartSequence({
    managed: true,
    prepareLaunch: async () => ({ enabled: true }),
    resolveRuntime: async () => ({ command: 'python' }),
    spawnBackend: async () => {
      const identity = { capturePromise: identityCapture.promise, marker: null }
      owned.set('primary', { key: 'primary', process: ownedProcess, processIdentity: identity })
      spawned.resolve(identity)
      await spawnReturned.promise
      return { child: ownedProcess, identity }
    }
  })
  ownership.trackStart(ticket, sequence)

  const identity = await spawned.promise
  assert.equal(owned.get('primary').processIdentity, identity)
  let maintenanceSettled = false
  const maintenance = stopOwnedBackendsForMaintenance({
    lifecycle,
    managed: true,
    ownership,
    reasonCode: 'enterprise_test_maintenance'
  }).then(() => { maintenanceSettled = true })
  spawnReturned.resolve()
  await sequence
  await Promise.resolve()
  assert.equal(maintenanceSettled, false)
  assert.deepEqual(calls, [])

  identity.marker = 'instance-707'
  identityCapture.resolve(identity)
  await maintenance

  assert.equal(lifecycle.getSnapshot().state, 'blocked')
  assert.deepEqual(calls, ['graceful:instance-707', 'wait', 'force:instance-707', 'wait'])
  assert.equal(owned.size, 0)
})

test('maintenance fails closed when identity-checked ownership cannot stop a live process', async () => {
  const alive = new Set([808])
  const { lifecycle, owned, ownership } = createHarness({ alive })
  lifecycle.markRunning()
  owned.set('primary', { key: 'primary', process: child(808), processIdentity: 'instance-808' })

  await assert.rejects(
    stopOwnedBackendsForMaintenance({
      lifecycle,
      managed: true,
      ownership,
      reasonCode: 'enterprise_test_maintenance'
    }),
    error => error.code === 'enterprise_backend_stop_failed'
  )
  assert.equal(lifecycle.getSnapshot().state, 'stop_failed')
})
