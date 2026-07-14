function parsedUrl(value) {
  try {
    return new URL(String(value || ''))
  } catch {
    return null
  }
}

function withoutViewState(url) {
  const normalized = new URL(url.toString())
  normalized.hash = ''
  normalized.search = ''
  return normalized
}

function isTrustedRendererUrl(rawUrl, { devServer, rendererEntryUrl } = {}) {
  const candidate = parsedUrl(rawUrl)
  if (!candidate) return false

  if (devServer) {
    const trustedDevServer = parsedUrl(devServer)
    if (!trustedDevServer) return false
    if (!['http:', 'https:'].includes(candidate.protocol)) return false
    if (!['http:', 'https:'].includes(trustedDevServer.protocol)) return false

    return candidate.origin === trustedDevServer.origin
  }

  const trustedEntry = parsedUrl(rendererEntryUrl)
  if (!trustedEntry || candidate.protocol !== 'file:' || trustedEntry.protocol !== 'file:') {
    return false
  }

  return withoutViewState(candidate).href === withoutViewState(trustedEntry).href
}

module.exports = {
  isTrustedRendererUrl
}
