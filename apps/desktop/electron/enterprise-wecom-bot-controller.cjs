const {
  BOT_TRANSACTION_VERSION,
  MESSAGING_CHANNEL_POLICY_CAPABILITY,
  parseRfc3339DateTime,
  validateCreateWeComBotTransactionRequest,
  validateWeComBotBinding,
  validateWeComBotTransaction
} = require('./wecom-personal-bot-contract.cjs')

const TERMINAL_TRANSACTION_STATES = new Set(['denied', 'expired', 'canceled', 'error'])
const CLAIM_STATUSES = new Set(['pending', 'expired', 'locked'])
const IDENTITY_CONTRACT_VERSION = 'wecom-channel-identity.v1'
const BINDING_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function invalidIdentityResponse() {
  const error = new Error('Enterprise WeCom channel identity response is invalid.')
  error.code = 'identity-response-invalid'
  return error
}

function validateIdentityClaim(value, bindingId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.contractVersion !== IDENTITY_CONTRACT_VERSION || typeof value.claimId !== 'string' ||
      value.bindingId !== bindingId || !/^\d{6}$/.test(value.code) ||
      parseRfc3339DateTime(value.expiresAt) === null || !CLAIM_STATUSES.has(value.status) ||
      !Number.isInteger(value.failedAttempts) || value.failedAttempts < 0) {
    throw invalidIdentityResponse()
  }
  return {
    bindingId: value.bindingId,
    claimId: value.claimId,
    code: value.code,
    contractVersion: value.contractVersion,
    expiresAt: value.expiresAt,
    failedAttempts: value.failedAttempts,
    status: value.status
  }
}

function validateIdentityLink(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.contractVersion !== IDENTITY_CONTRACT_VERSION || typeof value.linkId !== 'string' ||
      typeof value.desktopUserId !== 'string' || typeof value.userName !== 'string' ||
      (value.displayName !== null && typeof value.displayName !== 'string') ||
      typeof value.channelUserIdHint !== 'string' || typeof value.verificationMethod !== 'string' ||
      typeof value.sourceBindingId !== 'string' || !BINDING_ID_PATTERN.test(value.sourceBindingId) ||
      parseRfc3339DateTime(value.verifiedAt) === null) {
    throw invalidIdentityResponse()
  }
  return {
    channelUserIdHint: value.channelUserIdHint,
    contractVersion: value.contractVersion,
    displayName: value.displayName,
    linkId: value.linkId,
    sourceBindingId: value.sourceBindingId,
    userName: value.userName,
    verificationMethod: value.verificationMethod,
    verifiedAt: value.verifiedAt
  }
}

function publicIdentityLink(link) {
  if (!link) return null
  // sourceBindingId is needed to select the current Bot link in main, but must
  // never cross preload alongside corpId, botId or a raw channel actor.
  return {
    channelUserIdHint: link.channelUserIdHint,
    contractVersion: link.contractVersion,
    displayName: link.displayName,
    linkId: link.linkId,
    userName: link.userName,
    verificationMethod: link.verificationMethod,
    verifiedAt: link.verifiedAt
  }
}

function publicIdentity(identity) {
  return {
    ...identity,
    link: publicIdentityLink(identity?.link)
  }
}

function validateIdentityLinks(value) {
  if (!Array.isArray(value)) throw invalidIdentityResponse()
  return value.map(validateIdentityLink)
}

function publicBinding(binding) {
  if (!binding) return null
  return {
    bindingId: binding.bindingId,
    createdAt: binding.createdAt,
    displayName: binding.displayName,
    updatedAt: binding.updatedAt
  }
}

function initialState() {
  return {
    authorizationPending: false,
    binding: null,
    channel: {
      errorCode: null,
      localStopped: false,
      serverRevokePending: false,
      status: 'unbound'
    },
    identity: {
      claim: null,
      errorCode: null,
      link: null,
      status: 'unverified'
    },
    transaction: null
  }
}

