const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createEnterpriseManagedLifecycle,
  isLifecycleTransitionAllowed,
  LIFECYCLE_ERROR_CODES
} = require('./enterprise-managed-lifecycle.cjs')

function createHarness(overrides = {}) {
  const calls = []
  const events = []
  const effects = {
    cancelPendingStarts: async () => calls.push('cancel'),
    closeWindowConnections: async () => calls.push('close'),
    stopOwnedProcesses: async () => calls.push('stop'),
    verifyResourcesGone: async () => {
      calls.push('verify')
      return true
    },
    ...overrides
  }

  const lifecycle = createEnterpriseManagedLifecycle({
    hasSession: true,
    effects,
    publish: event => events.push(event)
  })

  return { calls, effects, events, lifecycle }
}

test('initial state and transition table cover the complete legal recovery lifecycle', () => {
  assert.equal(createEnterpriseManagedLifecycle({ hasSession: false }).getSnapshot().state, 'unauthenticated')
  assert.equal(createHarness().lifecycle.getSnapshot().state, 'recovering')

  const expected = {
    unauthenticated: ['recovering'],
    recovering: ['running', 'revoking'],
    running: ['revoking'],
    revoking: ['blocked', 'unauthenticated', 'stop_failed'],
    blocked: ['recovering'],
    stop_failed: []
  }
  for (const fromState of Object.keys(expected)) {
    for (const toState of Object.keys(expected)) {
      assert.equal(
        isLifecycleTransitionAllowed(fromState, toState),
        expected[fromState].includes(toState),
        `${fromState} -> ${toState}`
      )
    }
  }
})

test('illegal transitions fail closed, including terminal-to-running and stop_failed recovery shortcuts', async () => {
  const { lifecycle } = createHarness()
  lifecycle.markRunning()

  assert.throws(() => lifecycle.beginRecovery(), error => {
    assert.equal(error.code, LIFECYCLE_ERROR_CODES.INVALID_TRANSITION)
    return true
  })

  await lifecycle.revoke({ terminalState: 'blocked' })
  assert.throws(() => lifecycle.markRunning(), error => {
    assert.equal(error.code, LIFECYCLE_ERROR_CODES.INVALID_TRANSITION)
    return true
  })

  const failed = createHarness({ verifyResourcesGone: async () => false }).lifecycle
  failed.markRunning()
  await failed.revoke({ terminalState: 'blocked' })
  assert.equal(failed.getSnapshot().state, 'stop_failed')
  assert.throws(() => failed.beginRecovery(), error => {
    assert.equal(error.code, LIFECYCLE_ERROR_CODES.INVALID_TRANSITION)
    return true
  })
  assert.throws(() => failed.markRunning(), error => {
    assert.equal(error.code, LIFECYCLE_ERROR_CODES.INVALID_TRANSITION)
    return true
  })
})

test('revoke invalidates the old lease at entry and all runtime IPC and mutation effects are gated', async () => {
  let releaseCancel
  const cancelStarted = new Promise(resolve => {
    releaseCancel = resolve
  })
  let continueCancel
  const cancelBlocked = new Promise(resolve => {
    continueCancel = resolve
  })
  const { lifecycle } = createHarness({
    cancelPendingStarts: async () => {
      releaseCancel()
      await cancelBlocked
    }
  })
  lifecycle.markRunning()
  const lease = lifecycle.acquireLease()

  const revoke = lifecycle.revoke({ terminalState: 'blocked', reasonCode: 'policy_denied' })
  await cancelStarted

  assert.equal(lifecycle.getSnapshot().state, 'revoking')
  assert.equal(lifecycle.getSnapshot().lifecycleEpoch, lease.lifecycleEpoch + 1)
  assert.equal(lifecycle.isLeaseCurrent(lease), false)
  for (const effect of ['ensureBackend', 'apiProxy', 'websocketUrl', 'skillInstall']) {
    assert.throws(() => lifecycle.guardEffect(effect, lease), error => {
      assert.equal(error.code, LIFECYCLE_ERROR_CODES.EFFECT_DENIED)
      return true
    })
  }
  assert.throws(() => lifecycle.guardIpc('skills:install', lease, { mutation: true }), error => {
    assert.equal(error.code, LIFECYCLE_ERROR_CODES.IPC_DENIED)
    return true
  })

  continueCancel()
  await revoke
})

