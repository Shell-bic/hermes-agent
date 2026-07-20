const test = require('node:test')
const assert = require('node:assert/strict')
const { createEnterpriseManagedLifecycle } = require('./enterprise-managed-lifecycle.cjs')

const {
  ENTERPRISE_PROFILE_NOT_MANAGED,
  createManagedProfileInvoker,
  createEnterpriseManagedProfileGuard,
  managedUserId,
  profileIpcResult,
  registerEnterpriseManagedProfileIpc,
  unwrapProfileIpcResult
} = require('./enterprise-managed-profile.cjs')

test('enterprise guard accepts only the immutable managed primary identity', () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })

  assert.equal(guard.resolve(null), 'enterprise-managed')
  assert.equal(guard.resolve(''), 'enterprise-managed')
  assert.equal(guard.resolve('default'), 'enterprise-managed')
  assert.equal(guard.resolve('enterprise-managed'), 'enterprise-managed')
  assert.throws(() => guard.resolve('finance'), error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED)
  assert.throws(() => guard.resolve('remote:finance'), error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED)
})

test('non-enterprise guard preserves ordinary profile pool and remote behavior', () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: false })

  assert.equal(guard.resolve('finance'), 'finance')
  assert.equal(guard.resolve(null), null)
  assert.doesNotThrow(() => guard.assertRemoteAllowed('settings', 'finance'))
  assert.doesNotThrow(() => guard.assertProfileMutation('profile:set'))
})

test('non-enterprise API boundary delegates the original request object unchanged', async () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: false })
  const request = { body: { profile: 'finance' }, path: '/api/config?profile=finance', profile: 'finance' }
  let forwarded = null

  await guard.handleApiRequest(request, async value => {
    forwarded = value
    return { ok: true }
  })

  assert.equal(forwarded, request)
})

test('enterprise profile mutations and remote resolution fail before side effects', () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })

  assert.throws(() => guard.assertProfileMutation('profile:set'), error => {
    assert.equal(error.code, ENTERPRISE_PROFILE_NOT_MANAGED)
    assert.equal(error.operation, 'profile:set')
    return true
  })
  assert.throws(() => guard.assertProfileMutation('profile:delete'), error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED)
  assert.throws(() => guard.assertRemoteAllowed('connection-config:test', null), error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED)
  assert.throws(() => guard.assertRemoteAllowed('resolveRemoteBackend', 'enterprise-managed'), error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED)
})

test('managed runtime identity is immutable and cannot be rewritten by callers', () => {
  const guard = createEnterpriseManagedProfileGuard({
    enabled: true,
    identity: { key: 'enterprise-managed', userId: 'user-a', hermesHome: 'C:/managed-a' }
  })
  const first = guard.identity()
  assert.deepEqual(first, { key: 'enterprise-managed', userId: 'user-a', hermesHome: 'C:/managed-a' })
  assert.equal(Object.isFrozen(first), true)
  first.userId = 'user-b'
  assert.equal(first.userId, 'user-a')
  assert.throws(() => guard.setIdentity({ key: 'enterprise-managed', userId: 'user-b', hermesHome: 'C:/managed-b' }), error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED)
  assert.deepEqual(guard.identity(), first)
})

test('managed runtime binds a complete launch identity exactly once', () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })

  assert.throws(
    () => guard.bindIdentity({ hermesHome: 'C:/managed-a' }),
    error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED && error.operation === 'identity:bind'
  )
  assert.deepEqual(
    guard.bindIdentity({ userId: 'user-a', hermesHome: 'C:/managed-a' }),
    { key: 'enterprise-managed', userId: 'user-a', hermesHome: 'C:/managed-a' }
  )
  assert.doesNotThrow(() => guard.bindIdentity({ userId: 'user-a', hermesHome: 'C:/managed-a' }))
  assert.throws(
    () => guard.bindIdentity({ userId: 'user-b', hermesHome: 'C:/managed-b' }),
    error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED && error.operation === 'identity:set'
  )
})

