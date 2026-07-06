const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  GATEWAY_TOKEN_ENV,
  buildManagedConfigYaml,
  enterpriseUserPathSegment,
  normalizeGatewayApiBaseUrl,
  publicEnterpriseState,
  resolveManagedHermesHome,
  writeManagedRuntimeHome
} = require('./enterprise-runtime-home.cjs')

function manifest(overrides = {}) {
  return {
    allowedModels: ['gpt-4.1', 'claude-sonnet'],
    defaultModel: 'gpt-4.1',
    gatewayApiBaseUrl: 'https://gateway.example.com',
    gatewayToken: 'gateway-secret',
    lockedSurfaces: ['providers', 'env'],
    manifestId: 'mf-1',
    policyVersion: 'pv-1',
    role: { name: 'Engineer' },
    sessionId: 'sess-1',
    ...overrides
  }
}

test('managed runtime home writes company-gateway config and token env only in private outputs', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-home-'))
  const result = writeManagedRuntimeHome({
    bootstrap: { user: { displayName: 'Ada' } },
    hermesHome,
    manifest: manifest({
      auxiliaryPolicy: { enabled: true, secretNote: 'drop-me' },
      capabilities: { reasoning: true, tools: true },
      runtimeDefaults: { reasoningEffort: 'medium', serviceTier: 'auto' },
      modelProfiles: [
        {
          id: 'profile-1',
          apiFormat: 'openai-chat',
          auxiliaryPolicy: { mode: 'follow-main' },
          capabilities: { reasoning: true, tools: true },
          displayName: 'GPT 4.1 Enterprise',
          isDefault: true,
          model: 'gpt-4.1',
          modelProviderId: 'provider-1',
          name: 'gpt41',
          pricing: { input: 2, output: 8 },
          providerName: 'OpenAI',
          providerType: 'openai',
          runtimeDefaults: { reasoningEffort: 'medium' }
        }
      ]
    }),
    modelProfiles: [{ id: 'ignored', name: 'Ignored', model: 'ignored' }]
  })

  const config = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8')
  const env = fs.readFileSync(path.join(hermesHome, '.env'), 'utf8')
  const policy = JSON.parse(fs.readFileSync(path.join(hermesHome, 'enterprise-policy.json'), 'utf8'))

  assert.match(config, /provider: "company-gateway"/)
  assert.match(config, /base_url: "https:\/\/gateway\.example\.com\/v1"/)
  assert.match(config, /api_mode: "chat_completions"/)
  assert.match(env, /COMPANY_GATEWAY_TOKEN="gateway-secret"/)
  assert.equal(result.env[GATEWAY_TOKEN_ENV], 'gateway-secret')
  assert.deepEqual(policy.allowedModels, ['gpt-4.1', 'claude-sonnet'])
  assert.equal(policy.defaultModel, 'gpt-4.1')
  assert.equal(policy.currentModel, 'gpt-4.1')
  assert.deepEqual(policy.capabilities, { reasoning: true, tools: true })
  assert.deepEqual(policy.runtimeDefaults, { reasoningEffort: 'medium', serviceTier: 'auto' })
  assert.deepEqual(policy.auxiliaryPolicy, { enabled: true })
  assert.deepEqual(policy.modelProfiles[0], {
    apiFormat: 'openai-chat',
    auxiliaryPolicy: { mode: 'follow-main' },
    capabilities: { reasoning: true, tools: true },
    displayName: 'GPT 4.1 Enterprise',
    id: 'profile-1',
    isDefault: true,
    model: 'gpt-4.1',
    modelProviderId: 'provider-1',
    name: 'gpt41',
    pricing: { input: 2, output: 8 },
    provider: { id: 'provider-1', name: 'OpenAI', type: 'openai' },
    providerName: 'OpenAI',
    providerType: 'openai',
    runtimeDefaults: { reasoningEffort: 'medium' }
  })
  assert.equal(JSON.stringify(result.publicState).includes('gateway-secret'), false)
  assert.equal(JSON.stringify(result.publicState).includes('drop-me'), false)
  assert.deepEqual(result.publicState.allowedModels, ['gpt-4.1', 'claude-sonnet'])
  assert.equal(result.publicState.defaultModel, 'gpt-4.1')
  assert.equal(result.publicState.currentModel, 'gpt-4.1')
  assert.equal(result.publicState.currentModelProfileId, 'profile-1')
  assert.deepEqual(result.publicState.lockedSurfaces, ['providers', 'env'])
})

test('public enterprise state accepts runtime manifest roles before legacy role', () => {
  assert.deepEqual(
    publicEnterpriseState({
      bootstrap: { role: { name: 'BootstrapRole' }, user: { displayName: 'Ada' } },
      manifest: manifest({
        role: { name: 'LegacyRole' },
        roles: [{ name: 'Engineer' }]
      })
    }).role,
    [{ name: 'Engineer' }]
  )

  assert.deepEqual(
    publicEnterpriseState({
      bootstrap: { role: { name: 'BootstrapRole' }, user: { displayName: 'Ada' } },
      manifest: manifest({ role: { name: 'LegacyRole' }, roles: undefined })
    }).role,
    { name: 'LegacyRole' }
  )
})

test('managed config preserves /v1 gateway urls without appending twice', () => {
  assert.equal(normalizeGatewayApiBaseUrl('https://gateway.example.com/v1/'), 'https://gateway.example.com/v1')
  assert.match(
    buildManagedConfigYaml({ manifest: manifest({ gatewayApiBaseUrl: 'https://gateway.example.com/v1/' }) }),
    /base_url: "https:\/\/gateway\.example\.com\/v1"/
  )
})

test('managed config derives api mode from selected enterprise model profile', () => {
  const config = buildManagedConfigYaml({
    manifest: manifest({
      allowedModels: ['kimi-for-coding'],
      defaultModel: 'kimi-for-coding',
      modelProfiles: [
        {
          id: 'kimi-profile',
          apiFormat: 'anthropic-messages',
          isDefault: true,
          model: 'kimi-for-coding'
        }
      ]
    })
  })

  assert.match(config, /api_mode: "anthropic_messages"/)
  assert.match(config, /transport: "anthropic_messages"/)
})

test('managed runtime home is scoped by enterprise user identity', () => {
  assert.equal(enterpriseUserPathSegment({ id: 'B4EBB599-6E5C-443F-A823-EE3D534FB6C5' }), 'b4ebb599-6e5c-443f-a823-ee3d534fb6c5')
  assert.equal(enterpriseUserPathSegment({ userName: 'view@example.com' }), 'view-example.com')
  assert.equal(enterpriseUserPathSegment({ userName: '../其它 用户' }), 'unknown')
  assert.equal(
    resolveManagedHermesHome('C:\\Users\\Ada\\AppData\\Roaming\\Hermes', { id: 'user-a' }),
    path.join('C:\\Users\\Ada\\AppData\\Roaming\\Hermes', 'enterprise', 'users', 'user-a', 'hermes-home')
  )
  assert.notEqual(
    resolveManagedHermesHome('/tmp/hermes', { id: 'user-a' }),
    resolveManagedHermesHome('/tmp/hermes', { id: 'user-b' })
  )
})
