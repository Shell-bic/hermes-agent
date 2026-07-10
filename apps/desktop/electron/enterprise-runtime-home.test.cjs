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
    generatedAt: '2026-07-06T12:00:00Z',
    policyHash: 'policy-hash-1',
    policyVersion: 'pv-1',
    role: { name: 'Engineer' },
    sessionId: 'sess-1',
    toolPolicySnapshot: {
      skills: [
        {
          key: 'terminal',
          displayName: 'Terminal',
          status: 'restricted',
          source: 'enterprise',
          secretNote: 'drop-me-too'
        }
      ],
      toolSets: [
        {
          key: 'browser',
          displayName: 'Browser',
          status: 'blocked',
          localizedDisplay: { zh: { displayName: '浏览器' } }
        }
      ],
      tools: [{ key: 'shell.exec', status: 'blocked', apiKey: 'tool-secret' }],
      mcpServers: [
        {
          key: 'filesystem',
          status: 'restricted',
          token: 'mcp-secret',
          env: { FILESYSTEM_TOKEN: 'env-secret' },
          headers: { Authorization: 'Bearer header-secret' }
        }
      ],
      capabilityFlags: [
        {
          key: 'mcp.catalog.install',
          displayName: 'MCP catalog install',
          status: 'restricted',
          source: 'enterprise',
          gatewayToken: 'capability-secret'
        }
      ],
      policyVersion: 'pv-1',
      policyHash: 'policy-hash-1',
      generatedAt: '2026-07-06T12:00:00Z'
    },
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
      capabilities: { reasoning: true, tools: true, contextWindowTokens: 128000, maxOutputTokens: 4096 },
      runtimeDefaults: { reasoningEffort: 'medium', serviceTier: 'auto', contextLengthTokens: 64000, maxOutputTokens: 4096 },
      modelProfiles: [
        {
          id: 'profile-1',
          apiFormat: 'openai-chat',
          auxiliaryPolicy: { mode: 'follow-main' },
          capabilities: { reasoning: true, tools: true, contextWindowTokens: 128000, maxOutputTokens: 4096 },
          displayName: 'GPT 4.1 Enterprise',
          isDefault: true,
          model: 'gpt-4.1',
          modelProviderId: 'provider-1',
          name: 'gpt41',
          pricing: { input: 2, output: 8 },
          providerName: 'OpenAI',
          providerType: 'openai',
          runtimeDefaults: { reasoningEffort: 'medium', contextLengthTokens: 64000, maxOutputTokens: 4096 }
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
  assert.match(config, /agent:\n  api_max_retries: 1/)
  assert.match(config, /display:\n  language: "zh"/)
  assert.match(config, /api_mode: "chat_completions"/)
  assert.match(env, /COMPANY_GATEWAY_TOKEN="gateway-secret"/)
  assert.equal(result.env[GATEWAY_TOKEN_ENV], 'gateway-secret')
  assert.deepEqual(policy.allowedModels, ['gpt-4.1', 'claude-sonnet'])
  assert.equal(policy.defaultModel, 'gpt-4.1')
  assert.equal(policy.currentModel, 'gpt-4.1')
  assert.deepEqual(policy.capabilities, { reasoning: true, tools: true, contextWindowTokens: 128000, maxOutputTokens: 4096 })
  assert.deepEqual(policy.runtimeDefaults, { reasoningEffort: 'medium', serviceTier: 'auto', contextLengthTokens: 64000, maxOutputTokens: 4096 })
  assert.deepEqual(policy.auxiliaryPolicy, { enabled: true })
  assert.equal(policy.policyHash, 'policy-hash-1')
  assert.equal(policy.generatedAt, '2026-07-06T12:00:00Z')
  assert.equal(policy.toolPolicySnapshot.policyHash, 'policy-hash-1')
  assert.equal(policy.toolPolicySnapshot.generatedAt, '2026-07-06T12:00:00Z')
  assert.deepEqual(policy.toolPolicySnapshot.skills[0], {
    key: 'terminal',
    displayName: 'Terminal',
    status: 'restricted',
    source: 'enterprise'
  })
  assert.deepEqual(policy.toolPolicySnapshot.toolSets[0], {
    key: 'browser',
    displayName: 'Browser',
    status: 'blocked',
    localizedDisplay: { zh: { displayName: '浏览器' } }
  })
  assert.deepEqual(policy.toolPolicySnapshot.tools[0], { key: 'shell.exec', status: 'blocked' })
  assert.deepEqual(policy.toolPolicySnapshot.mcpServers[0], { key: 'filesystem', status: 'restricted' })
  assert.deepEqual(policy.toolPolicySnapshot.capabilityFlags, [
    {
      key: 'mcp.catalog.install',
      displayName: 'MCP catalog install',
      status: 'restricted',
      source: 'enterprise'
    }
  ])
  assert.deepEqual(policy.modelProfiles[0], {
    apiFormat: 'openai-chat',
    auxiliaryPolicy: { mode: 'follow-main' },
    capabilities: { reasoning: true, tools: true, contextWindowTokens: 128000, maxOutputTokens: 4096 },
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
    runtimeDefaults: { reasoningEffort: 'medium', contextLengthTokens: 64000, maxOutputTokens: 4096 }
  })
  assert.equal(JSON.stringify(result.publicState).includes('gateway-secret'), false)
  assert.equal(JSON.stringify(result.publicState).includes('drop-me'), false)
  assert.equal(JSON.stringify(result.publicState).includes('tool-secret'), false)
  assert.equal(JSON.stringify(result.publicState).includes('mcp-secret'), false)
  assert.equal(JSON.stringify(result.publicState).includes('env-secret'), false)
  assert.equal(JSON.stringify(result.publicState).includes('header-secret'), false)
  assert.equal(JSON.stringify(result.publicState).includes('capability-secret'), false)
  assert.equal(JSON.stringify(policy).includes('gateway-secret'), false)
  assert.equal(JSON.stringify(policy).includes('tool-secret'), false)
  assert.equal(JSON.stringify(policy).includes('mcp-secret'), false)
  assert.equal(JSON.stringify(policy).includes('env-secret'), false)
  assert.equal(JSON.stringify(policy).includes('header-secret'), false)
  assert.equal(JSON.stringify(policy).includes('capability-secret'), false)
  assert.deepEqual(result.publicState.allowedModels, ['gpt-4.1', 'claude-sonnet'])
  assert.equal(result.publicState.defaultModel, 'gpt-4.1')
  assert.equal(result.publicState.currentModel, 'gpt-4.1')
  assert.equal(result.publicState.currentModelProfileId, 'profile-1')
  assert.equal(result.publicState.policyHash, 'policy-hash-1')
  assert.equal(result.publicState.generatedAt, '2026-07-06T12:00:00Z')
  assert.equal(result.publicState.toolPolicySnapshot.toolSets[0].localizedDisplay.zh.displayName, '浏览器')
  assert.deepEqual(result.publicState.toolPolicySnapshot.capabilityFlags, [
    {
      key: 'mcp.catalog.install',
      displayName: 'MCP catalog install',
      status: 'restricted',
      source: 'enterprise'
    }
  ])
  assert.deepEqual(result.publicState.lockedSurfaces, ['providers', 'env'])
  assert.deepEqual(result.publicState.uiPolicy, { defaultLocale: 'zh', allowLanguageChange: true, lockedLocale: false })
  assert.deepEqual(policy.uiPolicy, { defaultLocale: 'zh', allowLanguageChange: true, lockedLocale: false })
})