test('managed user id uses the same stable enterprise account fields as managed home resolution', () => {
  assert.equal(managedUserId({ id: 'primary-id', userId: 'secondary-id' }), 'primary-id')
  assert.equal(managedUserId({ desktopUserId: 'desktop-user' }), 'desktop-user')
  assert.equal(managedUserId({ username: 'ada' }), 'ada')
  assert.equal(managedUserId({ displayName: 'not-stable' }), null)
})

test('managed API boundary rejects every profile mutation before forwarding', async () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })
  let forwards = 0
  const next = async () => {
    forwards += 1
    return { ok: true }
  }
  const mutations = [
    { method: 'POST', path: '/api/profiles', body: { name: 'finance' } },
    { method: 'PATCH', path: '/api/profiles/default', body: { new_name: 'finance' } },
    { method: 'DELETE', path: '/api/profiles/default' },
    { method: 'PUT', path: '/api/profiles/default/soul', body: { content: 'changed' } }
  ]

  for (const request of mutations) {
    await assert.rejects(
      () => guard.handleApiRequest(request, next),
      error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED && error.operation.startsWith('profile:')
    )
  }
  assert.equal(forwards, 0)
})

test('managed API boundary prevents named profile reads and rewrites the managed alias to native default', async () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })
  const forwarded = []
  const next = async request => {
    forwarded.push(request)
    return { content: 'managed soul', exists: true }
  }

  await assert.rejects(
    () => guard.handleApiRequest({ path: '/api/profiles/finance/soul' }, next),
    error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED && error.profile === 'finance'
  )
  await assert.rejects(
    () => guard.handleApiRequest({ path: '/api/profiles%2Ffinance%2Fsoul' }, next),
    error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED && error.profile === 'finance'
  )
  await assert.rejects(
    () => guard.handleApiRequest({ path: '/api/profiles/%E0%A4%A/soul' }, next),
    error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED && error.operation === 'profile:api'
  )
  assert.equal(forwarded.length, 0)
  const result = await guard.handleApiRequest({ path: '/api/profiles/enterprise-managed/soul?raw=1' }, next)
  assert.deepEqual(result, { content: 'managed soul', exists: true })
  assert.equal(forwarded.length, 1)
  assert.equal(forwarded[0].path, '/api/profiles/default/soul?raw=1')
  await assert.rejects(
    () => guard.handleApiRequest({ path: '/api/profiles/default/setup-command' }, next),
    error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED && error.operation === 'profile:setup-command'
  )
  assert.equal(forwarded.length, 1)
})

test('managed API boundary rejects nested encoded profile routes before forwarding', async () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })
  let forwards = 0
  const next = async request => {
    forwards += 1
    return { path: request.path }
  }
  const blocked = [
    { path: '/api/profiles%252Ffinance%252Fsoul' },
    { path: '/api/profiles%25252Ffinance%25252Fsoul' },
    { path: '/api/profiles%252Fdefault%252Fsetup-command' },
    { path: '/api/profiles%25252Fenterprise-managed%25252Fsetup-command' },
    { method: 'PUT', path: '/api/profiles%252Fdefault%252Fsoul', body: { content: 'changed' } },
    { method: 'DELETE', path: '/api/profiles%25252Fdefault' },
    { path: '/api/profiles%25252525252Ffinance%25252525252Fsoul' }
  ]

  for (const request of blocked) {
    await assert.rejects(
      () => guard.handleApiRequest(request, next),
      error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED
    )
  }
  assert.equal(forwards, 0)

  const managed = await guard.handleApiRequest(
    { path: '/api/profiles%25252Fenterprise-managed%25252Fsoul?raw=1' },
    next
  )
  assert.deepEqual(managed, { path: '/api/profiles/default/soul?raw=1' })
  assert.equal(forwards, 1)
})

test('managed API boundary leaves unrelated ordinary API paths byte-for-byte unchanged', async () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })
  const request = { path: '/api/files%252Freport?keep=a%2Fb', timeoutMs: 1000 }
  let forwarded = null

  await guard.handleApiRequest(request, async value => {
    forwarded = value
    return { ok: true }
  })

  assert.equal(forwarded, request)
  assert.equal(forwarded.path, '/api/files%252Freport?keep=a%2Fb')
})

