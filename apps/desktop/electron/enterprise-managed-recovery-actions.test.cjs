const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createEnterpriseManagedRecoveryActions,
  RECOVERY_ACTION_ERROR_CODES
} = require('./enterprise-managed-recovery-actions.cjs')

function harness(initialState) {
  const calls = []
  let state = initialState
  let releaseStart
  const startGate = new Promise(resolve => { releaseStart = resolve })
  const lifecycle = {
    beginRecovery({ reasonCode }) {
      calls.push(`begin:${reasonCode}`)
      state = 'recovering'
    },
    getSnapshot: () => ({ authEpoch: 0, lifecycleEpoch: 3, reasonCode: 'test', state }),
    async retryStop({ reasonCode, terminalState }) {
      calls.push(`retry-stop:${reasonCode}:${terminalState}`)
      state = terminalState
      return this.getSnapshot()
    },
    async revoke({ reasonCode, terminalState }) {
      calls.push(`revoke:${reasonCode}:${terminalState}`)
      state = terminalState
      return this.getSnapshot()
    }
  }
  const actions = createEnterpriseManagedRecoveryActions({
    beforeStart: async () => calls.push('before-start'),
    getLifecycle: () => lifecycle,
    hasSession: () => true,
    startBackend: async () => {
      calls.push('start')
      await startGate
      state = 'running'
    }
  })
  return { actions, calls, lifecycle, releaseStart, setState: next => { state = next } }
}

test('explicit refresh-policy recovery is single-flight and starts exactly once', async () => {
  const { actions, calls, releaseStart } = harness('blocked')
  const first = actions.refreshPolicy()
  const second = actions.refreshPolicy()

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [
    'begin:enterprise_user_requested_policy_refresh',
    'before-start',
    'start'
  ])
  releaseStart()
  const [left, right] = await Promise.all([first, second])
  assert.equal(left.state, 'running')
  assert.equal(right.state, 'running')
  assert.equal(calls.filter(call => call === 'start').length, 1)
})

test('retry-stop verifies cleanup before beginning one controlled recovery', async () => {
  const { actions, calls, releaseStart } = harness('stop_failed')
  const first = actions.retryStop()
  const second = actions.retryStop()

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [
    'retry-stop:enterprise_user_requested_stop_retry:blocked',
    'begin:enterprise_user_requested_stop_recovery',
    'before-start',
    'start'
  ])
  releaseStart()
  await Promise.all([first, second])
  assert.equal(calls.filter(call => call === 'start').length, 1)
})

test('failed retry-stop remains terminal and never begins or starts in background', async () => {
  const { actions, calls, lifecycle } = harness('stop_failed')
  lifecycle.retryStop = async () => {
    calls.push('retry-stop-failed')
    return lifecycle.getSnapshot()
  }

  await assert.rejects(
    () => actions.retryStop(),
    error => error.code === RECOVERY_ACTION_ERROR_CODES.STOP_FAILED
  )
  assert.deepEqual(calls, ['retry-stop-failed'])
  assert.equal(lifecycle.getSnapshot().state, 'stop_failed')
})

test('cross-action race is rejected and cannot schedule a second start', async () => {
  const { actions, calls, releaseStart } = harness('blocked')
  const recovery = actions.refreshPolicy()
  await assert.rejects(
    () => actions.retryStop(),
    error => error.code === RECOVERY_ACTION_ERROR_CODES.BUSY
  )
  await new Promise(resolve => setImmediate(resolve))
  releaseStart()
  await recovery
  assert.equal(calls.filter(call => call === 'start').length, 1)
})

test('beforeStart failure revokes to blocked and never starts', async () => {
  const { calls, lifecycle } = harness('blocked')
  const actions = createEnterpriseManagedRecoveryActions({
    beforeStart: async () => {
      calls.push('before-start-failed')
      throw new Error('before failed')
    },
    getLifecycle: () => lifecycle,
    hasSession: () => true,
    startBackend: async () => calls.push('unexpected-start')
  })

  await assert.rejects(() => actions.refreshPolicy(), /before failed/)
  assert.deepEqual(calls, [
    'begin:enterprise_user_requested_policy_refresh',
    'before-start-failed',
    'revoke:enterprise_user_recovery_failed:blocked'
  ])
  assert.equal(lifecycle.getSnapshot().state, 'blocked')
})

test('backend start failure performs cleanup and returns to blocked', async () => {
  const { calls, lifecycle } = harness('blocked')
  const actions = createEnterpriseManagedRecoveryActions({
    beforeStart: async () => calls.push('before-start'),
    getLifecycle: () => lifecycle,
    hasSession: () => true,
    startBackend: async () => {
      calls.push('start-failed')
      throw new Error('start failed')
    }
  })

  await assert.rejects(() => actions.refreshPolicy(), /start failed/)
  assert.deepEqual(calls, [
    'begin:enterprise_user_requested_policy_refresh',
    'before-start',
    'start-failed',
    'revoke:enterprise_user_recovery_failed:blocked'
  ])
  assert.equal(lifecycle.getSnapshot().state, 'blocked')
})

test('cleanup failure after a failed start remains stop_failed and never schedules another start', async () => {
  const { calls, lifecycle, setState } = harness('blocked')
  lifecycle.revoke = async ({ reasonCode, terminalState }) => {
    calls.push(`revoke-failed:${reasonCode}:${terminalState}`)
    setState('stop_failed')
    return lifecycle.getSnapshot()
  }
  const actions = createEnterpriseManagedRecoveryActions({
    getLifecycle: () => lifecycle,
    hasSession: () => true,
    startBackend: async () => {
      calls.push('start-failed')
      throw new Error('start failed')
    }
  })

  await assert.rejects(
    () => actions.refreshPolicy(),
    error => error.code === RECOVERY_ACTION_ERROR_CODES.STOP_FAILED
  )
  await assert.rejects(
    () => actions.refreshPolicy(),
    error => error.code === RECOVERY_ACTION_ERROR_CODES.INVALID_STATE
  )
  assert.deepEqual(calls, [
    'begin:enterprise_user_requested_policy_refresh',
    'start-failed',
    'revoke-failed:enterprise_user_recovery_failed:blocked'
  ])
  assert.equal(lifecycle.getSnapshot().state, 'stop_failed')
})
