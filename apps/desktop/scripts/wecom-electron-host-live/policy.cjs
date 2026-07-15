const { OFFICIAL_AUTH_ORIGIN, OFFICIAL_AUTH_PATH, exactSingleSearchKey } = require('./protocol.cjs')

function parseUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isAllowedMainNavigation(candidate, start) {
  const url = parseUrl(candidate)
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash ||
      url.origin !== start.gatewayOrigin || url.pathname !== start.authorizationPath) return false
  return url.href === start.authorizationUrl
}

function isAllowedMainHistorySanitization(candidate, start, context) {
  if (context?.isMainFrame !== true || context?.initialLoadCompleted !== true || context?.alreadySanitized === true ||
      context?.previousUrl !== start.authorizationUrl) return false
  const url = parseUrl(candidate)
  return Boolean(url && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
    url.origin === start.gatewayOrigin && url.pathname === start.authorizationPath &&
    url.href === `${start.gatewayOrigin}${start.authorizationPath}`)
}

function isAllowedOfficialPopup(candidate, start, authOrigin = OFFICIAL_AUTH_ORIGIN, authPath = OFFICIAL_AUTH_PATH) {
  const url = parseUrl(candidate)
  if (!url || url.origin !== authOrigin || url.pathname !== authPath || url.hash ||
      url.username || url.password) return false
  const keys = Array.from(url.searchParams.keys())
  if (keys.length !== 3 || new Set(keys).size !== 3 || !['source', 'state', 'timestamp'].every(key => keys.includes(key))) return false
  return url.searchParams.getAll('source').length === 1 && /^[A-Za-z0-9._-]{1,128}$/u.test(url.searchParams.get('source') || '') &&
    url.searchParams.getAll('state').length === 1 && url.searchParams.get('state') === start.state &&
    url.searchParams.getAll('timestamp').length === 1 && /^\d{10,16}$/u.test(url.searchParams.get('timestamp') || '')
}

function isAllowedPopupNavigation(candidate, acceptedPopupUrl, authOrigin = OFFICIAL_AUTH_ORIGIN, authPath = OFFICIAL_AUTH_PATH) {
  const url = parseUrl(candidate)
  const initial = parseUrl(acceptedPopupUrl)
  if (!url || !initial || url.origin !== authOrigin || url.pathname !== authPath || url.hash ||
      url.username || url.password) return false
  return url.href === initial.href
}

function shouldBlockRedirect() {
  return true
}

function rendererFailureCode(loadCompleted, initialLoadFailureCode, unresponsive = false) {
  if (!loadCompleted) return initialLoadFailureCode
  return unresponsive ? 'renderer_unresponsive' : 'renderer_crashed'
}

module.exports = {
  isAllowedMainNavigation,
  isAllowedMainHistorySanitization,
  isAllowedOfficialPopup,
  isAllowedPopupNavigation,
  parseUrl,
  rendererFailureCode,
  shouldBlockRedirect
}
