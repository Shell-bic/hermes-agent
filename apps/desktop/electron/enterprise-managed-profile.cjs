const ENTERPRISE_PROFILE_NOT_MANAGED = 'enterprise_profile_not_managed'
const DEFAULT_MANAGED_PROFILE_KEY = 'enterprise-managed'
const MANAGED_PROFILE_ERROR_ENVELOPE = 'enterprise-managed-profile-error.v1'

function isEnabledValue(enabled) {
  return typeof enabled === 'function' ? enabled() === true : enabled === true
}

function normalizeIdentity(identity = {}) {
  const key = String(identity.key || DEFAULT_MANAGED_PROFILE_KEY).trim() || DEFAULT_MANAGED_PROFILE_KEY
  const userId = String(identity.userId || '').trim() || null
  const hermesHome = String(identity.hermesHome || '').trim() || null
  return Object.freeze({ key, userId, hermesHome })
}

function managedUserId(user) {
  if (!user || typeof user !== 'object') return null

  const value = user.id || user.userId || user.desktopUserId || user.userName || user.username || user.email || ''
  return String(value || '').trim() || null
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

function publicError(error) {
  return {
    code: ENTERPRISE_PROFILE_NOT_MANAGED,
    message: String(error?.message || 'Enterprise managed profile operation is not allowed.'),
    operation: String(error?.operation || 'profile'),
    profile: error?.profile ? String(error.profile) : null,
    status: 403
  }
}

async function profileIpcResult(operation) {
  try {
    return await operation()
  } catch (error) {
    if (error?.code !== ENTERPRISE_PROFILE_NOT_MANAGED) throw error
    return {
      envelope: MANAGED_PROFILE_ERROR_ENVELOPE,
      error: publicError(error),
      ok: false
    }
  }
}

function unwrapProfileIpcResult(result) {
  if (result?.envelope !== MANAGED_PROFILE_ERROR_ENVELOPE) return result

  const error = new Error(result?.error?.message || 'Enterprise managed profile operation is not allowed.')
  error.code = result?.error?.code || ENTERPRISE_PROFILE_NOT_MANAGED
  error.operation = result?.error?.operation || 'profile'
  error.profile = result?.error?.profile || null
  error.status = Number.isFinite(result?.error?.status) ? result.error.status : 403
  throw error
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

  function publicKey() {
    return 'default'
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

  function bindIdentity(next) {
    const candidate = normalizeIdentity({ ...next, key: next?.key || currentIdentity.key })
    if (!candidate.userId || !candidate.hermesHome) {
      throw profileNotManagedError(
        'identity:bind',
        undefined,
        'Enterprise managed runtime requires a stable user id and managed Hermes home.'
      )
    }

    const keyChanged = candidate.key !== currentIdentity.key
    const userChanged = currentIdentity.userId && candidate.userId !== currentIdentity.userId
    const homeChanged = currentIdentity.hermesHome && candidate.hermesHome !== currentIdentity.hermesHome
    if (keyChanged || userChanged || homeChanged) {
      throw profileNotManagedError('identity:set', undefined, 'Enterprise managed runtime identity is immutable for this desktop session.')
    }

    currentIdentity = normalizeIdentity({
      key: currentIdentity.key,
      userId: currentIdentity.userId || candidate.userId,
      hermesHome: currentIdentity.hermesHome || candidate.hermesHome
    })
    return currentIdentity
  }

  function managedConnectionConfig(profile) {
    resolve(profile)
    return {
      mode: 'local',
      profile: profile == null || String(profile).trim() === '' ? null : publicKey(),
      remoteAuthMode: 'token',
      remoteOauthConnected: false,
      remoteUrl: '',
      remoteTokenPreview: '',
      remoteTokenSet: false,
      envOverride: false
    }
  }

  function runProfileOperation(profile, operation) {
    if (typeof operation !== 'function') throw new TypeError('Managed profile operation requires a callback.')
    const resolved = resolve(profile)
    return operation(active() ? publicKey() : resolved)
  }

  function parseApiRequest(request) {
    const method = String(request?.method || 'GET').toUpperCase()
    let url
    try {
      url = new URL(String(request?.path || ''), 'http://enterprise-managed-profile.local')
      // WHATWG URL preserves encoded path separators. Decode once before
      // classification so `/api/profiles%2Ffinance` cannot bypass the profile
      // boundary and be decoded later by the HTTP server/router.
      try {
        url.pathname = decodeURIComponent(url.pathname)
      } catch {
        // Keep the raw pathname. It still classifies as a profile route and
        // the segment decoder below will reject the malformed profile name.
      }
    } catch {
      url = null
    }
    return { method, url }
  }

  function rewrittenRequest(request, url) {
    return {
      ...request,
      path: `${url.pathname}${url.search}${url.hash}`
    }
  }

  function projectProfiles(response) {
    const profiles = Array.isArray(response?.profiles) ? response.profiles : []
    const primary = profiles.find(profile => profile?.is_default || String(profile?.name || '').trim() === 'default')
    if (!primary) return { ...response, profiles: [] }

    return {
      ...response,
      profiles: [{
        ...primary,
        is_default: true,
        name: publicKey(),
        path: currentIdentity.hermesHome || primary.path
      }]
    }
  }

  function projectProfileSessions(response) {
    const isPrimary = value => {
      const profile = String(value ?? '').trim()
      return !profile || profile === publicKey() || profile === managedKey()
    }
    // Never relabel an unexpected named-profile row as the managed primary:
    // that would disguise a backend isolation failure as valid data.
    const sessions = Array.isArray(response?.sessions)
      ? response.sessions
          .filter(session => isPrimary(session?.profile))
          .map(session => ({ ...session, profile: publicKey(), is_default_profile: true }))
      : []
    const total = sessions.length
    const errors = Array.isArray(response?.errors)
      ? response.errors
          .filter(error => isPrimary(error?.profile))
          .map(error => ({ ...error, profile: publicKey() }))
      : response?.errors

    return {
      ...response,
      ...(errors === undefined ? {} : { errors }),
      profile_totals: { [publicKey()]: total },
      sessions,
      total
    }
  }

  async function handleApiRequest(request, next) {
    if (typeof next !== 'function') throw new TypeError('Enterprise managed profile API boundary requires a next handler.')
    if (!active()) return next(request)

    // A profile supplied out-of-band must still identify the one managed
    // primary. This closes non-profile API routes that use request.profile to
    // select a pool or remote descriptor.
    resolve(request?.profile)

    const { method, url } = parseApiRequest(request)
    if (!url || !/^\/api\/profiles(?:[/?#]|$)/.test(url.pathname)) {
      return next(request)
    }

    if (url.pathname === '/api/profiles/active') {
      if (method !== 'GET') assertProfileMutation(`profile:${method.toLowerCase()}`, request?.path)
      return { active: publicKey(), current: publicKey() }
    }

    if (url.pathname === '/api/profiles/sessions') {
      if (method !== 'GET') assertProfileMutation(`profile:${method.toLowerCase()}`, request?.path)
      // The backend aggregate can scan every nested Hermes profile. Pin it to
      // the managed root profile and relabel only the resulting primary rows.
      url.searchParams.set('profile', publicKey())
      return projectProfileSessions(await next(rewrittenRequest(request, url)))
    }

    if (url.pathname === '/api/profiles') {
      if (method !== 'GET') assertProfileMutation(`profile:${method.toLowerCase()}`, request?.path)
      return projectProfiles(await next(request))
    }

    const match = url.pathname.match(/^\/api\/profiles\/([^/]+)(.*)$/)
    if (!match) {
      throw profileNotManagedError('profile:read', request?.path)
    }

    let requestedProfile
    try {
      requestedProfile = decodeURIComponent(match[1])
    } catch {
      throw profileNotManagedError('profile:read', match[1])
    }
    resolve(requestedProfile)

    if (method !== 'GET') {
      assertProfileMutation(`profile:${method.toLowerCase()}`, request?.path)
    }
    if (match[2] === '/setup-command' || match[2].startsWith('/setup-command/')) {
      throw profileNotManagedError(
        'profile:setup-command',
        requestedProfile,
        'Enterprise managed profile is launched only by the managed desktop runtime.'
      )
    }

    // Hermes sees this isolated HERMES_HOME as its native default profile. The
    // synthetic enterprise key is deliberately never passed to the backend.
    url.pathname = `/api/profiles/${publicKey()}${match[2]}`
    return next(rewrittenRequest(request, url))
  }

  return Object.freeze({
    assertProfileMutation,
    assertRemoteAllowed,
    bindIdentity,
    handleApiRequest,
    identity: getIdentity,
    isEnabled: active,
    managedConnectionConfig,
    managedKey,
    publicKey,
    resolve,
    runProfileOperation,
    setIdentity: bindIdentity
  })
}

module.exports = {
  DEFAULT_MANAGED_PROFILE_KEY,
  ENTERPRISE_PROFILE_NOT_MANAGED,
  MANAGED_PROFILE_ERROR_ENVELOPE,
  createEnterpriseManagedProfileGuard,
  managedUserId,
  profileIpcResult,
  profileNotManagedError,
  publicError,
  unwrapProfileIpcResult
}