function channelStatusForBinding(binding, runtimeState) {
  if (!binding) return 'unbound'
  if (binding.status === 'revoked') return 'revoked'
  if (runtimeState === 'connected') return 'connected'
  if (runtimeState === 'connecting') return 'connecting'
  if (runtimeState === 'error') return 'error'
  if (binding.status === 'connecting' || binding.status === 'pending-owner-verification') return 'connecting'
  if (binding.status === 'connected') return 'offline'
  return binding.connectionStatus === 'error' ? 'error' : 'offline'
}

class EnterpriseWeComBotController {
  constructor({ client, desktopHostedRuntime = false, getDesktopToken, onBeforeBotRevoke = async () => {},
    onBindingCompleted = async () => null, onState = () => {}, pollIntervalMs = 1500,
    setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, view } = {}) {
    this.client = client
    this.desktopHostedRuntime = desktopHostedRuntime === true
    this.getDesktopToken = getDesktopToken
    this.onBeforeBotRevoke = onBeforeBotRevoke
    this.onBindingCompleted = onBindingCompleted
    this.onState = onState
    this.pollIntervalMs = pollIntervalMs
    this.setIntervalImpl = setIntervalImpl
    this.clearIntervalImpl = clearIntervalImpl
    this.view = view
    this.state = initialState()
    this.runtimeState = 'detached'
    this.runtimeBindingId = null
    this.pollTimer = null
    this.polling = false
    this.attaching = null
  }

  publicState() {
    return JSON.parse(JSON.stringify({
      authorizationPending: this.state.authorizationPending,
      binding: publicBinding(this.state.binding),
      channel: this.state.channel,
      identity: publicIdentity(this.state.identity)
    }))
  }

  update(patch) {
    this.state = { ...this.state, ...patch }
    const value = this.publicState()
    this.onState(value)
    return value
  }

  updateChannel(patch) {
    return this.update({ channel: { ...this.state.channel, ...patch } })
  }

  updateIdentity(patch) {
    return this.update({ identity: { ...this.state.identity, ...patch } })
  }

  token() {
    const token = String(this.getDesktopToken?.() || '').trim()
    if (!token) {
      const error = new Error('Enterprise sign-in is required before binding a WeCom Bot.')
      error.code = 'enterprise-auth-required'
      throw error
    }
    return token
  }

  async identityState(binding) {
    let links
    try {
      links = validateIdentityLinks(await this.client.weComPersonalBotChannelIdentities(this.token()))
    } catch (error) {
      return { ...this.state.identity, errorCode: error?.code || 'identity-unavailable' }
    }
    const exactLink = links.find(link => link.sourceBindingId === binding.bindingId)
    if (exactLink) {
      return { claim: null, errorCode: null, link: exactLink, status: 'verified' }
    }

    let claim
    try {
      claim = validateIdentityClaim(
        await this.client.weComPersonalBotIdentityClaim(this.token(), binding.bindingId),
        binding.bindingId
      )
    } catch (error) {
      if (error?.status !== 404 || error?.code !== 'identity_claim_not_found') {
        return { claim: null, errorCode: error?.code || 'identity-unavailable', link: null, status: 'unverified' }
      }
      try {
        claim = validateIdentityClaim(
          await this.client.issueWeComPersonalBotIdentityClaim(this.token(), binding.bindingId),
          binding.bindingId
        )
      } catch (issueError) {
        return {
          claim: null,
          errorCode: issueError?.code || 'identity-claim-unavailable',
          link: null,
          status: issueError?.code === 'identity_claim_conflict' ? 'conflict' : 'unverified'
        }
      }
    }
    return {
      claim,
      errorCode: null,
      link: null,
      status: claim.status === 'pending' ? 'pending' : claim.status
    }
  }

