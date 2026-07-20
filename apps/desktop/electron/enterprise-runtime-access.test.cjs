const test = require('node:test')
const assert = require('node:assert/strict')

const { createEnterpriseManagedLifecycle } = require('./enterprise-managed-lifecycle.cjs')
const { createEnterpriseRuntimeAccess } = require('./enterprise-runtime-access.cjs')

function deferred() {
  let resolve
  const promise = new Promise(next => {
    resolve = next
  })
  return { promise, resolve }
}

function harness() {
  let releaseCleanup
  const cleanup = new Promise(resolve => {
    releaseCleanup = resolve
  })
  const lifecycle = createEnterpriseManagedLifecycle({
    hasSession: true,
    effects: { cancelPendingStarts: () => cleanup }
  })
  lifecycle.markRunning()
  const access = createEnterpriseRuntimeAccess({
    getLifecycle: () => lifecycle,
    isManaged: () => true
  })
  return { access, lifecycle, releaseCleanup }
}

test('cached backend resolution is rejected when revocation starts before its await completes', async () => {
  const { access, lifecycle, releaseCleanup } = harness()
  const cached = deferred()
  const operation = access.run('ensureBackend', () => cached.promise, { allowRecovery: true })

  const revoke = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  cached.resolve({ baseUrl: 'http://127.0.0.1:9999' })

  await assert.rejects(operation, error => error.code === 'enterprise_lifecycle_effect_denied')
  releaseCleanup()
  await revoke
})

test('backend, websocket ticket, and API mutation access all fail closed after revoke entry', async () => {
  const { access, lifecycle, releaseCleanup } = harness()
  const revoke = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })

  for (const [effect, options] of [
    ['ensureBackend', { allowRecovery: true }],
    ['gatewayWsUrl', { allowRecovery: true }],
    ['hermes:api', { ipc: true }]
  ]) {
    assert.throws(
      () => access.acquire(effect, options),
      error => {
        assert.ok(['enterprise_lifecycle_effect_denied', 'enterprise_lifecycle_ipc_denied'].includes(error.code))
        return true
      }
    )
  }

  releaseCleanup()
  await revoke
})

test('explicit recovery permits backend and websocket preparation but not ordinary runtime IPC', () => {
  let lifecycle
  const access = createEnterpriseRuntimeAccess({
    getLifecycle: () => lifecycle,
    isManaged: () => true
  })
  lifecycle = createEnterpriseManagedLifecycle({ hasSession: true })

  access.acquire('ensureBackend', { allowRecovery: true })
  access.acquire('gatewayWsUrl', { allowRecovery: true })
  assert.throws(
    () => access.acquire('hermes:api', { ipc: true }),
    error => error.code === 'enterprise_lifecycle_ipc_denied'
  )
})

test('begin aborts an active request synchronously at revoke entry and carries a stable typed reason', async () => {
  const { access, lifecycle, releaseCleanup } = harness()
  const active = access.begin('hermes:api', { ipc: true })
  let observed = null
  active.signal.addEventListener('abort', () => {
    observed = active.signal.reason
  })

  const revoke = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  assert.equal(active.signal.aborted, true)
  assert.equal(observed?.code, 'enterprise_operation_superseded')
  assert.equal(active.lease.lifecycleEpoch, 0)
  active.finish()
  releaseCleanup()
  await revoke
})

test('managed begin fails closed when lifecycle subscription support is missing', () => {
  const lifecycle = {
    acquireLease: () => ({ authEpoch: 0, lifecycleEpoch: 0 }),
    guardIpc: () => true,
    isLeaseCurrent: () => true
  }
  const access = createEnterpriseRuntimeAccess({ getLifecycle: () => lifecycle, isManaged: () => true })
  assert.throws(() => access.begin('hermes:api', { ipc: true }), /must support subscriptions and lease checks/)
})

test('a throwing lifecycle subscriber cannot prevent active operation abort', async () => {
  const { access, lifecycle, releaseCleanup } = harness()
  lifecycle.subscribe(() => {
    throw new Error('observer failed')
  })
  const active = access.begin('hermes:api', { ipc: true })
  const revoke = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  assert.equal(active.signal.aborted, true)
  assert.equal(active.signal.reason?.code, 'enterprise_operation_superseded')
  active.finish()
  releaseCleanup()
  await revoke
})

test('unmanaged begin stays compatible without lifecycle wiring', async () => {
  const access = createEnterpriseRuntimeAccess({ isManaged: () => false })
  const value = await access.run(
    'hermes:api',
    async (_lease, signal) => {
      assert.equal(signal.aborted, false)
      return 42
    },
    { ipc: true }
  )
  assert.equal(value, 42)
})

test('finish removes the lifecycle listener so a completed operation is not aborted later', async () => {
  const { access, lifecycle, releaseCleanup } = harness()
  const active = access.begin('hermes:api', { ipc: true })
  active.finish()
  const revoke = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  assert.equal(active.signal.aborted, false)
  releaseCleanup()
  await revoke
})
