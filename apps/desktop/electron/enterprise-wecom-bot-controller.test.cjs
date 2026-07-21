const assert = require('node:assert/strict')
const test = require('node:test')

const {
  createEnterpriseWeComBotController,
  validateIdentityClaim,
  validateIdentityLink
} = require('./enterprise-wecom-bot-controller.cjs')

const transaction = {
  authorizationUrl: 'https://auth.example/wecom/bot/01234567-89ab-4def-8abc-0123456789ab?state=abcdefghijklmnop',
  contractVersion: 'wecom-bot-transaction.v1', errorCode: null, expiresAt: '2026-07-20T12:00:00Z',
  status: 'pending', transactionId: '01234567-89ab-4def-8abc-0123456789ab'
}
const binding = {
  bindingId: '11234567-89ab-4def-8abc-0123456789ab', botId: 'bot-secret-boundary-id',
  connectionStatus: 'offline', contractVersion: 'wecom-bot-binding.v1', createdAt: '2026-07-20T10:00:00Z',
  displayName: 'Hermes Bot', errorCode: null, lastConnectedAt: null, ownerVerificationRequired: false,
  status: 'connected', updatedAt: '2026-07-20T10:01:00Z'
}
const claim = {
  bindingId: binding.bindingId, claimId: '21234567-89ab-4def-8abc-0123456789ab', code: '482731',
  contractVersion: 'wecom-channel-identity.v1', expiresAt: '2026-07-20T10:06:00Z', failedAttempts: 0, status: 'pending'
}
const rawLink = {
  botId: 'must-not-cross', channelUserId: 'raw-user-must-not-cross', channelUserIdHint: 'woPx…IrMg',
  contractVersion: 'wecom-channel-identity.v1', corpId: 'must-not-cross', createdAt: '2026-07-20T10:00:00Z',
  desktopUserId: 'desktop-user', displayName: '贝佳豪', linkId: '31234567-89ab-4def-8abc-0123456789ab',
  sourceBindingId: binding.bindingId, updatedAt: '2026-07-20T10:00:00Z', userName: 'beijiahao',
  verificationMethod: 'claim-code', verifiedAt: '2026-07-20T10:00:00Z'
}

function baseClient(overrides = {}) {
  return {
    currentWeComPersonalBotBinding: async () => binding,
    issueWeComPersonalBotIdentityClaim: async () => claim,
    weComPersonalBotChannelIdentities: async () => [],
    weComPersonalBotIdentityClaim: async () => claim,
    ...overrides
  }
}

test('completed binding hot-attaches once and issues identity claim independently', async () => {
  let attaches = 0
  const controller = createEnterpriseWeComBotController({
    client: {
      ...baseClient(),
      createWeComPersonalBotTransaction: async () => transaction,
      weComPersonalBotTransaction: async () => ({ ...transaction, authorizationUrl: null, status: 'completed' })
    },
    desktopHostedRuntime: true,
    getDesktopToken: () => 'desktop-token',
    onBindingCompleted: async value => {
      attaches += 1
      assert.equal(value.bindingId, binding.bindingId)
      return { bindingId: binding.bindingId, connected: true, state: 'connected' }
    },
    setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {},
    view: { destroy: async () => {}, open: async () => {} }
  })

  assert.equal((await controller.start()).authorizationPending, true)
  const state = await controller.poll()
  assert.equal(state.channel.status, 'connected')
  assert.equal(state.identity.status, 'pending')
  assert.equal(state.identity.claim.code, '482731')
  assert.equal(attaches, 1)
  assert.equal(JSON.stringify(state).includes('bot-secret-boundary-id'), false)
})

test('identity API failure does not contaminate a connected channel', async () => {
  const error = Object.assign(new Error('down'), { code: 'identity_claim_unavailable', status: 503 })
  const controller = createEnterpriseWeComBotController({
    client: baseClient({
      issueWeComPersonalBotIdentityClaim: async () => { throw error },
      weComPersonalBotIdentityClaim: async () => { throw Object.assign(new Error('missing'), { code: 'identity_claim_not_found', status: 404 }) }
    }),
    desktopHostedRuntime: true,
    getDesktopToken: () => 'desktop-token',
    onBindingCompleted: async () => ({ bindingId: binding.bindingId, connected: true, state: 'connected' })
  })

  const state = await controller.refresh()
  assert.equal(state.channel.status, 'connected')
  assert.equal(state.channel.errorCode, null)
  assert.equal(state.identity.status, 'unverified')
  assert.equal(state.identity.errorCode, 'identity_claim_unavailable')
})

