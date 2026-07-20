const test = require('node:test')
const assert = require('node:assert/strict')
const { createProfileDeleteCoordinator, profileNameFromDeleteRequest } = require('./enterprise-profile-delete.cjs')

test('profile delete is parsed without mutating local runtime state', () => {
  assert.equal(profileNameFromDeleteRequest({ method: 'DELETE', path: '/api/profiles/Work%20One' }), 'work one')
  assert.equal(profileNameFromDeleteRequest({ method: 'GET', path: '/api/profiles/work' }), null)
})

test('profile delete side effects are deferred until the HTTP request commits', async () => {
  const effects = []
  const prepare = createProfileDeleteCoordinator({
    isManaged: () => false,
    isValidProfileName: value => value === 'work',
    primaryProfileKey: () => 'work',
    writeActiveDesktopProfile: value => effects.push(`write:${value}`),
    teardownPrimaryBackendAndWait: async () => effects.push('teardown')
  })

  const active = { checkpoint: () => effects.push('checkpoint') }
  const commit = prepare({ method: 'DELETE', path: '/api/profiles/work' }, active)
  assert.deepEqual(effects, [])

  await commit()
  assert.deepEqual(effects, ['checkpoint', 'write:default', 'teardown', 'checkpoint'])
})

test('revocation before the response prevents every local delete side effect', async () => {
  const effects = []
  const prepare = createProfileDeleteCoordinator({
    isManaged: () => false,
    isValidProfileName: () => true,
    primaryProfileKey: () => 'work',
    writeActiveDesktopProfile: value => effects.push(value),
    teardownPrimaryBackendAndWait: async () => effects.push('teardown')
  })
  const commit = prepare({ method: 'DELETE', path: '/api/profiles/work' }, {
    checkpoint() {
      throw Object.assign(new Error('revoked'), { code: 'enterprise_operation_superseded' })
    }
  })

  await assert.rejects(commit(), error => error.code === 'enterprise_operation_superseded')
  assert.deepEqual(effects, [])
})

test('managed profile deletion fails before any commit plan is created', () => {
  const prepare = createProfileDeleteCoordinator({
    assertProfileMutation() {
      throw Object.assign(new Error('managed'), { code: 'enterprise_profile_not_managed' })
    },
    isManaged: () => true,
    isValidProfileName: () => true
  })
  assert.throws(
    () => prepare({ method: 'DELETE', path: '/api/profiles/work' }),
    error => error.code === 'enterprise_profile_not_managed'
  )
})

test('backend success followed by primary teardown failure keeps a deterministic local result', async () => {
  const effects = []
  const prepare = createProfileDeleteCoordinator({
    isManaged: () => false,
    isValidProfileName: () => true,
    primaryProfileKey: () => 'work',
    writeActiveDesktopProfile: value => effects.push(`write:${value}`),
    teardownPrimaryBackendAndWait: async () => {
      effects.push('teardown')
      throw Object.assign(new Error('stop failed'), { code: 'enterprise_runtime_stop_failed' })
    }
  })
  const active = { checkpoint: () => effects.push('checkpoint') }
  const commit = prepare({ method: 'DELETE', path: '/api/profiles/work' }, active)

  await assert.rejects(commit(), error => error.code === 'enterprise_runtime_stop_failed')
  assert.deepEqual(effects, ['checkpoint', 'write:default', 'teardown'])
})
