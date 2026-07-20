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

test('the newest public-state refresh wins when an older same-session request resolves last', async () => {
  const first = deferred()
  const second = deferred()
  let call = 0
  const lifecycle = runningLifecycle()
  const runtime = createEnterpriseRuntime({
    authStore: { readSession: () => ({ desktopToken: 'dsk_user_a', user: { id: 'user-a' } }) },
    client: { me: async () => (++call === 1 ? first.promise : second.promise) },
    enabled: true,
    getLifecycle: () => lifecycle
  })

  const older = runtime.refreshPublicState()
  const newer = runtime.refreshPublicState()
  second.resolve({ user: { id: 'user-a', displayName: 'New state' } })
  await newer
  first.resolve({ user: { id: 'user-a', displayName: 'Old state' } })

  await assert.rejects(older, error => error.code === 'enterprise_operation_superseded')
  assert.equal(runtime.getPublicState().user.displayName, 'New state')
})

test('the newest managed launch wins and an older same-session prepare cannot write or publish', async () => {
  const first = deferred()
  const second = deferred()
  let call = 0
  const writes = []
  const lifecycle = runningLifecycle()
  const runtime = createEnterpriseRuntime({
    authStore: { readSession: () => ({ desktopToken: 'dsk_user_a', user: { id: 'user-a' } }) },
    client: {
      bootstrap: async () => (++call === 1 ? first.promise : second.promise),
      modelProfiles: async () => ({ modelProfiles: [] }),
      runtimeManifest: async () => ({ gatewayToken: 'gateway-token' })
    },
    enabled: true,
    getLifecycle: () => lifecycle,
    homeWriter: ({ bootstrap }) => {
      writes.push(bootstrap.policyHash)
      return {
        env: {},
        hermesHome: 'managed-home',
        publicState: { authenticated: true, policyHash: bootstrap.policyHash, user: bootstrap.user }
      }
    },
    managedHermesHome: 'managed-home'
  })

  const older = runtime.prepareLaunch()
  const newer = runtime.prepareLaunch()
  second.resolve(validBootstrap({ policyHash: 'new-policy' }))
  await newer
  first.resolve(validBootstrap({ policyHash: 'old-policy' }))

  await assert.rejects(older, error => error.code === 'enterprise_operation_superseded')
  assert.deepEqual(writes, ['new-policy'])
  assert.equal(runtime.getPublicState().policyHash, 'new-policy')
})

test('a newer public-state refresh prevents an older managed launch from writing or publishing', async () => {
  const oldBootstrap = deferred()
  const writes = []
  const lifecycle = runningLifecycle()
  const runtime = createEnterpriseRuntime({
    authStore: { readSession: () => ({ desktopToken: 'dsk_user_a', user: { id: 'user-a' } }) },
    client: {
      bootstrap: async () => oldBootstrap.promise,
      me: async () => ({ user: { id: 'user-a', displayName: 'Newest account' } }),
      modelProfiles: async () => ({ modelProfiles: [] }),
      runtimeManifest: async () => ({ gatewayToken: 'gateway-token' })
    },
    enabled: true,
    getLifecycle: () => lifecycle,
    homeWriter: value => {
      writes.push(value)
      return value
    },
    managedHermesHome: 'managed-home'
  })

  const olderLaunch = runtime.prepareLaunch()
  await runtime.refreshPublicState()
  oldBootstrap.resolve(validBootstrap({ policyHash: 'old-policy' }))

  await assert.rejects(olderLaunch, error => error.code === 'enterprise_operation_superseded')
  assert.deepEqual(writes, [])
  assert.equal(runtime.getPublicState().user.displayName, 'Newest account')
})

test('a newer managed launch prevents an older account response from overwriting public state', async () => {
  const oldMe = deferred()
  const lifecycle = runningLifecycle()
  const runtime = createEnterpriseRuntime({
    authStore: { readSession: () => ({ desktopToken: 'dsk_user_a', user: { id: 'user-a' } }) },
    client: {
      bootstrap: async () => validBootstrap({ policyHash: 'new-policy' }),
      me: async () => oldMe.promise,
      modelProfiles: async () => ({ modelProfiles: [] }),
      runtimeManifest: async () => ({ gatewayToken: 'gateway-token' })
    },
    enabled: true,
    getLifecycle: () => lifecycle,
    homeWriter: ({ bootstrap }) => ({
      env: {},
      hermesHome: 'managed-home',
      publicState: { authenticated: true, policyHash: bootstrap.policyHash, user: bootstrap.user }
    }),
    managedHermesHome: 'managed-home'
  })

  const olderPublicState = runtime.refreshPublicState()
  await runtime.prepareLaunch()
  oldMe.resolve({ user: { id: 'user-a', displayName: 'Old account response' } })

  await assert.rejects(olderPublicState, error => error.code === 'enterprise_operation_superseded')
  assert.equal(runtime.getPublicState().policyHash, 'new-policy')
  assert.equal(runtime.getPublicState().user.displayName, undefined)
})

