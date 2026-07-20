const test = require('node:test')
const assert = require('node:assert/strict')
const { createEnterpriseManagedLifecycle } = require('./enterprise-managed-lifecycle.cjs')
const { resolveBackendForOperation } = require('./enterprise-backend-request.cjs')
const { createEnterpriseRuntimeAccess } = require('./enterprise-runtime-access.cjs')

test('revoke during ensureBackend rejects before the caller can start its network request', async () => {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: true })
  lifecycle.markRunning()
  const access = createEnterpriseRuntimeAccess({ getLifecycle: () => lifecycle, isManaged: () => true })
  const active = access.begin('hermes:api', { ipc: true })
  let releaseBackend
  let receivedSignal = null
  let networkCalls = 0
  const backend = new Promise(resolve => { releaseBackend = resolve })
  const operation = resolveBackendForOperation({
    active,
    ensureBackend: async (_profile, options) => {
      receivedSignal = options.signal
      return backend
    },
    profile: 'default'
  }).then(() => { networkCalls += 1 })

  const revoke = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  releaseBackend({ baseUrl: 'http://127.0.0.1:9000', token: 'secret' })
  await assert.rejects(operation, error => error.code === 'enterprise_lifecycle_ipc_denied')
  assert.equal(receivedSignal.aborted, true)
  assert.equal(networkCalls, 0)
  active.finish()
  await revoke
})