test('a historical link from another Bot binding does not skip the new claim', async () => {
  const newBinding = {
    ...binding,
    bindingId: '41234567-89ab-4def-8abc-0123456789ab',
    botId: 'new-bot-id'
  }
  const newClaim = {
    ...claim,
    bindingId: newBinding.bindingId,
    claimId: '51234567-89ab-4def-8abc-0123456789ab'
  }
  let issueCalls = 0
  const controller = createEnterpriseWeComBotController({
    client: baseClient({
      currentWeComPersonalBotBinding: async () => newBinding,
      issueWeComPersonalBotIdentityClaim: async (_token, bindingId) => {
        issueCalls += 1
        assert.equal(bindingId, newBinding.bindingId)
        return newClaim
      },
      weComPersonalBotChannelIdentities: async () => [rawLink],
      weComPersonalBotIdentityClaim: async () => {
        throw Object.assign(new Error('missing'), { code: 'identity_claim_not_found', status: 404 })
      }
    }),
    desktopHostedRuntime: true,
    getDesktopToken: () => 'desktop-token',
    onBindingCompleted: async () => ({ bindingId: newBinding.bindingId, connected: true, state: 'connected' })
  })

  const state = await controller.refresh()
  assert.equal(state.channel.status, 'connected')
  assert.equal(state.identity.status, 'pending')
  assert.equal(state.identity.claim.bindingId, newBinding.bindingId)
  assert.equal(state.identity.link, null)
  assert.equal(issueCalls, 1)
})

test('identity claim conflict is isolated from the connected channel', async () => {
  const controller = createEnterpriseWeComBotController({
    client: baseClient({
      issueWeComPersonalBotIdentityClaim: async () => {
        throw Object.assign(new Error('conflict'), { code: 'identity_claim_conflict', status: 409 })
      },
      weComPersonalBotIdentityClaim: async () => {
        throw Object.assign(new Error('missing'), { code: 'identity_claim_not_found', status: 404 })
      }
    }),
    desktopHostedRuntime: true,
    getDesktopToken: () => 'desktop-token',
    onBindingCompleted: async () => ({ bindingId: binding.bindingId, connected: true, state: 'connected' })
  })
  const state = await controller.refresh()
  assert.equal(state.channel.status, 'connected')
  assert.equal(state.identity.status, 'conflict')
  assert.equal(state.identity.errorCode, 'identity_claim_conflict')
})

test('identity unlink keeps runtime attached and immediately obtains a new claim', async () => {
  let detachCalls = 0
  let unlinkCalls = 0
  let linked = true
  const controller = createEnterpriseWeComBotController({
    client: baseClient({
      unlinkWeComPersonalBotChannelIdentity: async (_token, id) => {
        unlinkCalls += 1
        linked = false
        assert.equal(id, rawLink.linkId)
      },
      weComPersonalBotChannelIdentities: async () => linked ? [rawLink] : []
    }),
    desktopHostedRuntime: true,
    getDesktopToken: () => 'desktop-token',
    onBeforeBotRevoke: async () => { detachCalls += 1 },
    onBindingCompleted: async () => ({ bindingId: binding.bindingId, connected: true, state: 'connected' })
  })
  let state = await controller.refresh()
  assert.equal(state.identity.status, 'verified')
  assert.equal(JSON.stringify(state).includes('raw-user-must-not-cross'), false)
  assert.equal(Object.hasOwn(state.identity.link, 'sourceBindingId'), false)
  state = await controller.unlinkIdentity()
  assert.equal(unlinkCalls, 1)
  assert.equal(detachCalls, 0)
  assert.equal(state.channel.status, 'connected')
  assert.equal(state.identity.status, 'pending')
})

test('Bot unlink detaches first and preserves local-stopped state when server revoke fails', async () => {
  const calls = []
  const controller = createEnterpriseWeComBotController({
    client: baseClient({
      revokeWeComPersonalBotBinding: async () => { calls.push('server'); throw Object.assign(new Error('down'), { code: 'gateway-offline' }) }
    }),
    desktopHostedRuntime: true,
    getDesktopToken: () => 'desktop-token',
    onBeforeBotRevoke: async () => { calls.push('detach') },
    onBindingCompleted: async () => ({ bindingId: binding.bindingId, connected: true, state: 'connected' })
  })
  await controller.refresh()
  const state = await controller.revokeBot()
  assert.deepEqual(calls, ['detach', 'server'])
  assert.equal(state.channel.status, 'offline')
  assert.equal(state.channel.localStopped, true)
  assert.equal(state.channel.serverRevokePending, true)
})

test('claim and link validators retain only the required main-process identity fields', () => {
  assert.deepEqual(validateIdentityClaim(claim, binding.bindingId), claim)
  const link = validateIdentityLink(rawLink)
  assert.equal(link.channelUserIdHint, 'woPx…IrMg')
  assert.equal(link.sourceBindingId, binding.bindingId)
  assert.equal(Object.hasOwn(link, 'channelUserId'), false)
  assert.equal(Object.hasOwn(link, 'corpId'), false)
  assert.throws(() => validateIdentityClaim({ ...claim, code: '12345' }, binding.bindingId), /invalid/)
})
