function normalizeEnterpriseGatewayBaseUrl(rawUrl) {
  const value = String(rawUrl || '').trim()

  if (!value) {
    throw new Error('Enterprise gateway URL is required.')
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new Error(`Enterprise gateway URL is not valid: ${error.message}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Enterprise gateway URL must be http:// or https://, got ${parsed.protocol}`)
  }

  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')

  return parsed.toString().replace(/\/+$/, '')
}

function pickDesktopToken(payload) {
  if (!payload || typeof payload !== 'object') {
    return ''
  }

  return String(payload.desktopToken || payload.accessToken || payload.sessionToken || payload.token || '').trim()
}

function normalizeLoginResponse(payload) {
  const desktopToken = pickDesktopToken(payload)

  if (!desktopToken) {
    throw new Error('Enterprise login response did not include a desktop token.')
  }

  return {
    desktopToken,
    expiresAt: payload.expiresAt || payload.expires_at || null,
    user: payload.user || payload.account || null
  }
}

class EnterpriseGatewayClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = normalizeEnterpriseGatewayBaseUrl(baseUrl)
    this.fetchImpl = fetchImpl
  }

  async requestJson(path, { method = 'GET', body, token } = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('Enterprise gateway client requires fetch.')
    }

    const url = `${this.baseUrl}${String(path || '').startsWith('/') ? path : '/' + path}`
    const headers = { Accept: 'application/json' }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })

    const text = await response.text()
    let payload = null

    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { message: text }
      }
    }

    if (!response.ok) {
      const message = payload?.message || payload?.error || `${response.status} ${response.statusText}`.trim()
      const error = new Error(`Enterprise gateway request failed: ${message}`)
      error.code = payload?.code || payload?.errorCode || 'enterprise_gateway_request_failed'
      error.status = response.status
      throw error
    }

    return payload
  }

  requestRaw(path, { method = 'GET', token } = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('Enterprise gateway client requires fetch.')
    }

    const url = `${this.baseUrl}${String(path || '').startsWith('/') ? path : '/' + path}`
    return this.fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/zip',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    })
  }

  async login({ password, username } = {}) {
    const user = String(username || '').trim()

    if (!user) {
      throw new Error('Enterprise username is required.')
    }

    if (!password) {
      throw new Error('Enterprise password is required.')
    }

    return normalizeLoginResponse(
      await this.requestJson('/api/desktop/auth/login', {
        method: 'POST',
        body: { username: user, password }
      })
    )
  }

  me(token) {
    return this.requestJson('/api/desktop/auth/me', { token })
  }

  logout(token) {
    return this.requestJson('/api/desktop/auth/logout', { method: 'POST', token })
  }

  bootstrap(token) {
    return this.requestJson('/api/desktop/bootstrap', { token })
  }

  modelProfiles(token) {
    return this.requestJson('/api/desktop/model-profiles', { token })
  }

  runtimeManifest(token, body = {}) {
    return this.requestJson('/api/desktop/runtime/manifests', {
      method: 'POST',
      body,
      token
    })
  }

  skillHubSkills(token, query = {}) {
    const params = new URLSearchParams()
    const q = String(query.q || '').trim()
    const category = String(query.category || '').trim()
    if (q) params.set('q', q)
    if (category) params.set('category', category)
    if (query.page != null) params.set('page', String(query.page))
    if (query.pageSize != null) params.set('pageSize', String(query.pageSize))
    const suffix = params.size ? `?${params}` : ''
    return this.requestJson(`/api/desktop/skill-hub/skills${suffix}`, { token })
  }

  skillHubSkill(token, key) {
    const encodedKey = encodeURIComponent(String(key || '').trim())
    return this.requestJson(`/api/desktop/skill-hub/skills/${encodedKey}`, { token })
  }

  downloadSkillPackage(token, key, revision) {
    const encodedKey = encodeURIComponent(String(key || '').trim())
    const encodedRevision = encodeURIComponent(String(revision || '').trim())
    return this.requestRaw(
      `/api/desktop/skill-hub/skills/${encodedKey}/packages/${encodedRevision}/download`,
      { token }
    )
  }
}

function createEnterpriseGatewayClient(options) {
  return new EnterpriseGatewayClient(options)
}

module.exports = {
  EnterpriseGatewayClient,
  createEnterpriseGatewayClient,
  normalizeEnterpriseGatewayBaseUrl,
  normalizeLoginResponse,
  pickDesktopToken
}
