const RUNTIME_CONTROL_CONTRACT_VERSION = 'enterprise-wecom-runtime-control.v1'
const RUNTIME_CONTROL_HEADER = 'X-Hermes-Enterprise-Runtime-Token'
const RUNTIME_STATES = new Set(['detached', 'connecting', 'connected', 'error'])

function runtimeControlError(message, code = 'wecom-runtime-control-invalid') {
  const error = new Error(message)
  error.code = code
  return error
}

function validateRuntimeStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.contractVersion !== RUNTIME_CONTROL_CONTRACT_VERSION || !RUNTIME_STATES.has(value.state) ||
      (value.bindingId !== null && typeof value.bindingId !== 'string') ||
      typeof value.connected !== 'boolean' || (value.errorCode !== null && typeof value.errorCode !== 'string') ||
      (value.errorMessage !== null && typeof value.errorMessage !== 'string')) {
    throw runtimeControlError('Hermes WeCom runtime control response is invalid.')
  }
  return {
    bindingId: value.bindingId,
    connected: value.connected,
    contractVersion: value.contractVersion,
    errorCode: value.errorCode,
    errorMessage: value.errorMessage,
    state: value.state
  }
}

class EnterpriseWeComRuntimeControlClient {
  constructor({ fetchImpl = globalThis.fetch, getConnection, getRuntimeToken, timeoutMs = 10_000 } = {}) {
    this.fetchImpl = fetchImpl
    this.getConnection = getConnection
    this.getRuntimeToken = getRuntimeToken
    this.timeoutMs = Math.max(100, Number(timeoutMs) || 10_000)
  }

  async request(pathname, { body, method = 'GET' } = {}) {
    const connection = await this.getConnection?.()
    const baseUrl = String(connection?.baseUrl || '').replace(/\/+$/, '')
    const runtimeToken = String(this.getRuntimeToken?.() || '').trim()
    if (!baseUrl || !runtimeToken) {
      throw runtimeControlError('Hermes WeCom runtime control is unavailable.', 'wecom-runtime-control-unavailable')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    let response
    try {
      response = await this.fetchImpl(`${baseUrl}${pathname}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          [RUNTIME_CONTROL_HEADER]: runtimeToken
        },
        method,
        signal: controller.signal
      })
    } catch (error) {
      throw runtimeControlError(
        error?.name === 'AbortError' ? 'Hermes WeCom runtime control timed out.' : 'Hermes WeCom runtime control is offline.',
        error?.name === 'AbortError' ? 'wecom-runtime-control-timeout' : 'wecom-runtime-control-offline'
      )
    } finally {
      clearTimeout(timer)
    }

    let payload = null
    try {
      payload = await response.json()
    } catch {
      // The public error deliberately does not copy arbitrary backend text.
    }
    if (!response.ok) {
      throw runtimeControlError('Hermes WeCom runtime control rejected the operation.',
        String(payload?.errorCode || payload?.code || 'wecom-runtime-control-rejected'))
    }
    return validateRuntimeStatus(payload)
  }

  attach(config) {
    return this.request('/api/enterprise/wecom/attach', { body: config, method: 'POST' })
  }

  detach(bindingId = null) {
    const normalized = typeof bindingId === 'string' && bindingId.trim() ? bindingId.trim() : null
    return this.request('/api/enterprise/wecom/detach', {
      body: normalized ? { bindingId: normalized, contractVersion: RUNTIME_CONTROL_CONTRACT_VERSION } : undefined,
      method: 'POST'
    })
  }

  status() {
    return this.request('/api/enterprise/wecom/status')
  }
}

function createEnterpriseWeComRuntimeControlClient(options) {
  return new EnterpriseWeComRuntimeControlClient(options)
}

module.exports = {
  EnterpriseWeComRuntimeControlClient,
  RUNTIME_CONTROL_CONTRACT_VERSION,
  RUNTIME_CONTROL_HEADER,
  createEnterpriseWeComRuntimeControlClient,
  validateRuntimeStatus
}
