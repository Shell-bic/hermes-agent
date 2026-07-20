const test = require('node:test')
const assert = require('node:assert/strict')

const { createEnterpriseApiIpcHandler } = require('./enterprise-api-ipc.cjs')
const { createEnterpriseManagedLifecycle } = require('./enterprise-managed-lifecycle.cjs')
const { createEnterpriseManagedProfileGuard } = require('./enterprise-managed-profile.cjs')
const { unwrapEnterprisePublicResult } = require('./enterprise-public-error.cjs')
const { createEnterpriseRuntimeAccess } = require('./enterprise-runtime-access.cjs')

function harness({ handleRawRequest = async request => ({ request }), trusted = true } = {}) {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: true })
  lifecycle.markRunning()
  const guard = createEnterpriseManagedProfileGuard({
    enabled: true,
    identity: { hermesHome: 'C:\\managed\\hermes', key: 'enterprise-managed', userId: 'u-1' }
  })
  const runtimeAccess = createEnterpriseRuntimeAccess({
    getLifecycle: () => lifecycle,
    isManaged: () => true
  })
  const handler = createEnterpriseApiIpcHandler({
    assertTrusted: () => {
      if (!trusted) throw new Error('untrusted')
    },
    getLifecycle: () => lifecycle,
    guard,
    handleRawRequest,
    runtimeAccess
  })
  return { guard, handler, lifecycle }
}

test('API handler projects raw profile DTO before adding one public envelope', async () => {
  const { handler } = harness({
    handleRawRequest: async request => {
      if (request.path === '/api/profiles') {
        return { profiles: [{ name: 'default', path: 'local' }, { name: 'finance', path: 'foreign' }] }
      }
      return { ok: true }
    }
  })

  const wire = await handler.run({}, { method: 'GET', path: '/api/profiles' })
  assert.equal(wire.envelope, 'enterprise-public-result.v1')
  assert.equal(wire.value?.envelope, undefined)
  assert.deepEqual(unwrapEnterprisePublicResult(wire), {
    profiles: [{ is_default: true, name: 'default', path: 'C:\\managed\\hermes' }]
  })
})

test('API handler returns synthetic active profile and projects sessions', async () => {
  let rawCalls = 0
  const { handler } = harness({
    handleRawRequest: async request => {
      rawCalls += 1
      assert.equal(request.path, '/api/profiles/sessions?profile=default')
      return {
        sessions: [
          { id: 'kept', profile: 'default' },
          { id: 'hidden', profile: 'finance' }
        ],
        total: 2
      }
    }
  })

  const active = unwrapEnterprisePublicResult(await handler.run({}, { path: '/api/profiles/active' }))
  assert.deepEqual(active, { active: 'default', current: 'default' })
  assert.equal(rawCalls, 0)

  const sessions = unwrapEnterprisePublicResult(
    await handler.run({}, { path: '/api/profiles/sessions?profile=enterprise-managed' })
  )
  assert.deepEqual(sessions.sessions, [{ id: 'kept', is_default_profile: true, profile: 'default' }])
})

