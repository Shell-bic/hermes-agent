function profileNameFromDeleteRequest(request) {
  if (!request || String(request.method || 'GET').toUpperCase() !== 'DELETE') return null

  const match = String(request.path || '').match(/^\/api\/profiles\/([^/?#]+)(?:[?#].*)?$/)
  if (!match) return null

  try {
    const name = decodeURIComponent(match[1]).trim()
    return name ? name.toLowerCase() : null
  } catch {
    return null
  }
}

function createProfileDeleteCoordinator(options = {}) {
  const {
    assertProfileMutation,
    isManaged,
    isValidProfileName,
    primaryProfileKey,
    teardownPoolBackendAndWait,
    teardownPrimaryBackendAndWait,
    writeActiveDesktopProfile
  } = options

  return function prepareProfileDeleteRequest(request, active) {
    const profile = profileNameFromDeleteRequest(request)
    if (isManaged?.() && profile) assertProfileMutation?.('profile:delete', request?.path)
    if (!profile || profile === 'default' || !isValidProfileName?.(profile)) return null

    return async function commitProfileDelete() {
      active?.checkpoint()
      if (profile === primaryProfileKey?.()) {
        writeActiveDesktopProfile?.('default')
        await teardownPrimaryBackendAndWait?.()
      } else {
        await teardownPoolBackendAndWait?.(profile)
      }
      active?.checkpoint()
    }
  }
}

module.exports = { createProfileDeleteCoordinator, profileNameFromDeleteRequest }
