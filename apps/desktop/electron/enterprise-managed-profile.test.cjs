const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  ENTERPRISE_PROFILE_NOT_MANAGED,
  createEnterpriseManagedProfileGuard,
  managedUserId,
  profileIpcResult,
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
    error => error.code === ENTERPRISE_PROFILE_NOT_MANAGED && error.operation === 'profile:read'
  )
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
  assert.equal(forwarded[1].path, '/api/profiles/sessions?profile=default&limit=20')
  assert.deepEqual(sessions.sessions, [{ id: 's1', profile: 'default', is_default_profile: true }])
  assert.deepEqual(sessions.profile_totals, { default: 1 })
  assert.equal(sessions.total, 1)
  assert.deepEqual(sessions.errors, [{ error: 'default warning', profile: 'default' }])
  assert.equal(JSON.stringify(sessions).includes('secret-finance'), false)
  assert.equal(JSON.stringify(sessions).includes('must stay hidden'), false)
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

  assert.equal(serialized.ok, false)
  assert.equal(serialized.error.code, ENTERPRISE_PROFILE_NOT_MANAGED)
  assert.equal(serialized.error.operation, 'profile:post')
  assert.equal(serialized.error.status, 403)
  assert.throws(() => unwrapProfileIpcResult(serialized), error => {
    assert.equal(error.code, ENTERPRISE_PROFILE_NOT_MANAGED)
    assert.equal(error.operation, 'profile:post')
    assert.equal(error.status, 403)
    return true
  })
})

test('desktop main binds launch identity and routes IPC through the managed API boundary', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const guard = main.indexOf('const enterpriseManagedProfileGuard = createEnterpriseManagedProfileGuard({')
  const runtime = main.indexOf('const enterpriseRuntime = createEnterpriseRuntime({', guard)
  const binder = main.indexOf('managedIdentityBinder:', runtime)
  assert.ok(guard >= 0 && runtime > guard && binder > runtime)
  assert.match(main.slice(binder, binder + 260), /enterpriseManagedProfileGuard\.bindIdentity/)

  const handler = main.indexOf("ipcMain.handle('hermes:api'")
  assert.ok(handler >= 0)
  assert.match(
    main.slice(handler, handler + 260),
    /profileIpcResult\(\(\) => enterpriseManagedProfileGuard\.handleApiRequest\(request, handleHermesApiRequest\)\)/
  )
  assert.match(preload, /api: request => invokeManagedProfile\('hermes:api', request\)/)
  assert.match(preload, /getConnection: profile => invokeManagedProfile\('hermes:connection', profile\)/)
  assert.match(preload, /touchBackend: profile => invokeManagedProfile\('hermes:backend:touch', profile\)/)
  const touchHandler = main.indexOf("ipcMain.handle('hermes:backend:touch'")
  assert.match(main.slice(touchHandler, touchHandler + 360), /enterpriseManagedProfileGuard\.runProfileOperation/)
})