test('an older policy refresh cannot overwrite a newer full managed-home launch', async () => {
  const oldBootstrap = deferred()
  let bootstrapCalls = 0
  let policyWrites = 0
  const homeWrites = []
  const lifecycle = runningLifecycle()
  const runtime = createEnterpriseRuntime({
    authStore: { readSession: () => ({ desktopToken: 'dsk_user_a', user: { id: 'user-a' } }) },
    client: {
      bootstrap: async () => (++bootstrapCalls === 1 ? oldBootstrap.promise : validBootstrap({ policyHash: 'new-policy' })),
      modelProfiles: async () => ({ modelProfiles: [] }),
      runtimeManifest: async () => ({ gatewayToken: 'gateway-token' })
    },
    enabled: true,
    getLifecycle: () => lifecycle,
    homeWriter: ({ bootstrap }) => {
      homeWrites.push(bootstrap.policyHash)
      return {
        env: {},
        hermesHome: 'managed-home',
        publicState: { authenticated: true, policyHash: bootstrap.policyHash, user: bootstrap.user }
      }
    },
    managedHermesHome: 'managed-home',
    policyWriter: () => {
      policyWrites += 1
      return { policy: cachedPolicy() }
    }
  })

  const olderRefresh = runtime.refreshPolicy()
  const newerLaunch = runtime.prepareLaunch()
  await newerLaunch
  oldBootstrap.resolve(validBootstrap({ policyHash: 'old-policy' }))

  await assert.rejects(olderRefresh, error => error.code === 'enterprise_operation_superseded')
  assert.equal(policyWrites, 0)
  assert.deepEqual(homeWrites, ['new-policy'])
  assert.equal(runtime.getPublicState().policyHash, 'new-policy')
})

test('policy refresh starts a fresh single-flight after another operation supersedes the old generation', async () => {
  const firstBootstrap = deferred()
  let bootstrapCalls = 0
  const writes = []
  const lifecycle = runningLifecycle()
  const runtime = createEnterpriseRuntime({
    authStore: { readSession: () => ({ desktopToken: 'dsk_user_a', user: { id: 'user-a' } }) },
    client: {
      bootstrap: async () => (++bootstrapCalls === 1 ? firstBootstrap.promise : validBootstrap({ policyHash: 'fresh-policy' })),
      modelProfiles: async () => ({ modelProfiles: [] }),
      runtimeManifest: async () => ({ gatewayToken: 'gateway-token' })
    },
    enabled: true,
    getLifecycle: () => lifecycle,
    homeWriter: ({ bootstrap }) => ({
      env: {},
      hermesHome: 'managed-home',
      publicState: { authenticated: true, policyHash: bootstrap.policyHash, user: bootstrap.user }
    }),
    managedHermesHome: 'managed-home',
    policyWriter: ({ bootstrap }) => {
      writes.push(bootstrap.policyHash)
      return { policy: cachedPolicy() }
    }
  })

  const staleRefresh = runtime.refreshPolicy()
  await runtime.prepareLaunch()
  const freshRefresh = runtime.refreshPolicy()
  assert.notEqual(freshRefresh, staleRefresh)
  await freshRefresh
  firstBootstrap.resolve(validBootstrap({ policyHash: 'stale-policy' }))

  await assert.rejects(staleRefresh, error => error.code === 'enterprise_operation_superseded')
  assert.deepEqual(writes, ['fresh-policy'])
})

test('a mismatched account response fails closed and never publishes the returned user', async () => {
  let session = { desktopToken: 'dsk_user_a', user: { id: 'user-a' } }
  const terminalStates = []
  const lifecycle = runningLifecycle()
  const runtime = createEnterpriseRuntime({
    authStore: {
      clear: () => { session = null },
      readSession: () => session
    },
    client: { me: async () => ({ user: { id: 'user-b', displayName: 'Wrong user' } }) },
    enabled: true,
    getLifecycle: () => lifecycle,
    onTerminalAuth: async event => terminalStates.push(event.terminalState)
  })

  const state = await runtime.refreshPublicState()

  assert.equal(state.authenticated, false)
  assert.equal(state.user, null)
  assert.equal(session.user.id, 'user-a')
  assert.deepEqual(terminalStates, ['blocked'])
})

test('revoking state denies public runtime operations before clients or managed writers run', async () => {
  const cleanup = deferred()
  const calls = []
  const writes = []
  const lifecycle = createEnterpriseManagedLifecycle({
    effects: {
      cancelPendingStarts: async () => cleanup.promise,
      stopOwnedProcesses: async () => undefined,
      verifyResourcesGone: async () => true
    },
    hasSession: true
  })
  lifecycle.markRunning({ reasonCode: 'test_ready' })
  const runtime = createEnterpriseRuntime({
    authStore: {
      readSession: () => ({ desktopToken: 'dsk_user_a', user: { id: 'user-a' } }),
      writeSession: value => writes.push(value)
    },
    client: {
      bootstrap: async () => { calls.push('bootstrap'); return validBootstrap() },
      login: async () => { calls.push('login'); return { desktopToken: 'new', user: { id: 'user-a' } } },
      me: async () => { calls.push('me'); return { user: { id: 'user-a' } } },
      modelProfiles: async () => { calls.push('modelProfiles'); return { modelProfiles: [] } },
      runtimeManifest: async () => { calls.push('runtimeManifest'); return {} }
    },
    enabled: true,
    getLifecycle: () => lifecycle,
    homeWriter: value => { writes.push(value); return value },
    managedHermesHome: 'managed-home',
    policyWriter: value => { writes.push(value); return value }
  })
  runtime.lastPublicState = {
    ...runtime.lastPublicState,
    allowedModels: ['m1'],
    authenticated: true,
    status: 'authenticated'
  }

  const revoke = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  await Promise.resolve()
  const before = lifecycle.getSnapshot()
  const operations = [
    runtime.login({ username: 'user-a', password: 'secret' }),
    runtime.refreshPublicState(),
    runtime.refreshPolicy(),
    runtime.prepareLaunch(),
    runtime.selectModel('m1')
  ]
  const results = await Promise.allSettled(operations)
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason.code, 'enterprise_operation_superseded')
  }

  const after = lifecycle.getSnapshot()
  assert.deepEqual(calls, [])
  assert.deepEqual(writes, [])
  assert.equal(after.authEpoch, before.authEpoch)
  assert.equal(after.reasonCode, before.reasonCode)
  assert.equal(after.state, 'revoking')

  cleanup.resolve()
  await revoke
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
