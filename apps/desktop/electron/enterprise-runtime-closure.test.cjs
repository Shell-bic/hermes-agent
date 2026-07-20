const test = require('node:test')
const assert = require('node:assert/strict')

const { createEnterpriseManagedLifecycle } = require('./enterprise-managed-lifecycle.cjs')
const { createEnterpriseRuntime } = require('./enterprise-runtime.cjs')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, reject, resolve }
}

function validBootstrap(overrides = {}) {
  const generatedAt = overrides.generatedAt || '2026-07-20T08:00:00Z'
  const policyHash = overrides.policyHash || 'policy-hash'
  const policyVersion = overrides.policyVersion || 'role-policy.v1'
  return {
    capabilities: ['skills.manage'],
    generatedAt,
    lockedSurfaces: ['skills'],
    policyHash,
    policyVersion,
    user: { id: 'user-a' },
    ...overrides,
    toolPolicySnapshot: {
      capabilityFlags: [],
      generatedAt,
      mcpServers: [],
      policyHash,
      policyVersion: `tool-policy.v1+roles:${policyVersion}`,
      skills: [],
      tools: [],
      toolSets: [],
      ...(overrides.toolPolicySnapshot || {})
    }
  }
}

function cachedPolicy(userId = 'user-a') {
  return {
    capabilities: ['skills.manage'],
    enterpriseUserId: userId,
    generatedAt: '2026-07-19T08:00:00Z',
    lockedSurfaces: ['skills'],
    policyHash: 'lkg-policy-hash',
    policyVersion: 'lkg-role-policy.v1',
    toolPolicySnapshot: {
      capabilityFlags: [],
      generatedAt: '2026-07-19T08:00:00Z',
      mcpServers: [],
      policyHash: 'lkg-policy-hash',
      policyVersion: 'lkg-tool-policy.v1',
      skills: [],
      tools: [],
      toolSets: []
    },
    user: { id: userId }
  }
}

function runningLifecycle() {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: true })
  lifecycle.markRunning({ reasonCode: 'test_ready' })
  return lifecycle
}

test('401 clears the stored session permanently and cached public metadata cannot re-authenticate it', async () => {
  let session = { desktopToken: 'dsk_stale', user: { id: 'user-a' } }
  const cached = { user: { id: 'user-a' } }
  let terminalCalls = 0
  const lifecycle = runningLifecycle()
  const runtime = createEnterpriseRuntime({
    authStore: {
      clear: () => { session = null },
      readPublicSession: () => cached,
      readSession: () => session
    },
    client: {
      me: async () => {
        throw Object.assign(new Error('Unauthorized'), { status: 401 })
      }
    },
    enabled: true,
    getLifecycle: () => lifecycle,
    onTerminalAuth: async () => { terminalCalls += 1 }
  })

  const state = await runtime.refreshPublicState()

  assert.equal(state.authenticated, false)
  assert.equal(runtime.getPublicState().authenticated, false)
  assert.equal(session, null)
  assert.equal(terminalCalls, 1)
})

test('a login promise that resolves after logout cannot republish or persist its old session', async () => {
  const login = deferred()
  let session = null
  const writes = []
  const lifecycle = runningLifecycle()
  const runtime = createEnterpriseRuntime({
    authStore: {
      clear: () => { session = null },
      readSession: () => session,
      writeSession: value => {
        writes.push(value)
        session = value
      }
    },
    client: {
      login: async () => login.promise,
      logout: async () => undefined
    },
    enabled: true,
    getLifecycle: () => lifecycle
  })

  const staleLogin = runtime.login({ username: 'old-user', password: 'secret' })
  await Promise.resolve()
  await runtime.logout()
  login.resolve({ desktopToken: 'dsk_old', user: { id: 'old-user' } })

  await assert.rejects(staleLogin, error => error.code === 'enterprise_operation_superseded')
  assert.equal(session, null)
  assert.deepEqual(writes, [])
  assert.equal(runtime.getPublicState().authenticated, false)
})

