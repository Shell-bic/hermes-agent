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
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]'
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

    if (signal?.aborted) {
      throw new EnterpriseGatewayError('Enterprise gateway request was canceled.', { code: 'request-canceled' })
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
    let abortKind = null
    let rejectAbort
    const abortPromise = new Promise((_, reject) => {
      rejectAbort = reject
    })
    const abortError = () =>
      new EnterpriseGatewayError(
        abortKind === 'timeout' ? 'Enterprise gateway request timed out.' : 'Enterprise gateway request was canceled.',
        { code: abortKind === 'timeout' ? 'gateway-timeout' : 'request-canceled' }
      )
    const abort = (kind, reason) => {
      if (abortKind) return
      abortKind = kind
      abortController.abort(reason)
      rejectAbort(abortError())
    }
    const abortFromCaller = () => abort('caller', signal?.reason)
    signal?.addEventListener?.('abort', abortFromCaller, { once: true })
    if (signal?.aborted) {
      abortFromCaller()
    }
    const timeout = setTimeout(() => abort('timeout'), this.timeoutMs)
    timeout.unref?.()

    let response
    let text
    try {
      if (abortKind) await abortPromise
      const request = (async () => {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: abortController.signal
        })
        text = await response.text()
      })()
      await Promise.race([request, abortPromise])
    } catch (error) {
      if (abortKind) throw abortError()
      if (error instanceof EnterpriseGatewayError) throw error
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
      const message =
        payload?.detail || payload?.message || payload?.error || `${response.status} ${response.statusText}`.trim()
      const code = payload?.code || payload?.errorCode || payload?.type || 'gateway-error'
      throw new EnterpriseGatewayError(`Enterprise gateway request failed: ${message}`, {
        code,
        status: response.status
      })
    }

    return payload
  }

  async requestRaw(path, { method = 'GET', signal, token } = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('Enterprise gateway client requires fetch.')
    }

    if (signal?.aborted) {
      throw new EnterpriseGatewayError('Enterprise gateway request was canceled.', { code: 'request-canceled' })
    }
    const url = `${this.baseUrl}${String(path || '').startsWith('/') ? path : '/' + path}`
    const abortController = new AbortController()
    let abortKind = null
    let reader = null
    let cleaned = false
    let timeout = null
    let rejectAbort
    const abortPromise = new Promise((_, reject) => {
      rejectAbort = reject
    })
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearTimeout(timeout)
      signal?.removeEventListener?.('abort', abortFromCaller)
    }
    const abortError = () =>
      new EnterpriseGatewayError(
        abortKind === 'timeout' ? 'Enterprise gateway request timed out.' : 'Enterprise gateway request was canceled.',
        { code: abortKind === 'timeout' ? 'gateway-timeout' : 'request-canceled' }
      )
    const abort = (kind, reason) => {
      if (abortKind) return
      abortKind = kind
      abortController.abort(reason)
      void reader?.cancel?.(reason).catch?.(() => undefined)
      rejectAbort(abortError())
      cleanup()
    }
    const abortFromCaller = () => abort('caller', signal?.reason)
    timeout = setTimeout(() => abort('timeout'), this.timeoutMs)
    timeout.unref?.()
    signal?.addEventListener?.('abort', abortFromCaller, { once: true })
    if (signal?.aborted) abortFromCaller()
    try {
      if (abortKind) await abortPromise
      const response = await Promise.race([
        this.fetchImpl(url, {
          method,
          headers: {
            Accept: 'application/zip',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          redirect: 'error',
          signal: abortController.signal
        }),
        abortPromise
      ])
      if (abortController.signal.aborted) throw abortError()
      if (!response.body?.getReader) {
        cleanup()
        return response
      }

      reader = response.body.getReader()
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const result = await Promise.race([reader.read(), abortPromise])
            if (abortController.signal.aborted) throw abortError()
            if (result.done) {
              cleanup()
              controller.close()
            } else {
              controller.enqueue(result.value)
            }
          } catch (error) {
            cleanup()
            controller.error(abortController.signal.aborted ? abortError() : error)
          }
        },
        async cancel(reason) {
          cleanup()
          await reader.cancel(reason).catch(() => undefined)
        }
      })
      return new Response(body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText
      })
    } catch (error) {
      cleanup()
      if (abortKind) throw abortError()
      if (error instanceof EnterpriseGatewayError) throw error
      throw new EnterpriseGatewayError('Enterprise gateway is unavailable.', { code: 'gateway-offline' })
    }
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

  skillHubSkills(token, query = {}, { signal } = {}) {
    const params = new URLSearchParams()
    const q = String(query.q || '').trim()
    const category = String(query.category || '').trim()
    if (q) params.set('q', q)
    if (category) params.set('category', category)
    if (query.page != null) params.set('page', String(query.page))
    if (query.pageSize != null) params.set('pageSize', String(query.pageSize))
    const suffix = params.size ? `?${params}` : ''
    return this.requestJson(`/api/desktop/skill-hub/skills${suffix}`, { signal, token })
  }

  skillHubSkill(token, key, { signal } = {}) {
    const encodedKey = encodeURIComponent(String(key || '').trim())
    return this.requestJson(`/api/desktop/skill-hub/skills/${encodedKey}`, { signal, token })
  }

  downloadSkillPackage(token, key, revision, { signal } = {}) {
    const encodedKey = encodeURIComponent(String(key || '').trim())
    const encodedRevision = encodeURIComponent(String(revision || '').trim())
    return this.requestRaw(`/api/desktop/skill-hub/skills/${encodedKey}/packages/${encodedRevision}/download`, {
      signal,
      token
    })
  }

  createSkillInstallOperation(token, body, { signal } = {}) {
    if (!String(token || '').startsWith('dsk_')) {
      throw new EnterpriseGatewayError('A desktop session is required to create an install operation.', {
        code: 'desktop_session_required',
        status: 401
      })
    }
    return this.requestJson('/api/desktop/skill-hub/install-operations', {
      method: 'POST',
      body,
      signal,
      token
    })
  }

  commitSkillInstallOperation(token, operationId, { signal } = {}) {
    if (!String(token || '').startsWith('dsk_')) {
      throw new EnterpriseGatewayError('A desktop session is required to commit an install operation.', {
        code: 'desktop_session_required',
        status: 401
      })
    }
    const encodedId = encodeURIComponent(String(operationId || '').trim())
    return this.requestJson(`/api/desktop/skill-hub/install-operations/${encodedId}/commit`, {
      method: 'POST',
      signal,
      token
    })
  }

  getSkillInstallOperation(operationId, { reconciliationToken, signal, token } = {}) {
    const credential = String(reconciliationToken || token || '').trim()
    if (!credential.startsWith('srt_') && !credential.startsWith('dsk_')) {
      throw new EnterpriseGatewayError('Install operation reconciliation requires an operation credential.', {
        code: 'install_operation_not_found',
        status: 404
      })
    }
    const encodedId = encodeURIComponent(String(operationId || '').trim())
    return this.requestJson(`/api/desktop/skill-hub/install-operations/${encodedId}`, {
      signal,
      token: credential
    })
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