test('managed API boundary projects profile list, active profile, and aggregate sessions to one primary', async () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })
  guard.bindIdentity({ userId: 'user-a', hermesHome: 'C:/managed-a' })
  const forwarded = []
  const next = async request => {
    forwarded.push(request)
    if (request.path === '/api/profiles') {
      return {
        profiles: [
          { has_env: true, is_default: true, model: 'm1', name: 'default', path: 'C:/wrong', provider: 'gw', skill_count: 1 },
          { has_env: true, is_default: false, model: 'm2', name: 'finance', path: 'C:/finance', provider: 'gw', skill_count: 99 }
        ]
      }
    }
    return {
      errors: [
        { error: 'default warning', profile: 'default' },
        { error: 'must stay hidden', profile: 'finance' }
      ],
      sessions: [
        { id: 's1', profile: 'default' },
        { id: 'secret-finance', profile: 'finance' }
      ],
      total: 2,
      profile_totals: { default: 1, finance: 1 }
    }
  }

  const active = await guard.handleApiRequest({ path: '/api/profiles/active' }, next)
  assert.deepEqual(active, { active: 'default', current: 'default' })
  assert.equal(forwarded.length, 0)

  const list = await guard.handleApiRequest({ path: '/api/profiles' }, next)
  assert.equal(list.profiles.length, 1)
  assert.deepEqual(list.profiles[0], {
    has_env: true,
    is_default: true,
    model: 'm1',
    name: 'default',
    path: 'C:/managed-a',
    provider: 'gw',
    skill_count: 1
  })

  const sessions = await guard.handleApiRequest(
    { path: '/api/profiles/sessions?profile=all&limit=20' },
    next
  )
  const sessionsUrl = new URL(forwarded[1].path, 'http://local')
  assert.equal(sessionsUrl.searchParams.get('profile'), 'default')
  assert.equal(sessionsUrl.searchParams.get('limit'), '20')
  assert.deepEqual(sessions.sessions, [{ id: 's1', profile: 'default', is_default_profile: true }])
  assert.deepEqual(sessions.profile_totals, { default: 1 })
  assert.equal(sessions.total, 1)
  assert.deepEqual(sessions.errors, [{ error: 'default warning', profile: 'default' }])
  assert.equal(JSON.stringify(sessions).includes('secret-finance'), false)
  assert.equal(JSON.stringify(sessions).includes('must stay hidden'), false)

  const foreignDefault = await guard.handleApiRequest({ path: '/api/profiles' }, async () => ({
    profiles: [{ is_default: true, name: 'finance', path: 'C:/finance' }]
  }))
  assert.deepEqual(foreignDefault.profiles, [])
})

test('managed API boundary blocks out-of-band pool identities on ordinary APIs', async () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })
  let forwarded = false

  await assert.rejects(
    () => guard.handleApiRequest({ path: '/api/skills', profile: 'finance' }, async () => {
      forwarded = true
    }),
    error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED && error.profile === 'finance'
  )
  assert.equal(forwarded, false)
})

test('managed API boundary validates and normalizes every top-level profile selector before forwarding', async () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })
  const forwarded = []
  const next = async request => {
    forwarded.push(request)
    return { ok: true }
  }
  const rejected = [
    { path: '/api/sessions/s1/messages?profile=finance' },
    { path: '/api/config?profile=remote%3Afinance' },
    { path: '/api/config?pr%6Ffile=finance' },
    { path: '/api/config?profile=default&profile=finance' },
    { path: '/api/config?profile=finance&profile=default' },
    { path: '/api/config', body: { profile: 'finance', value: 1 } },
    { path: '/api/config', profile: 'finance' }
  ]

  for (const request of rejected) {
    await assert.rejects(
      () => guard.handleApiRequest(request, next),
      error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED
    )
  }
  assert.equal(forwarded.length, 0)

  await guard.handleApiRequest({
    body: { profile: '', value: 1 },
    path: '/api/config?profile=all&profile=enterprise%2Dmanaged&keep=1',
    profile: 'enterprise-managed'
  }, next)
  assert.equal(forwarded.length, 1)
  assert.equal(forwarded[0].profile, 'default')
  assert.deepEqual(forwarded[0].body, { profile: 'default', value: 1 })
  const forwardedUrl = new URL(forwarded[0].path, 'http://local')
  assert.deepEqual(forwardedUrl.searchParams.getAll('profile'), ['default'])
  assert.equal(forwardedUrl.searchParams.get('keep'), '1')
})

