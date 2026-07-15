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

function createHarness({ alive = new Set(), stopCalls = [] } = {}) {
  const owned = new Map()
  let lifecycle
  const ownership = createEnterpriseBackendOwnership({
    clearOwnedProcess: owner => owned.delete(owner.key),
    forceStopTree: async process => stopCalls.push(`force:${process.pid}`),
    getLifecycle: () => lifecycle,
    gracefulStop: async process => stopCalls.push(`graceful:${process.pid}`),
    isManaged: () => true,
    listOwnedProcesses: () => [...owned.values()],
    probeProcessTree: async process => alive.has(process.pid),
    waitForExit: async process => stopCalls.push(`wait:${process.pid}`)
  })
  lifecycle = createEnterpriseManagedLifecycle({
    hasSession: true,
    effects: ownership.lifecycleEffects
  })
  return { lifecycle, owned, ownership }
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
