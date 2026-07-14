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

  const hostname = parsed.hostname.toLowerCase()
  const isLoopback =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw new Error('Enterprise gateway URL must use https:// unless it points to localhost.')
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

class EnterpriseGatewayError extends Error {
  constructor(message, { code = 'gateway-error', status = 0 } = {}) {
    super(message)
    this.name = 'EnterpriseGatewayError'
    this.code = String(code || 'gateway-error')
    this.status = Number(status) || 0
  }
}

const ENTERPRISE_LOGIN_METHODS = new Set(['password', 'wecom-qr'])

function normalizeLoginMethodsResponse(payload) {
  const rawMethods = Array.isArray(payload?.methods) ? payload.methods : []
  const methods = []

  for (const rawMethod of rawMethods) {
    const id = String(typeof rawMethod === 'string' ? rawMethod : rawMethod?.id || '').trim()
    const enabled = typeof rawMethod === 'string' ? true : rawMethod?.enabled === true

    if (enabled && ENTERPRISE_LOGIN_METHODS.has(id) && !methods.includes(id)) {
      methods.push(id)
    }
  }

  const requestedDefault = String(payload?.defaultMethod || '').trim()
  const defaultMethod = methods.includes(requestedDefault) ? requestedDefault : methods[0] || null

  return {
    defaultMethod,
    enterpriseDisplayName: String(payload?.enterpriseDisplayName || payload?.companyDisplayName || '').trim() || null,
    methods,
    weComAuthorizationOrigin: String(payload?.weComAuthorizationOrigin || '').trim() || null
  }
}

class EnterpriseGatewayClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.baseUrl = normalizeEnterpriseGatewayBaseUrl(baseUrl)
    this.fetchImpl = fetchImpl
    this.timeoutMs = Math.max(100, Number(timeoutMs) || 10000)
  }

  async requestJson(path, { method = 'GET', body, signal, token } = {}) {
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

    const abortController = new AbortController()
    let timedOut = false
    const abortFromCaller = () => abortController.abort(signal?.reason)
    signal?.addEventListener?.('abort', abortFromCaller, { once: true })
    if (signal?.aborted) {
      abortFromCaller()
    }
    const timeout = setTimeout(() => {
      timedOut = true
      abortController.abort()
    }, this.timeoutMs)
    timeout.unref?.()

    let response
    let text
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abortController.signal
      })
      text = await response.text()
    } catch {
      if (abortController.signal.aborted) {
        throw new EnterpriseGatewayError(
          timedOut ? 'Enterprise gateway request timed out.' : 'Enterprise gateway request was canceled.',
          { code: timedOut ? 'gateway-timeout' : 'request-canceled' }
        )
      }
      throw new EnterpriseGatewayError('Enterprise gateway is unavailable.', {
        code: 'gateway-offline'
      })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener?.('abort', abortFromCaller)
    }

    let payload = null

    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { message: text }
      }
    }

    if (!response.ok) {
      const message = payload?.detail || payload?.message || payload?.error || `${response.status} ${response.statusText}`.trim()
      const code = payload?.code || payload?.errorCode || payload?.type || 'gateway-error'
      throw new EnterpriseGatewayError(`Enterprise gateway request failed: ${message}`, {
        code,
        status: response.status
      })
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

  async loginMethods() {
    return normalizeLoginMethodsResponse(await this.requestJson('/api/desktop/auth/methods'))
  }

  async startWeCom({ challenge, signal } = {}) {
    const normalizedChallenge = String(challenge || '').trim()
    if (!normalizedChallenge) {
      throw new Error('Enterprise WeCom challenge is required.')
    }

    return this.requestJson('/api/desktop/auth/wecom/start', {
      method: 'POST',
      body: { challenge: normalizedChallenge },
      signal
    })
  }

  weComStatus(transactionId, { signal } = {}) {
    const id = String(transactionId || '').trim()
    if (!id) {
      throw new Error('Enterprise WeCom transaction is required.')
    }

    return this.requestJson(`/api/desktop/auth/wecom/status/${encodeURIComponent(id)}`, { signal })
  }

  async redeemWeCom({ signal, transactionId, verifier } = {}) {
    const id = String(transactionId || '').trim()
    const normalizedVerifier = String(verifier || '').trim()
    if (!id || !normalizedVerifier) {
      throw new Error('Enterprise WeCom transaction and verifier are required.')
    }

    return normalizeLoginResponse(
      await this.requestJson('/api/desktop/auth/wecom/redeem', {
        method: 'POST',
        body: { transactionId: id, verifier: normalizedVerifier },
        signal
      })
    )
  }

  cancelWeCom(transactionId) {
    const id = String(transactionId || '').trim()
    if (!id) {
      throw new Error('Enterprise WeCom transaction is required.')
    }

    return this.requestJson('/api/desktop/auth/wecom/cancel', {
      method: 'POST',
      body: { transactionId: id }
    })
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
  ENTERPRISE_LOGIN_METHODS,
  EnterpriseGatewayError,
  EnterpriseGatewayClient,
  createEnterpriseGatewayClient,
  normalizeLoginMethodsResponse,
  normalizeEnterpriseGatewayBaseUrl,
  normalizeLoginResponse,
  pickDesktopToken
}