test('managed connection config never exposes or selects legacy remote descriptors', () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })
  assert.deepEqual(guard.managedConnectionConfig(null), {
    mode: 'local',
    profile: null,
    remoteAuthMode: 'token',
    remoteOauthConnected: false,
    remoteUrl: '',
    remoteTokenPreview: '',
    remoteTokenSet: false,
    envOverride: false
  })
  assert.throws(
    () => guard.managedConnectionConfig('finance'),
    error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED
  )
})

test('managed profile operation rejects pool touch before any callback side effect', () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })
  const touched = []

  assert.throws(
    () => guard.runProfileOperation('finance', profile => touched.push(profile)),
    error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED && error.profile === 'finance'
  )
  assert.deepEqual(touched, [])
  assert.deepEqual(
    guard.runProfileOperation('default', profile => {
      touched.push(profile)
      return { ok: true }
    }),
    { ok: true }
  )
  assert.deepEqual(touched, ['default'])
})

test('managed profile IPC envelope preserves structured error fields across serialization', async () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })
  const wireValue = await profileIpcResult(() =>
    guard.handleApiRequest({ method: 'POST', path: '/api/profiles' }, async () => ({ ok: true }))
  )
  const serialized = JSON.parse(JSON.stringify(wireValue))

  assert.equal(serialized.envelope, 'enterprise-public-result.v1')
  assert.equal(serialized.ok, false)
  assert.equal(serialized.error.envelope, 'enterprise-public-error.v1')
  assert.equal(serialized.error.errorCode, ENTERPRISE_PROFILE_NOT_MANAGED)
  assert.equal(serialized.error.httpStatus, 403)
  assert.equal(serialized.error.operation, undefined)
  assert.throws(() => unwrapProfileIpcResult(serialized), error => {
    assert.equal(error.code, ENTERPRISE_PROFILE_NOT_MANAGED)
    assert.equal(error.status, 403)
    assert.equal(error.operation, undefined)
    return true
  })
})

test('managed profile IPC registrar rejects guarded operations before action side effects', async () => {
  const handlers = new Map()
  const calls = []
  const action = name => async value => {
    calls.push([name, value])
    return { name, value }
  }
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })
  registerEnterpriseManagedProfileIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    guard,
    actions: {
      applyConnectionConfig: action('apply'),
      connection: action('connection'),
      gatewayWsUrl: action('ws'),
      getConnectionConfig: action('get-config'),
      oauthLoginConnectionConfig: action('oauth-login'),
      oauthLogoutConnectionConfig: action('oauth-logout'),
      probeConnectionConfig: action('probe'),
      saveConnectionConfig: action('save'),
      setProfile: action('set-profile'),
      testConnectionConfig: action('test-config'),
      touchBackend: action('touch')
    }
  })
  const invoke = (channel, ...args) => handlers.get(channel)(null, ...args)
  const blocked = [
    ['hermes:connection', 'finance'],
    ['hermes:backend:touch', 'finance'],
    ['hermes:connection-config:save', { mode: 'remote', profile: 'default' }],
    ['hermes:profile:set', 'finance']
  ]

  for (const [channel, payload] of blocked) {
    const result = await invoke(channel, payload)
    assert.equal(result.ok, false)
    assert.equal(result.error.errorCode, ENTERPRISE_PROFILE_NOT_MANAGED)
  }
  assert.deepEqual(calls, [])

  assert.deepEqual(await invoke('hermes:connection', 'default'), {
    envelope: 'enterprise-public-result.v1',
    ok: true,
    value: { name: 'connection', value: 'default' }
  })
  assert.deepEqual(calls, [['connection', 'default']])
})

