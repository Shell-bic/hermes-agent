const ENTERPRISE_PROFILE_NOT_MANAGED = 'enterprise_profile_not_managed'
const DEFAULT_MANAGED_PROFILE_KEY = 'enterprise-managed'

function isEnabledValue(enabled) {
  return typeof enabled === 'function' ? enabled() === true : enabled === true
}

function normalizeIdentity(identity = {}) {
  const key = String(identity.key || DEFAULT_MANAGED_PROFILE_KEY).trim() || DEFAULT_MANAGED_PROFILE_KEY
  const userId = String(identity.userId || '').trim() || null
  const hermesHome = String(identity.hermesHome || '').trim() || null
  return Object.freeze({ key, userId, hermesHome })
}

function profileNotManagedError(operation, requested, reason = 'Enterprise managed runtime only supports its immutable primary profile.') {
  const error = new Error(reason)
  error.code = ENTERPRISE_PROFILE_NOT_MANAGED
  error.operation = String(operation || 'profile')
  if (requested !== undefined && requested !== null && String(requested).trim()) {
    error.profile = String(requested).trim()
  }
  return error
}

/**
 * Centralizes the enterprise profile boundary. Enterprise runtime is a single
 * managed primary: secondary windows reuse that connection; no local pool or
 * remote profile override is allowed to create another runtime identity.
 */
function createEnterpriseManagedProfileGuard({ enabled = false, identity = {} } = {}) {
  let currentIdentity = normalizeIdentity(identity)

  function active() {
    return isEnabledValue(enabled)
  }

  function managedKey() {
    return currentIdentity.key
  }

  function isManagedAlias(profile) {
    const value = String(profile ?? '').trim()
    return !value || value === 'default' || value === managedKey()
  }

  function resolve(profile) {
    if (!active()) {
      const value = String(profile ?? '').trim()
      return value || null
    }

    if (!isManagedAlias(profile)) {
      throw profileNotManagedError('profile:resolve', profile)
    }
    return managedKey()
  }

  function assertProfileMutation(operation, requested) {
    if (active()) {
      throw profileNotManagedError(operation, requested, 'Enterprise managed profile cannot be changed by desktop profile settings.')
    }
  }

  function assertRemoteAllowed(operation, requested) {
    if (active()) {
      throw profileNotManagedError(operation, requested, 'Enterprise managed runtime does not support local pool or remote profile connections.')
    }
  }

  function getIdentity() {
    return currentIdentity
  }

  function setIdentity(next) {
    const candidate = normalizeIdentity(next)
    if (candidate.key !== currentIdentity.key || candidate.userId !== currentIdentity.userId || candidate.hermesHome !== currentIdentity.hermesHome) {
      throw profileNotManagedError('identity:set', undefined, 'Enterprise managed runtime identity is immutable for this desktop session.')
    }
    return currentIdentity
  }

  return Object.freeze({
    assertProfileMutation,
    assertRemoteAllowed,
    identity: getIdentity,
    isEnabled: active,
    managedKey,
    resolve,
    setIdentity
  })
}

module.exports = {
  DEFAULT_MANAGED_PROFILE_KEY,
  ENTERPRISE_PROFILE_NOT_MANAGED,
  createEnterpriseManagedProfileGuard,
  profileNotManagedError
}
