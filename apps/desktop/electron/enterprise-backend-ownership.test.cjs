const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { createEnterpriseManagedLifecycle } = require('./enterprise-managed-lifecycle.cjs')
const { createEnterpriseBackendOwnership } = require('./enterprise-backend-ownership.cjs')

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