test('managed profile registrar converts ordinary action failures to one safe public result', async () => {
  const handlers = new Map()
  registerEnterpriseManagedProfileIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    guard: createEnterpriseManagedProfileGuard({ enabled: true }),
    getLifecycle: () => ({ getSnapshot: () => ({ lifecycleEpoch: 7, state: 'running' }) }),
    actions: {
      applyConnectionConfig: async () => {},
      connection: async () => { throw Object.assign(new Error('private host and token'), { code: 'gateway-offline', statusCode: 503 }) },
      gatewayWsUrl: async () => {},
      getConnectionConfig: async () => {},
      oauthLoginConnectionConfig: async () => {},
      oauthLogoutConnectionConfig: async () => {},
      probeConnectionConfig: async () => {},
      saveConnectionConfig: async () => {},
      setProfile: async () => {},
      testConnectionConfig: async () => {},
      touchBackend: async () => {}
    }
  })

  const result = await handlers.get('hermes:connection')({}, 'default')
  assert.equal(result.error.errorCode, 'gateway-offline')
  assert.equal(result.error.httpStatus, 503)
  assert.equal(result.error.lifecycleEpoch, 7)
  assert.doesNotMatch(result.error.message, /private host|token/)
})

test('trust rejection remains a safe v1 failure when lifecycle is not initialized', async () => {
  const handlers = new Map()
  registerEnterpriseManagedProfileIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    guard: createEnterpriseManagedProfileGuard({ enabled: true }),
    assertTrusted: () => { throw new Error('untrusted') },
    getLifecycle: () => { throw new Error('not initialized') },
    actions: {
      applyConnectionConfig: async () => {},
      connection: async () => assert.fail('must not run'),
      gatewayWsUrl: async () => {},
      getConnectionConfig: async () => {},
      oauthLoginConnectionConfig: async () => {},
      oauthLogoutConnectionConfig: async () => {},
      probeConnectionConfig: async () => {},
      saveConnectionConfig: async () => {},
      setProfile: async () => {},
      testConnectionConfig: async () => {},
      touchBackend: async () => {}
    }
  })
  const result = await handlers.get('hermes:connection')({}, 'default')
  assert.equal(result.envelope, 'enterprise-public-result.v1')
  assert.equal(result.error.errorCode, 'enterprise_untrusted_renderer')
  assert.equal(result.error.lifecycleEpoch, 0)
  assert.equal(result.error.recoveryKind, 'none')
})

test('unmanaged profile actions do not inherit unauthenticated enterprise lifecycle recovery', async () => {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: false })
  const before = lifecycle.getSnapshot()
  for (const [thrown, recoveryKind] of [
    [new Error('ordinary local failure'), 'none'],
    [Object.assign(new Error('local authorization response'), { statusCode: 401 }), 'none'],
    [Object.assign(new Error('local service unavailable'), { statusCode: 500 }), 'retry']
  ]) {
    const result = await profileIpcResult(async () => { throw thrown }, {
      getLifecycle: () => lifecycle,
      managed: false
    })
    assert.equal(result.error.recoveryKind, recoveryKind)
    assert.deepEqual(lifecycle.getSnapshot(), before)
  }
})

test('managed mode callback failure cannot escape the profile IPC envelope', async () => {
  const result = await profileIpcResult(async () => { throw new Error('action failed') }, {
    managed: () => { throw new Error('mode unavailable') }
  })
  assert.equal(result.envelope, 'enterprise-public-result.v1')
  assert.equal(result.ok, false)
  assert.equal(result.error.recoveryKind, 'none')
})

test('managed profile preload invoker unwraps the serialized IPC error envelope', async () => {
  const guard = createEnterpriseManagedProfileGuard({ enabled: true })
  const wireValue = JSON.parse(JSON.stringify(await profileIpcResult(() => guard.resolve('finance'))))
  const calls = []
  const invoke = createManagedProfileInvoker({
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args])
      return wireValue
    }
  })

  await assert.rejects(
    () => invoke('hermes:connection', 'finance'),
    error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED && error.status === 403
  )
  assert.deepEqual(calls, [['hermes:connection', 'finance']])
})
