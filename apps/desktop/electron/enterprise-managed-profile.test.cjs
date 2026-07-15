const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ENTERPRISE_PROFILE_NOT_MANAGED,
  createEnterpriseManagedProfileGuard
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