test('logout during prepareLaunch invalidates every later await and prevents managed-home writes', async () => {
  const bootstrap = deferred()
  let session = { desktopToken: 'dsk_user_a', user: { id: 'user-a' } }
  let homeWrites = 0
  const lifecycle = runningLifecycle()
  const runtime = createEnterpriseRuntime({
    authStore: {
      clear: () => { session = null },
      readSession: () => session
    },
    client: {
      bootstrap: async () => bootstrap.promise,
      logout: async () => undefined,
      modelProfiles: async () => ({ modelProfiles: [] }),
      runtimeManifest: async () => ({ gatewayToken: 'must-not-write' })
    },
    enabled: true,
    getLifecycle: () => lifecycle,
    homeWriter: () => {
      homeWrites += 1
      return {}
    },
    managedHermesHome: 'managed-home'
  })

  const prepare = runtime.prepareLaunch()
  await Promise.resolve()
  await runtime.logout()
  bootstrap.resolve(validBootstrap())

  await assert.rejects(prepare, error => error.code === 'enterprise_operation_superseded')
  assert.equal(homeWrites, 0)
})

test('logout during selectModel prevents a stale manifest from replacing the active runtime state', async () => {
  const bootstrap = deferred()
  let session = { desktopToken: 'dsk_user_a', user: { id: 'user-a' } }
  let homeWrites = 0
  const lifecycle = runningLifecycle()
  const runtime = createEnterpriseRuntime({
    authStore: {
      clear: () => { session = null },
      readSession: () => session
    },
    client: {
      bootstrap: async () => bootstrap.promise,
      logout: async () => undefined,
      modelProfiles: async () => ({ modelProfiles: [{ id: 'm2', model: 'm2' }] }),
      runtimeManifest: async () => ({ gatewayToken: 'must-not-write' })
    },
    enabled: true,
    getLifecycle: () => lifecycle,
    homeWriter: () => {
      homeWrites += 1
      return {}
    },
    managedHermesHome: 'managed-home'
  })
  runtime.lastPublicState = {
    ...runtime.lastPublicState,
    allowedModels: ['m2'],
    authenticated: true,
    modelProfiles: [{ id: 'm2', model: 'm2' }],
    status: 'authenticated'
  }

  const selection = runtime.selectModel('m2')
  await Promise.resolve()
  await runtime.logout()
  bootstrap.resolve(validBootstrap())

  await assert.rejects(selection, error => error.code === 'enterprise_operation_superseded')
  assert.equal(homeWrites, 0)
  assert.equal(runtime.getPublicState().authenticated, false)
})

test('policy refresh single-flight is scoped to auth epoch and an old finally cannot clear the new user operation', async () => {
  const firstBootstrap = deferred()
  const secondBootstrap = deferred()
  let session = { desktopToken: 'dsk_user_a', user: { id: 'user-a' } }
  const writes = []
  const lifecycle = runningLifecycle()
  const runtime = createEnterpriseRuntime({
    authStore: {
      readSession: () => session,
      writeSession: value => { session = value }
    },
    client: {
      bootstrap: async token => token === 'dsk_user_a' ? firstBootstrap.promise : secondBootstrap.promise
    },
    enabled: true,
    getLifecycle: () => lifecycle,
    managedHermesHome: 'managed-home',
    policyReader: () => ({ policy: null, valid: false }),
    policyWriter: ({ bootstrap }) => {
      writes.push(bootstrap.user.id)
      return { policy: cachedPolicy(bootstrap.user.id) }
    }
  })

  const userARefresh = runtime.refreshPolicy()
  await runtime.acceptLoginSession({ desktopToken: 'dsk_user_b', user: { id: 'user-b' } })
  const userBRefresh = runtime.refreshPolicy()
  assert.notEqual(userARefresh, userBRefresh)

  firstBootstrap.resolve(validBootstrap({ user: { id: 'user-a' } }))
  await assert.rejects(userARefresh, error => error.code === 'enterprise_operation_superseded')
  assert.equal(runtime.refreshPolicy(), userBRefresh)

  secondBootstrap.resolve(validBootstrap({ user: { id: 'user-b' } }))
  const state = await userBRefresh
  assert.equal(state.user.id, 'user-b')
  assert.deepEqual(writes, ['user-b'])
})

