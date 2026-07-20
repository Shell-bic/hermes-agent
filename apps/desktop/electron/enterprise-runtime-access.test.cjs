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
    assert.throws(() => access.acquire(effect, options), error => {
      assert.ok(['enterprise_lifecycle_effect_denied', 'enterprise_lifecycle_ipc_denied'].includes(error.code))
      return true
    })
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