test('concurrent revoke is single-flight and cleanup effects run in strict order', async () => {
  const { calls, lifecycle } = createHarness()
  lifecycle.markRunning()

  const first = lifecycle.revoke({ terminalState: 'blocked', reasonCode: 'contract_invalid' })
  const second = lifecycle.revoke({ terminalState: 'blocked', reasonCode: 'contract_invalid' })

  assert.equal(first, second)
  await Promise.all([first, second])
  assert.deepEqual(calls, ['cancel', 'close', 'stop', 'verify'])
  assert.equal(lifecycle.getSnapshot().state, 'blocked')
})

test('cleanup failure enters stop_failed and retryStop requires verified absence before recovery', async () => {
  for (const failedEffect of [
    'cancelPendingStarts',
    'closeWindowConnections',
    'stopOwnedProcesses',
    'verifyResourcesGone'
  ]) {
    const overrides = {
      [failedEffect]: async () => {
        throw new Error(`secret ${failedEffect} failure`)
      }
    }
    const failedLifecycle = createHarness(overrides).lifecycle
    failedLifecycle.markRunning()
    await failedLifecycle.revoke({ terminalState: 'blocked' })
    assert.equal(failedLifecycle.getSnapshot().state, 'stop_failed', failedEffect)
    assert.throws(() => failedLifecycle.guardEffect('spawn', failedLifecycle.acquireLease()), error => {
      assert.equal(error.code, LIFECYCLE_ERROR_CODES.EFFECT_DENIED)
      return true
    })
    assert.throws(() => failedLifecycle.guardIpc('skills:install', failedLifecycle.acquireLease()))
  }

  let failStop = true
  let verifyGone = false
  const { calls, lifecycle } = createHarness({
    stopOwnedProcesses: async () => {
      calls.push('stop')
      if (failStop) throw new Error('secret process command failed')
    },
    verifyResourcesGone: async () => {
      calls.push('verify')
      return verifyGone
    }
  })
  lifecycle.markRunning()
  await lifecycle.revoke({ terminalState: 'blocked', reasonCode: 'policy_denied' })

  assert.equal(lifecycle.getSnapshot().state, 'stop_failed')

  failStop = false
  await lifecycle.retryStop({ terminalState: 'blocked' })
  assert.equal(lifecycle.getSnapshot().state, 'stop_failed')

  verifyGone = true
  await lifecycle.retryStop({ terminalState: 'blocked' })
  assert.equal(lifecycle.getSnapshot().state, 'blocked')
  lifecycle.beginRecovery()
  lifecycle.guardEffect('spawn', lifecycle.acquireLease(), { recovery: true })
})

test('published state is sanitized, epoch-monotonic, and never exposes Error or secret material', async () => {
  const { events, lifecycle } = createHarness({
    cancelPendingStarts: async () => {
      throw Object.assign(new Error('Bearer enterprise-super-secret'), {
        token: 'enterprise-super-secret'
      })
    }
  })
  lifecycle.markRunning({ reasonCode: 'ready' })
  lifecycle.advanceAuthEpoch()
  await lifecycle.revoke({
    terminalState: 'unauthenticated',
    reasonCode: 'enterprise_auth_required'
  })

  assert.ok(events.length >= 4)
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].lifecycleEpoch >= events[index - 1].lifecycleEpoch)
    assert.ok(events[index].authEpoch >= events[index - 1].authEpoch)
  }
  for (const event of events) {
    assert.equal(Object.values(event).some(value => value instanceof Error), false)
    assert.equal(JSON.stringify(event).includes('enterprise-super-secret'), false)
    assert.deepEqual(Object.keys(event).sort(), [
      'authEpoch',
      'lifecycleEpoch',
      'reasonCode',
      'state'
    ])
  }
  assert.equal(events.at(-1).state, 'stop_failed')
})