  async ensureRuntime(binding) {
    if (!this.desktopHostedRuntime || binding.status !== 'connected') return null
    if (this.runtimeState === 'connected' && this.runtimeBindingId === binding.bindingId) {
      return { bindingId: binding.bindingId, connected: true, state: 'connected' }
    }
    if (!this.attaching) {
      this.attaching = Promise.resolve(this.onBindingCompleted(binding)).finally(() => {
        this.attaching = null
      })
    }
    const runtime = await this.attaching
    if (runtime?.state) {
      this.runtimeState = runtime.state
      this.runtimeBindingId = runtime.bindingId || null
    }
    return runtime
  }

  async refresh() {
    let binding
    try {
      binding = validateWeComBotBinding(
        await this.client.currentWeComPersonalBotBinding(this.token()),
        { allowDesktopHostedOffline: this.desktopHostedRuntime }
      )
    } catch (error) {
      if (error?.status === 404) {
        if (this.state.transaction) {
          return this.update({ authorizationPending: true, binding: null })
        }
        return this.update(initialState())
      }
      return this.updateChannel({ errorCode: error?.code || 'gateway-offline', status: 'error' })
    }

    let runtimeError = null
    try {
      await this.ensureRuntime(binding)
    } catch (error) {
      this.runtimeState = 'error'
      runtimeError = error?.code || 'runtime-attach-failed'
    }
    const identity = binding.status === 'connected'
      ? await this.identityState(binding)
      : this.state.identity
    const channel = {
      errorCode: runtimeError || binding.errorCode || null,
      localStopped: false,
      serverRevokePending: false,
      status: channelStatusForBinding(binding, this.runtimeState)
    }
    const state = this.update({ authorizationPending: false, binding, channel, identity })
    if (state.channel.status === 'connected') await this.view?.destroy()
    return state
  }

  async start() {
    this.stopPolling()
    this.runtimeState = 'detached'
    this.runtimeBindingId = null
    this.update({
      authorizationPending: false,
      binding: null,
      channel: { errorCode: null, localStopped: false, serverRevokePending: false, status: 'authorizing' },
      identity: initialState().identity,
      transaction: null
    })
    try {
      const request = validateCreateWeComBotTransactionRequest({
        clientCapabilities: [MESSAGING_CHANNEL_POLICY_CAPABILITY],
        contractVersion: BOT_TRANSACTION_VERSION
      })
      const transaction = validateWeComBotTransaction(
        await this.client.createWeComPersonalBotTransaction(this.token(), request)
      )
      this.update({ authorizationPending: true, transaction })
      await this.view.open(transaction.authorizationUrl)
      this.startPolling()
      return this.publicState()
    } catch (error) {
      await this.view?.destroy()
      if (error?.code === 'bot_binding_exists' && error?.status === 409) return this.refresh()
      return this.updateChannel({ errorCode: error?.code || 'gateway-offline', status: 'error' })
    }
  }

  startPolling() {
    this.stopPolling()
    this.pollTimer = this.setIntervalImpl(() => void this.poll(), this.pollIntervalMs)
    this.pollTimer?.unref?.()
  }

  stopPolling() {
    if (this.pollTimer) this.clearIntervalImpl(this.pollTimer)
    this.pollTimer = null
  }

  async poll() {
    if (this.polling) return this.publicState()
    this.polling = true
    try {
      const active = this.state.transaction
      if (active) {
        const transaction = validateWeComBotTransaction(
          await this.client.weComPersonalBotTransaction(this.token(), active.transactionId)
        )
        this.update({ transaction })
        if (TERMINAL_TRANSACTION_STATES.has(transaction.status)) {
          this.stopPolling()
          await this.view?.destroy()
          return this.update({
            authorizationPending: false,
            channel: { ...this.state.channel, errorCode: transaction.errorCode || `qr-${transaction.status}`, status: 'error' },
            transaction: null
          })
        }
        if (transaction.status !== 'completed') return this.publicState()
        this.update({ authorizationPending: false, transaction: null })
        await this.view?.destroy()
      }
      const state = await this.refresh()
      if (state.identity.status === 'verified' || state.channel.status === 'revoked') this.stopPolling()
      return state
    } catch (error) {
      return this.updateChannel({ errorCode: error?.code || 'gateway-offline', status: 'error' })
    } finally {
      this.polling = false
    }
  }

