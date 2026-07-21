const test = require('node:test')
const assert = require('node:assert/strict')

const { createEnterpriseWeComGatewayRunnerExperiment, validateRuntimeConfig } = require('./enterprise-wecom-gateway-runner.cjs')

const binding = {
  bindingId: '01234567-89ab-4def-8abc-0123456789ab', botId: 'public-binding-id', connectionStatus: 'offline',
  contractVersion: 'wecom-bot-binding.v1', createdAt: '2026-07-20T00:00:00Z', displayName: 'Personal bot',
  errorCode: null, lastConnectedAt: null, ownerVerificationRequired: false, status: 'connected', updatedAt: '2026-07-20T00:00:01Z'
}
const runtimeConfig = {
  allowedUserIds: [], bindingId: binding.bindingId, botId: 'runtime-bot-id',
  contractVersion: 'wecom-bot-runtime-config.v2', corpId: 'ww-corp-id', credentialVersion: 'credential-version-guid',
  dmPolicy: 'open', groupPolicy: 'open', identityContractVersion: 'wecom-channel-identity.v1',
  identityProofVersion: 'hermes-channel-identity-v2', ownerUserId: 'compat-only', secret: 'runtime-secret-value'
}

test('main-only experiment fetches v2 runtime config and hot-attaches without child env', async () => {
  const calls = []
  const experiment = createEnterpriseWeComGatewayRunnerExperiment({
    client: {
      currentWeComPersonalBotBinding: async token => { calls.push(['binding', token]); return binding },
      weComPersonalBotRuntimeConfig: async (token, bindingId) => {
        calls.push(['config', token, bindingId]); return { ...runtimeConfig, ignoredFutureField: 'not-forwarded' }
      }
    },
    enabled: true,
    gatewayBaseUrl: 'http://127.0.0.1:5092',
    getDesktopToken: () => 'desktop-token',
    getGatewayServiceToken: () => 'gateway-service-token',
    runtimeControl: {
      attach: async payload => {
        calls.push(['attach', payload])
        return { bindingId: binding.bindingId, connected: true, state: 'connected' }
      }
    }
  })
  const status = await experiment.attach()
  assert.equal(status.state, 'connected')
  assert.deepEqual(calls.slice(0, 2), [['binding', 'desktop-token'], ['config', 'desktop-token', binding.bindingId]])
  const payload = calls[2][1]
  assert.equal(payload.contractVersion, 'enterprise-wecom-runtime-control.v1')
  assert.equal(payload.gatewayServiceToken, 'gateway-service-token')
  assert.equal(payload.dmPolicy, undefined)
  assert.equal(payload.ownerUserId, undefined)
})

test('default-off experiment does not fetch config', async () => {
  let fetched = false
  const experiment = createEnterpriseWeComGatewayRunnerExperiment({
    client: { currentWeComPersonalBotBinding: async () => { fetched = true } }
  })
  assert.equal((await experiment.attach()).state, 'detached')
  assert.equal(fetched, false)
})

test('runtime config requires open DM/group and frozen identity proof versions', () => {
  assert.deepEqual(validateRuntimeConfig(runtimeConfig, binding.bindingId), {
    bindingId: binding.bindingId, botId: 'runtime-bot-id', corpId: 'ww-corp-id',
    identityContractVersion: 'wecom-channel-identity.v1', identityProofVersion: 'hermes-channel-identity-v2',
    secret: 'runtime-secret-value'
  })
  for (const patch of [
    { dmPolicy: 'allowlist' }, { groupPolicy: 'allowlist' }, { allowedUserIds: ['someone'] },
    { identityContractVersion: 'wrong' }, { identityProofVersion: 'wrong' }
  ]) {
    assert.throws(() => validateRuntimeConfig({ ...runtimeConfig, ...patch }, binding.bindingId),
      error => error.code === 'wecom-runtime-config-policy-invalid')
  }
})

test('detach delegates only to runtime adapter control', async () => {
  const calls = []
  const experiment = createEnterpriseWeComGatewayRunnerExperiment({
    enabled: true,
    runtimeControl: { detach: async id => { calls.push(id); return { bindingId: null, connected: false, state: 'detached' } } }
  })
  assert.equal((await experiment.detach(binding.bindingId)).state, 'detached')
  assert.deepEqual(calls, [binding.bindingId])
})