test('public enterprise state degrades older manifests without tool policy snapshot', () => {
  const state = publicEnterpriseState({
    bootstrap: { user: { displayName: 'Ada' } },
    manifest: {
      allowedModels: ['m1'],
      defaultModel: 'm1',
      gatewayApiBaseUrl: 'https://gateway.example.com',
      gatewayToken: 'gateway-secret',
      policyVersion: 'legacy-pv'
    }
  })

  assert.equal(state.toolPolicySnapshot, null)
  assert.equal(state.policyHash, null)
  assert.equal(state.generatedAt, null)
  assert.deepEqual(state.allowedModels, ['m1'])
})

test('public enterprise state merges manifest current profile with fetched model profiles', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-home-'))
  const result = writeManagedRuntimeHome({
    bootstrap: { user: { displayName: 'Ada' } },
    hermesHome,
    manifest: manifest({
      allowedModels: ['m1', 'm2', 'm3'],
      defaultModel: 'm1',
      modelProfiles: [
        {
          id: 'profile-1',
          displayName: 'Model One Runtime',
          isDefault: true,
          model: 'm1',
          providerSecret: 'drop-me'
        }
      ]
    }),
    modelProfiles: [
      { id: 'profile-1', displayName: 'Model One Catalog', model: 'm1' },
      { id: 'profile-2', displayName: 'Model Two', model: 'm2' },
      { id: 'profile-3', displayName: 'Model Three', model: 'm3' }
    ]
  })
  const policy = JSON.parse(fs.readFileSync(path.join(hermesHome, 'enterprise-policy.json'), 'utf8'))

  assert.deepEqual(result.publicState.modelProfiles.map(profile => profile.model), ['m1', 'm2', 'm3'])
  assert.deepEqual(policy.modelProfiles.map(profile => profile.model), ['m1', 'm2', 'm3'])
  assert.equal(result.publicState.modelProfiles[0].displayName, 'Model One Runtime')
  assert.equal(JSON.stringify(result.publicState).includes('drop-me'), false)
  assert.equal(JSON.stringify(policy).includes('drop-me'), false)
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

test('public enterprise state accepts manifest ui policy before bootstrap policy', () => {
  assert.deepEqual(
    publicEnterpriseState({
      bootstrap: {
        uiPolicy: { defaultLocale: 'en', allowLanguageChange: true, lockedLocale: false },
        user: { displayName: 'Ada' }
      },
      manifest: manifest({
        uiPolicy: { defaultLocale: 'zh-hant', allowLanguageChange: false, lockedLocale: true }
      })
    }).uiPolicy,
    { defaultLocale: 'zh-hant', allowLanguageChange: false, lockedLocale: true }
  )

  assert.deepEqual(
    publicEnterpriseState({
      bootstrap: {
        uiPolicy: { defaultLocale: 'ja', allowLanguageChange: true, lockedLocale: false },
        user: { displayName: 'Ada' }
      },
      manifest: manifest({ uiPolicy: undefined })
    }).uiPolicy,
    { defaultLocale: 'ja', allowLanguageChange: true, lockedLocale: false }
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

test('managed config prefers manifest and profile apiMode before legacy apiFormat', () => {
  assert.match(
    buildManagedConfigYaml({
      manifest: manifest({
        apiFormat: 'openai-chat',
        apiMode: 'anthropic_messages'
      })
    }),
    /api_mode: "anthropic_messages"/
  )

  assert.match(
    buildManagedConfigYaml({
      manifest: manifest({
        allowedModels: ['gpt-4.1'],
        defaultModel: 'gpt-4.1',
        modelProfiles: [
          {
            id: 'profile-runtime',
            apiFormat: 'openai-chat',
            apiMode: 'codex_responses',
            isDefault: true,
            model: 'gpt-4.1'
          }
        ]
      })
    }),
    /api_mode: "codex_responses"/
  )
})

test('managed config preserves an existing supported explicit display language', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-home-'))
  fs.mkdirSync(hermesHome, { recursive: true })
  fs.writeFileSync(
    path.join(hermesHome, 'config.yaml'),
    ['display:', '  language: "ja"', 'model:', '  provider: "old"'].join('\n'),
    'utf8'
  )

  writeManagedRuntimeHome({
    bootstrap: { user: { displayName: 'Ada' } },
    hermesHome,
    manifest: manifest()
  })

  const config = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8')
  assert.match(config, /display:\n  language: "ja"/)
})

test('managed config falls back to zh when existing display language is unsupported', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-home-'))
  fs.mkdirSync(hermesHome, { recursive: true })
  fs.writeFileSync(path.join(hermesHome, 'config.yaml'), ['display:', '  language: "de"'].join('\n'), 'utf8')

  writeManagedRuntimeHome({
    bootstrap: { user: { displayName: 'Ada' } },
    hermesHome,
    manifest: manifest()
  })

  const config = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8')
  assert.match(config, /display:\n  language: "zh"/)
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
