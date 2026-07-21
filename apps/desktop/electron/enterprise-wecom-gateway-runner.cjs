const RUNTIME_CONFIG_VERSION = 'wecom-bot-runtime-config.v2'
const RUNTIME_CONTROL_CONTRACT_VERSION = 'enterprise-wecom-runtime-control.v1'
const IDENTITY_CONTRACT_VERSION = 'wecom-channel-identity.v1'
const IDENTITY_PROOF_VERSION = 'hermes-channel-identity-v2'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requiredString(value, field, maximum) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maximum || [...normalized].some(character => character.charCodeAt(0) < 32)) {
    const error = new Error(`Enterprise WeCom Bot runtime config field ${field} is invalid.`)
    error.code = 'wecom-runtime-config-invalid'
    throw error
  }
  return normalized
}

function validateRuntimeConfig(value, bindingId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.contractVersion !== RUNTIME_CONFIG_VERSION) {
    const error = new Error('Enterprise WeCom Bot runtime config response is invalid.')
    error.code = 'wecom-runtime-config-invalid'
    throw error
  }

  const normalizedBindingId = requiredString(value.bindingId, 'bindingId', 128)
  if (normalizedBindingId !== bindingId) {
    const error = new Error('Enterprise WeCom Bot runtime config binding does not match the requested binding.')
    error.code = 'wecom-runtime-config-binding-mismatch'
    throw error
  }

  requiredString(value.credentialVersion, 'credentialVersion', 128)
  const corpId = requiredString(value.corpId, 'corpId', 128)
  const botId = requiredString(value.botId, 'botId', 256)
  const secret = requiredString(value.secret, 'secret', 512)
  if (value.dmPolicy !== 'open' || value.groupPolicy !== 'open' ||
      !Array.isArray(value.allowedUserIds) || value.allowedUserIds.length !== 0 ||
      value.identityContractVersion !== IDENTITY_CONTRACT_VERSION ||
      value.identityProofVersion !== IDENTITY_PROOF_VERSION) {
    const error = new Error('Enterprise WeCom Bot runtime config access or identity policy is invalid.')
    error.code = 'wecom-runtime-config-policy-invalid'
    throw error
  }

  return {
    bindingId: normalizedBindingId,
    botId,
    corpId,
    identityContractVersion: value.identityContractVersion,
    identityProofVersion: value.identityProofVersion,
    secret
  }
}

function validateDesktopHostedBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.contractVersion !== 'wecom-bot-binding.v1' ||
      typeof value.bindingId !== 'string' || !UUID_PATTERN.test(value.bindingId) ||
      typeof value.status !== 'string') {
    const error = new Error('Enterprise WeCom Bot binding response is invalid for Desktop-hosted runtime.')
    error.code = 'wecom-runtime-binding-invalid'
    throw error
  }
  return value
}

class EnterpriseWeComGatewayRunnerExperiment {
  constructor({ client, enabled = false, gatewayBaseUrl, getDesktopToken, getGatewayServiceToken, runtimeControl } = {}) {
    this.client = client
    this.enabled = enabled === true
    this.gatewayBaseUrl = gatewayBaseUrl
    this.getDesktopToken = getDesktopToken
    this.getGatewayServiceToken = getGatewayServiceToken
    this.runtimeControl = runtimeControl
  }

  isEnabled() {
    return this.enabled
  }

  token() {
    const token = String(this.getDesktopToken?.() || '').trim()
    if (!token) {
      const error = new Error('Enterprise sign-in is required before starting the WeCom GatewayRunner experiment.')
      error.code = 'enterprise-auth-required'
      throw error
    }
    return token
  }

  async currentBinding() {
    if (!this.enabled) return null
    try {
      return validateDesktopHostedBinding(await this.client.currentWeComPersonalBotBinding(this.token()))
    } catch (error) {
      if (error?.status === 404) return null
      throw error
    }
  }

  async attach(binding = null) {
    if (!this.enabled) return { bindingId: null, connected: false, state: 'detached' }
    const current = binding ? validateDesktopHostedBinding(binding) : await this.currentBinding()
    if (!current || current.status !== 'connected') {
      return this.runtimeControl.status()
    }

    let runtimeConfig
    try {
      runtimeConfig = validateRuntimeConfig(
        await this.client.weComPersonalBotRuntimeConfig(this.token(), current.bindingId),
        current.bindingId
      )
    } catch (error) {
      if (error?.status === 403 && error?.code === 'bot_runtime_config_owner_mismatch') {
        return this.runtimeControl.status()
      }
      throw error
    }

    const gatewayServiceToken = requiredString(this.getGatewayServiceToken?.(), 'gatewayServiceToken', 2048)
    const gatewayBaseUrl = requiredString(this.gatewayBaseUrl, 'gatewayBaseUrl', 2048)
    try {
      return await this.runtimeControl.attach({
        contractVersion: RUNTIME_CONTROL_CONTRACT_VERSION,
        gatewayBaseUrl,
        gatewayServiceToken,
        ...runtimeConfig
      })
    } finally {
      runtimeConfig.secret = ''
    }
  }

  detach(bindingId = null) {
    if (!this.enabled) return Promise.resolve({ bindingId: null, connected: false, state: 'detached' })
    return this.runtimeControl.detach(bindingId)
  }

  status() {
    if (!this.enabled) return Promise.resolve({ bindingId: null, connected: false, state: 'detached' })
    return this.runtimeControl.status()
  }
}

function createEnterpriseWeComGatewayRunnerExperiment(options) {
  return new EnterpriseWeComGatewayRunnerExperiment(options)
}

function scrubWeComChildEnv(env) {
  if (!env || typeof env !== 'object') return
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('WECOM_')) delete env[key]
  }
}

module.exports = {
  EnterpriseWeComGatewayRunnerExperiment,
  IDENTITY_CONTRACT_VERSION,
  IDENTITY_PROOF_VERSION,
  RUNTIME_CONFIG_VERSION,
  createEnterpriseWeComGatewayRunnerExperiment,
  scrubWeComChildEnv,
  validateDesktopHostedBinding,
  validateRuntimeConfig
}