  async cancel() {
    const transaction = this.state.transaction
    this.stopPolling()
    if (transaction) {
      await this.client.cancelWeComPersonalBotTransaction(this.token(), transaction.transactionId).catch(() => undefined)
    }
    await this.view?.destroy()
    return this.update(initialState())
  }

  async revokeBot() {
    const bindingId = this.state.binding?.bindingId
    if (!bindingId) return this.publicState()
    this.stopPolling()
    await this.onBeforeBotRevoke(bindingId)
    this.runtimeState = 'detached'
    this.runtimeBindingId = null
    this.updateChannel({ errorCode: null, localStopped: true, serverRevokePending: false, status: 'offline' })
    try {
      await this.client.revokeWeComPersonalBotBinding(this.token(), bindingId)
      return this.update({
        binding: null,
        channel: { errorCode: null, localStopped: true, serverRevokePending: false, status: 'revoked' },
        identity: { ...this.state.identity, claim: null }
      })
    } catch (error) {
      return this.updateChannel({
        errorCode: error?.code || 'server-revoke-failed',
        localStopped: true,
        serverRevokePending: true,
        status: 'offline'
      })
    }
  }

  async regenerateIdentityClaim() {
    const binding = this.state.binding
    if (!binding || binding.status !== 'connected') {
      const error = new Error('Enterprise WeCom Bot is not connected.')
      error.code = 'bot-binding-inactive'
      throw error
    }
    try {
      const claim = validateIdentityClaim(
        await this.client.issueWeComPersonalBotIdentityClaim(this.token(), binding.bindingId),
        binding.bindingId
      )
      return this.updateIdentity({ claim, errorCode: null, link: null, status: 'pending' })
    } catch (error) {
      return this.updateIdentity({
        errorCode: error?.code || 'identity-claim-unavailable',
        status: error?.code === 'identity_claim_conflict' ? 'conflict' : this.state.identity.status
      })
    }
  }

  async unlinkIdentity() {
    const linkId = this.state.identity.link?.linkId
    if (!linkId) return this.regenerateIdentityClaim()
    try {
      await this.client.unlinkWeComPersonalBotChannelIdentity(this.token(), linkId)
      this.updateIdentity({ claim: null, errorCode: null, link: null, status: 'unlinked' })
      const identity = await this.identityState(this.state.binding)
      return this.update({ identity })
    } catch (error) {
      return this.updateIdentity({ errorCode: error?.code || 'identity-unlink-failed' })
    }
  }

  applyRuntimeState(runtimeState) {
    this.runtimeState = String(runtimeState?.state || 'detached')
    this.runtimeBindingId = typeof runtimeState?.bindingId === 'string' ? runtimeState.bindingId : null
    return this.updateChannel({
      errorCode: runtimeState?.errorCode || null,
      localStopped: this.runtimeState === 'detached',
      status: channelStatusForBinding(this.state.binding, this.runtimeState)
    })
  }

  applyRelayState(relayState) {
    const state = relayState?.state === 'lease-lost' ? 'error' : relayState?.state
    return this.applyRuntimeState({
      errorCode: relayState?.state === 'lease-lost' ? 'lease-lost' : relayState?.errorCode,
      state
    })
  }

  async dispose() {
    this.stopPolling()
    await this.view?.destroy()
  }
}

function createEnterpriseWeComBotController(options) {
  return new EnterpriseWeComBotController(options)
}

module.exports = {
  EnterpriseWeComBotController,
  channelStatusForBinding,
  createEnterpriseWeComBotController,
  initialState,
  validateIdentityClaim,
  validateIdentityLink,
  validateIdentityLinks
}