test('API handler passes unrelated raw DTO through and rejects named profile safely', async () => {
  const { handler } = harness({ handleRawRequest: async () => ({ answer: 42 }) })
  assert.deepEqual(unwrapEnterprisePublicResult(await handler.run({}, { path: '/api/skills' })), { answer: 42 })

  const rejected = await handler.run({}, { path: '/api/skills?profile=finance' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.errorCode, 'enterprise_profile_not_managed')
  assert.throws(() => unwrapEnterprisePublicResult(rejected), error => {
    assert.equal(error.code, 'enterprise_profile_not_managed')
    assert.doesNotMatch(error.message, /finance/)
    return true
  })
})

test('untrusted API sender never acquires a lease, touches network, or changes lifecycle', async () => {
  let rawCalls = 0
  const { handler, lifecycle } = harness({
    trusted: false,
    handleRawRequest: async () => {
      rawCalls += 1
    }
  })
  const before = lifecycle.getSnapshot()
  const result = await handler.run({}, { path: '/api/sessions' })

  assert.equal(rawCalls, 0)
  assert.deepEqual(lifecycle.getSnapshot(), before)
  assert.equal(result.error.errorCode, 'enterprise_untrusted_renderer')
  assert.equal(result.error.recoveryKind, 'none')
})

for (const [name, getLifecycle] of [
  ['throws', () => { throw new Error('not initialized') }],
  ['returns null', () => null]
]) {
  test(`untrusted API sender receives safe v1 failure when lifecycle ${name}`, async () => {
    const handler = createEnterpriseApiIpcHandler({
      assertTrusted: () => { throw new Error('untrusted') },
      getLifecycle,
      guard: createEnterpriseManagedProfileGuard({ enabled: true }),
      handleRawRequest: async () => assert.fail('network must not run'),
      runtimeAccess: { begin: () => assert.fail('lease must not be acquired') }
    })
    const result = await handler.run({}, { path: '/api/sessions' })
    assert.equal(result.envelope, 'enterprise-public-result.v1')
    assert.equal(result.error.errorCode, 'enterprise_untrusted_renderer')
    assert.equal(result.error.lifecycleEpoch, 0)
    assert.equal(result.error.recoveryKind, 'none')
  })
}

for (const [statusCode, expectedState] of [[401, 'unauthenticated'], [403, 'blocked'], [426, 'blocked']]) {
  test(`API statusCode ${statusCode} performs terminal transition before publishing error`, async () => {
    const { handler, lifecycle } = harness({
      handleRawRequest: async () => {
        throw Object.assign(new Error('private upstream error'), { statusCode })
      }
    })
    const result = await handler.run({}, { path: '/api/sessions' })
    assert.equal(lifecycle.getSnapshot().state, expectedState)
    assert.equal(result.error.httpStatus, statusCode)
    assert.equal(result.error.lifecycleEpoch, lifecycle.getSnapshot().lifecycleEpoch)
    assert.doesNotMatch(result.error.message, /private upstream error/)
  })
}

for (const initialState of ['blocked', 'unauthenticated']) {
  test(`${initialState} lifecycle returns a public v1 failure when lease acquisition is denied`, async () => {
    const lifecycle = createEnterpriseManagedLifecycle({ hasSession: initialState === 'blocked' })
    if (initialState === 'blocked') {
      lifecycle.markRunning()
      await lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
    }
    const guard = createEnterpriseManagedProfileGuard({ enabled: true })
    const runtimeAccess = createEnterpriseRuntimeAccess({ getLifecycle: () => lifecycle, isManaged: () => true })
    const handler = createEnterpriseApiIpcHandler({
      getLifecycle: () => lifecycle,
      guard,
      handleRawRequest: async () => assert.fail('network must not run'),
      runtimeAccess
    })
    const result = await handler.run({}, { path: '/api/sessions' })
    assert.equal(result.envelope, 'enterprise-public-result.v1')
    assert.equal(result.ok, false)
    assert.equal(result.error.errorCode, 'enterprise_lifecycle_ipc_denied')
    assert.equal(result.error.lifecycleEpoch, lifecycle.getSnapshot().lifecycleEpoch)
  })
}

for (const [statusCode, expectedRecoveryKind] of [[401, 'none'], [500, 'retry']]) {
  test(`unmanaged API status ${statusCode} does not use or transition enterprise lifecycle`, async () => {
    const lifecycle = createEnterpriseManagedLifecycle({ hasSession: false })
    const before = lifecycle.getSnapshot()
    const guard = createEnterpriseManagedProfileGuard({ enabled: false })
    const runtimeAccess = createEnterpriseRuntimeAccess({ getLifecycle: () => lifecycle, isManaged: () => false })
    const handler = createEnterpriseApiIpcHandler({
      getLifecycle: () => lifecycle,
      guard,
      handleRawRequest: async () => {
        throw Object.assign(new Error('local private response'), { statusCode })
      },
      isManaged: () => false,
      runtimeAccess
    })
    const result = await handler.run({}, { path: '/api/sessions' })
    assert.deepEqual(lifecycle.getSnapshot(), before)
    assert.equal(result.error.recoveryKind, expectedRecoveryKind)
    if (statusCode === 401) assert.equal(result.error.errorCode, 'local_backend_request_failed')
  })
}

test('managed mode callback failure cannot escape the API IPC envelope', async () => {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: false })
  const handler = createEnterpriseApiIpcHandler({
    getLifecycle: () => lifecycle,
    guard: createEnterpriseManagedProfileGuard({ enabled: false }),
    handleRawRequest: async () => assert.fail('network must not run'),
    isManaged: () => { throw new Error('mode unavailable') },
    runtimeAccess: { begin: () => assert.fail('lease must not run') }
  })
  const result = await handler.run({}, { path: '/api/sessions' })
  assert.equal(result.envelope, 'enterprise-public-result.v1')
  assert.equal(result.ok, false)
  assert.equal(result.error.recoveryKind, 'none')
})