test('policy LKG is used only for same-user transport, timeout, 408, 429, and 5xx failures', async t => {
  const cases = [
    { label: 'network', error: Object.assign(new Error('offline'), { code: 'ECONNRESET' }), stale: true },
    { label: 'timeout', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), stale: true },
    { label: '408', error: Object.assign(new Error('408'), { status: 408 }), stale: true },
    { label: '429', error: Object.assign(new Error('429'), { status: 429 }), stale: true },
    { label: '500', error: Object.assign(new Error('500'), { status: 500 }), stale: true },
    { label: '503', error: Object.assign(new Error('503'), { status: 503 }), stale: true },
    { label: '400', error: Object.assign(new Error('400'), { status: 400 }), stale: false, terminal: 'blocked' },
    { label: '401', error: Object.assign(new Error('401'), { status: 401 }), stale: false, terminal: 'unauthenticated' },
    { label: '403', error: Object.assign(new Error('403'), { status: 403 }), stale: false, terminal: 'unauthenticated' },
    { label: '426', error: Object.assign(new Error('426'), { status: 426 }), stale: false, terminal: 'blocked' },
    {
      label: 'invalid-200',
      error: Object.assign(new Error('invalid payload'), { code: 'enterprise_policy_payload_invalid' }),
      stale: false,
      terminal: 'blocked'
    },
    {
      label: 'user-mismatch',
      error: Object.assign(new Error('wrong user'), { code: 'enterprise_policy_user_mismatch' }),
      stale: false,
      terminal: 'blocked'
    },
    { label: 'ordinary-error', error: new Error('programming error'), stale: false },
    { label: 'non-network-code', error: Object.assign(new Error('bad local state'), { code: 'ELOCALBUG' }), stale: false }
  ]

  for (const entry of cases) {
    await t.test(entry.label, async () => {
      let session = { desktopToken: 'dsk_user_a', user: { id: 'user-a' } }
      const readerCalls = []
      const terminalStates = []
      const runtime = createEnterpriseRuntime({
        authStore: {
          clear: () => { session = null },
          readSession: () => session
        },
        client: { bootstrap: async () => { throw entry.error } },
        enabled: true,
        managedHermesHome: 'managed-home',
        onTerminalAuth: async event => terminalStates.push(event.terminalState),
        policyReader: options => {
          readerCalls.push(options)
          return options.expectedUserId === 'user-a'
            ? { policy: cachedPolicy('user-a'), valid: true }
            : { policy: null, reason: 'user_mismatch', valid: false }
        }
      })

      const state = await runtime.refreshPolicy()

      assert.equal(state.policyRefreshStatus, entry.stale ? 'stale' : entry.terminal ? 'idle' : 'failed')
      assert.equal(state.policyStale, entry.stale)
      if (entry.terminal) assert.equal(state.authenticated, false)
      assert.equal(readerCalls.length, entry.stale ? 1 : 0)
      if (readerCalls.length) assert.equal(readerCalls[0].expectedUserId, 'user-a')
      assert.deepEqual(terminalStates, entry.terminal ? [entry.terminal] : [])
    })
  }
})

test('policy refresh never adopts an LKG bound to another enterprise user', async () => {
  const calls = []
  const runtime = createEnterpriseRuntime({
    authStore: { readSession: () => ({ desktopToken: 'dsk_user_b', user: { id: 'user-b' } }) },
    client: {
      bootstrap: async () => {
        throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
      }
    },
    enabled: true,
    managedHermesHome: 'managed-home',
    policyReader: options => {
      calls.push(options)
      return options.expectedUserId === 'user-a'
        ? { policy: cachedPolicy('user-a'), valid: true }
        : { policy: null, reason: 'user_mismatch', valid: false }
    }
  })

  const state = await runtime.refreshPolicy()

  assert.equal(state.policyRefreshStatus, 'failed')
  assert.equal(state.policyStale, false)
  assert.equal(calls[0].expectedUserId, 'user-b')
})
