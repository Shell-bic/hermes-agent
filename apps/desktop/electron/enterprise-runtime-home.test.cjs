const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const managedPolicy = require('../../../contracts/wecom-personal-bot/v1/fixtures/valid/managed-runtime-manifest.json').messagingChannelPolicy
const { computeMessagingChannelPolicyHash } = require('./messaging-channel-policy.cjs')

const {
  GATEWAY_TOKEN_ENV,
  buildManagedConfigYaml,
  enterpriseUserPathSegment,
  normalizeGatewayApiBaseUrl,
  normalizeSkillInstallReceiptTrust,
  publicEnterpriseState,
  readManagedPolicySnapshot,
  replaceManagedPolicySnapshot,
  resolveManagedHermesHome,
  validateManagedBootstrap,
  writeManagedRuntimeHome
} = require('./enterprise-runtime-home.cjs')

test('receipt trust preserves the exact signer contract and rejects widened shapes', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).trim()
  const trust = {
    schemaVersion: 2,
    issuer: 'https://gateway.example.test',
    audience: 'hermes-enterprise-skill-runtime',
    purpose: 'hermes-enterprise-skill-materialize',
    signerMode: 'gateway-service',
    algorithm: 'ES256',
    publicKeys: [{
      kid: 'p256-sha256-0123456789abcdef0123456789abcdef',
      algorithm: 'ES256',
      publicKeyPem,
      rotationState: 'current'
    }]
  }
  assert.deepEqual(normalizeSkillInstallReceiptTrust(trust), trust)
  assert.equal(normalizeSkillInstallReceiptTrust({ ...trust, signerMode: 'unknown' }), null)
  assert.equal(normalizeSkillInstallReceiptTrust({ ...trust, unexpected: true }), null)
  assert.equal(normalizeSkillInstallReceiptTrust({
    ...trust,
    publicKeys: [{ ...trust.publicKeys[0], unexpected: true }]
  }), null)
  assert.equal(normalizeSkillInstallReceiptTrust({ ...trust, signerMode: 'local-development' }).signerMode, 'local-development')
  assert.equal(normalizeSkillInstallReceiptTrust({ ...trust, signerMode: 'testing' }).signerMode, 'testing')
  assert.equal(normalizeSkillInstallReceiptTrust({
    ...trust,
    publicKeys: [trust.publicKeys[0], { ...trust.publicKeys[0], kid: 'retired-key', rotationState: 'retired' }]
  }).publicKeys[1].rotationState, 'retired')
  assert.equal(normalizeSkillInstallReceiptTrust({
    ...trust,
    publicKeys: [trust.publicKeys[0], { ...trust.publicKeys[0], kid: 'revoked-key', rotationState: 'revoked' }]
  }).publicKeys[1].rotationState, 'revoked')
  assert.equal(normalizeSkillInstallReceiptTrust({
    ...trust,
    publicKeys: Array.from({ length: 17 }, (_, index) => ({
      ...trust.publicKeys[0],
      kid: `key-${index}`
    }))
  }), null)
  assert.equal(normalizeSkillInstallReceiptTrust({
    ...trust,
    publicKeys: [trust.publicKeys[0], { ...trust.publicKeys[0] }]
  }), null)
  assert.equal(normalizeSkillInstallReceiptTrust({
    ...trust,
    publicKeys: [{ ...trust.publicKeys[0], publicKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) }]
  }), null)
  assert.equal(normalizeSkillInstallReceiptTrust({
    ...trust,
    publicKeys: [{ ...trust.publicKeys[0], publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${'A'.repeat(9 * 1024)}\n-----END PUBLIC KEY-----` }]
  }), null)
  assert.equal(normalizeSkillInstallReceiptTrust({
    ...trust,
    publicKeys: [{ ...trust.publicKeys[0], rotationState: 'retired' }]
  }), null)
  assert.equal(normalizeSkillInstallReceiptTrust({
    ...trust,
    publicKeys: [trust.publicKeys[0], { ...trust.publicKeys[0], kid: 'second-current' }]
  }), null)
  assert.equal(normalizeSkillInstallReceiptTrust({
    ...trust,
    publicKeys: [
      trust.publicKeys[0],
      { ...trust.publicKeys[0], kid: 'previous-1', rotationState: 'previous' },
      { ...trust.publicKeys[0], kid: 'previous-2', rotationState: 'previous' }
    ]
  }), null)
})

function manifest(overrides = {}) {
  return {
    allowedModels: ['gpt-4.1', 'claude-sonnet'],
    defaultModel: 'gpt-4.1',
    gatewayApiBaseUrl: 'https://gateway.example.com',
    gatewayToken: 'gateway-secret',
    lockedSurfaces: ['providers', 'env'],
    messagingChannelPolicy: managedPolicy,
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

function bootstrapPolicy(overrides = {}) {
  const generatedAt = overrides.generatedAt || '2026-07-14T08:00:00Z'
  const policyHash = overrides.policyHash || 'policy-hash-2'
  const policyVersion = overrides.policyVersion || 'pv-2'
  const baseSnapshot = manifest().toolPolicySnapshot
  const nestedPolicyVersion = overrides.toolPolicySnapshot?.policyVersion || `tool-policy.v1+roles:${policyVersion}`

  return {
    bootstrapContractVersion: 2,
    capabilities: ['skills.manage'],
    generatedAt,
    lockedSurfaces: ['skills'],
    policyHash,
    policyVersion,
    user: { id: 'user-a', displayName: 'Ada' },
    ...overrides,
    toolPolicySnapshot: {
      ...baseSnapshot,
      generatedAt,
      policyHash,
      policyVersion: nestedPolicyVersion,
      ...(overrides.toolPolicySnapshot || {})
    }
  }
}

test('managed bootstrap validator accepts the Gateway dual-version contract and rejects invalid payloads locally', () => {
  const valid = bootstrapPolicy({
    policyVersion: 'role-policy.v1-abc123',
    toolPolicySnapshot: { policyVersion: 'tool-policy.v1+roles:role-policy.v1-abc123' }
  })

  assert.equal(validateManagedBootstrap(valid), valid)
  assert.throws(
    () => validateManagedBootstrap({ ...valid, capabilities: ['skills.manage', 'skills.manage'] }),
    error => {
      assert.equal(error.code, 'enterprise_policy_payload_invalid')
      assert.equal(error.message, 'Enterprise policy bootstrap payload is invalid.')
      assert.equal(error.message.includes('skills.manage'), false)
      return true
    }
  )
})

test('managed bootstrap validator classifies old future and malformed contract versions before policy validation', () => {
  const valid = bootstrapPolicy()
  const cases = [
    [undefined, 'enterprise_gateway_contract_too_old'],
    [1, 'enterprise_gateway_contract_too_old'],
    [3, 'enterprise_desktop_contract_too_old'],
    [null, 'enterprise_gateway_contract_invalid'],
    ['2', 'enterprise_gateway_contract_invalid'],
    [2.5, 'enterprise_gateway_contract_invalid'],
    [0, 'enterprise_gateway_contract_invalid']
  ]

  for (const [bootstrapContractVersion, code] of cases) {
    const payload = { ...valid, bootstrapContractVersion, capabilities: null }
    if (bootstrapContractVersion === undefined) delete payload.bootstrapContractVersion
    assert.throws(() => validateManagedBootstrap(payload), error => {
      assert.equal(error.code, code)
      assert.equal(error.message.includes(String(bootstrapContractVersion)), false)
      assert.equal(error.message.includes('skills.manage'), false)
      return true
    })
  }
})

test('managed runtime home writes company-gateway config and token env only in private outputs', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-home-'))
  const result = writeManagedRuntimeHome({
    bootstrap: { mode: 'managed', messagingChannelPolicy: managedPolicy, user: { displayName: 'Ada' } },
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
  assert.match(config, /agent:\n {2}api_max_retries: 1/)
  assert.match(config, /display:\n {2}language: "zh"/)
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
  assert.equal(result.publicState.messagingChannelPolicy.status, 'applied')
  assert.deepEqual(result.publicState.messagingChannelPolicy.visibleChannelIds, ['wecom-personal'])
  assert.deepEqual(result.publicState.uiPolicy, { defaultLocale: 'zh', allowLanguageChange: true, lockedLocale: false })
  assert.deepEqual(policy.uiPolicy, { defaultLocale: 'zh', allowLanguageChange: true, lockedLocale: false })
})

test('managed policy LKG is persisted with and read only for the same enterprise user id', t => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-lkg-user-'))
  t.after(() => fs.rmSync(hermesHome, { force: true, recursive: true }))

  writeManagedRuntimeHome({
    bootstrap: { user: { id: 'User-A', displayName: 'Ada' } },
    hermesHome,
    manifest: manifest()
  })

  const persisted = JSON.parse(fs.readFileSync(path.join(hermesHome, 'enterprise-policy.json'), 'utf8'))
  assert.equal(persisted.enterpriseUserId, 'user-a')
  assert.equal(readManagedPolicySnapshot({ expectedUserId: 'USER-A', hermesHome }).valid, true)
  assert.deepEqual(
    readManagedPolicySnapshot({ expectedUserId: 'user-b', hermesHome }),
    {
      policy: null,
      policyPath: path.join(hermesHome, 'enterprise-policy.json'),
      reason: 'user_mismatch',
      valid: false
    }
  )
})

test('managed policy refresh atomically replaces only enterprise-policy.json', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-policy-refresh-'))
  writeManagedRuntimeHome({
    bootstrap: { user: { id: 'user-a', displayName: 'Ada' } },
    hermesHome,
    manifest: manifest()
  })
  const configPath = path.join(hermesHome, 'config.yaml')
  const envPath = path.join(hermesHome, '.env')
  const configBefore = fs.readFileSync(configPath, 'utf8')
  const envBefore = fs.readFileSync(envPath, 'utf8')

  const result = replaceManagedPolicySnapshot({
    bootstrap: bootstrapPolicy(),
    hermesHome
  })

  const policy = JSON.parse(fs.readFileSync(path.join(hermesHome, 'enterprise-policy.json'), 'utf8'))
  assert.equal(result.policyVersion, 'pv-2')
  assert.equal(result.policyHash, 'policy-hash-2')
  assert.equal(result.generatedAt, '2026-07-14T08:00:00Z')
  assert.deepEqual(policy.allowedModels, ['gpt-4.1', 'claude-sonnet'])
  assert.equal(policy.policyVersion, 'pv-2')
  assert.deepEqual(policy.lockedSurfaces, ['skills'])
  assert.equal(fs.readFileSync(configPath, 'utf8'), configBefore)
  assert.equal(fs.readFileSync(envPath, 'utf8'), envBefore)
  assert.deepEqual(fs.readdirSync(hermesHome).filter(name => name.endsWith('.tmp')), [])
  assert.equal(readManagedPolicySnapshot({ hermesHome }).valid, true)
})

test('managed policy refresh never inherits runtime fields from another user in the same home', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-policy-user-switch-'))
  writeManagedRuntimeHome({
    bootstrap: { user: { id: 'user-a', displayName: 'Ada' } },
    hermesHome,
    manifest: manifest()
  })

  const result = replaceManagedPolicySnapshot({
    bootstrap: bootstrapPolicy({ user: { id: 'user-b', displayName: 'Grace' } }),
    hermesHome
  })

  assert.equal(result.replacedExistingPolicy, false)
  assert.equal(result.policy.enterpriseUserId, 'user-b')
  assert.deepEqual(result.policy.allowedModels, [])
  assert.equal(result.policy.currentModel, null)
  assert.equal(result.policy.manifestId, null)
  assert.equal(result.policy.sessionId, null)
})

test('managed policy reader rejects missing and locally damaged snapshots', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-policy-invalid-'))
  assert.deepEqual(readManagedPolicySnapshot({ hermesHome }).reason, 'missing')
  fs.writeFileSync(path.join(hermesHome, 'enterprise-policy.json'), '{not-json', 'utf8')
  const damaged = readManagedPolicySnapshot({ hermesHome })
  assert.equal(damaged.valid, false)
  assert.equal(damaged.reason, 'invalid')
})

test('managed policy reader rejects semantic catalog damage and metadata mismatch', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-policy-semantic-damage-'))
  const policyPath = path.join(hermesHome, 'enterprise-policy.json')
  const valid = bootstrapPolicy()
  const mutations = [
    policy => { delete policy.toolPolicySnapshot.capabilityFlags },
    policy => { policy.toolPolicySnapshot.skills[0].status = 'arbitrary' },
    policy => { policy.toolPolicySnapshot.skills[0].key = '' },
    policy => { policy.toolPolicySnapshot.skills.push({ ...policy.toolPolicySnapshot.skills[0], key: 'TERMINAL' }) },
    policy => { policy.toolPolicySnapshot.policyVersion = '' },
    policy => { policy.policyVersion = ' role-version-with-whitespace ' },
    policy => { policy.toolPolicySnapshot.policyHash = 'different-hash' },
    policy => { policy.toolPolicySnapshot.generatedAt = '2026-07-14T09:00:00Z' },
    policy => { delete policy.lockedSurfaces },
    policy => { policy.lockedSurfaces = null },
    policy => { policy.lockedSurfaces = 'skills' },
    policy => { policy.lockedSurfaces = ['skills', 'skills'] },
    policy => { policy.lockedSurfaces = ['../skills'] },
    policy => { policy.lockedSurfaces = ['skills/legacy'] },
    policy => { policy.lockedSurfaces = ['skills\\legacy'] },
    policy => { policy.lockedSurfaces = ['.skills'] },
    policy => { policy.lockedSurfaces = ['skills\u0000legacy'] },
    policy => { policy.lockedSurfaces = [`s${'x'.repeat(256)}`] },
    policy => { policy.lockedSurfaces = ['__proto__'] },
    policy => { delete policy.capabilities },
    policy => { policy.capabilities = null },
    policy => { policy.capabilities = ['skills.manage', 'skills.manage'] },
    policy => { policy.capabilities = [' skills.manage '] },
    policy => { policy.capabilities = ['skills/manage'] },
    policy => { policy.capabilities = ['skills\\manage'] },
    policy => { policy.capabilities = ['.skills.manage'] },
    policy => { policy.capabilities = ['skills\nmanage'] },
    policy => { policy.capabilities = [`c${'x'.repeat(256)}`] },
    policy => { policy.capabilities = ['__proto__'] }
  ]

  for (const mutate of mutations) {
    const damaged = structuredClone(valid)
    mutate(damaged)
    fs.writeFileSync(policyPath, JSON.stringify(damaged), 'utf8')
    assert.equal(readManagedPolicySnapshot({ hermesHome }).valid, false)
  }
})

test('managed policy refresh rejects invalid role policy arrays without replacing last-known-good', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-policy-role-arrays-'))
  writeManagedRuntimeHome({
    bootstrap: { user: { displayName: 'Ada' } },
    hermesHome,
    manifest: manifest()
  })
  const policyPath = path.join(hermesHome, 'enterprise-policy.json')
  const original = fs.readFileSync(policyPath)
  const mutations = [
    policy => { delete policy.lockedSurfaces },
    policy => { policy.lockedSurfaces = null },
    policy => { policy.lockedSurfaces = 'skills' },
    policy => { policy.lockedSurfaces = { key: 'skills' } },
    policy => { policy.lockedSurfaces = ['skills', 'skills'] },
    policy => { policy.lockedSurfaces = ['../skills'] },
    policy => { policy.lockedSurfaces = ['skills/legacy'] },
    policy => { policy.lockedSurfaces = ['skills\\legacy'] },
    policy => { policy.lockedSurfaces = ['.skills'] },
    policy => { policy.lockedSurfaces = ['skills\u0000legacy'] },
    policy => { policy.lockedSurfaces = [`s${'x'.repeat(256)}`] },
    policy => { policy.lockedSurfaces = ['__proto__'] },
    policy => { policy.lockedSurfaces = [' skills '] },
    policy => { policy.lockedSurfaces = [42] },
    policy => { delete policy.capabilities },
    policy => { policy.capabilities = null },
    policy => { policy.capabilities = 'skills.manage' },
    policy => { policy.capabilities = { 'skills.manage': true } },
    policy => { policy.capabilities = ['skills.manage', 'skills.manage'] },
    policy => { policy.capabilities = ['../skills.manage'] },
    policy => { policy.capabilities = ['skills/manage'] },
    policy => { policy.capabilities = ['skills\\manage'] },
    policy => { policy.capabilities = ['.skills.manage'] },
    policy => { policy.capabilities = ['skills\nmanage'] },
    policy => { policy.capabilities = [`c${'x'.repeat(256)}`] },
    policy => { policy.capabilities = ['__proto__'] },
    policy => { policy.capabilities = [' skills.manage '] },
    policy => { policy.capabilities = [42] }
  ]

  for (const mutate of mutations) {
    const invalid = bootstrapPolicy()
    mutate(invalid)
    assert.throws(
      () => replaceManagedPolicySnapshot({ bootstrap: invalid, hermesHome }),
      /bootstrap payload is invalid/
    )
    assert.deepEqual(fs.readFileSync(policyPath), original)
  }
})

test('managed policy refresh preserves Unicode safe unknown role policy values through 256 characters', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-policy-unknown-values-'))
  const maximumCapability = `A${'界'.repeat(255)}`
  const maximumLockedSurface = `9${'域'.repeat(255)}`
  const bootstrap = bootstrapPolicy({
    capabilities: ['历史能力.财务', maximumCapability],
    lockedSurfaces: ['旧版界面', maximumLockedSurface]
  })

  const result = replaceManagedPolicySnapshot({ bootstrap, hermesHome })
  const policy = JSON.parse(fs.readFileSync(result.policyPath, 'utf8'))

  assert.deepEqual(policy.capabilities, ['历史能力.财务', maximumCapability])
  assert.deepEqual(policy.lockedSurfaces, ['旧版界面', maximumLockedSurface])
  assert.equal(readManagedPolicySnapshot({ hermesHome }).valid, true)
})

test('managed policy refresh preserves distinct role and tool-policy version domains', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-policy-version-domains-'))
  const bootstrap = bootstrapPolicy({
    policyVersion: 'role-policy.v1-abc123',
    toolPolicySnapshot: { policyVersion: 'tool-policy.v1+roles:role-policy.v1-abc123' }
  })

  const result = replaceManagedPolicySnapshot({ bootstrap, hermesHome })
  const policy = JSON.parse(fs.readFileSync(result.policyPath, 'utf8'))

  assert.equal(policy.policyVersion, 'role-policy.v1-abc123')
  assert.equal(policy.toolPolicySnapshot.policyVersion, 'tool-policy.v1+roles:role-policy.v1-abc123')
  assert.equal(readManagedPolicySnapshot({ hermesHome }).valid, true)
})

test('managed policy refresh rejects bootstrap metadata mismatch without replacing last-known-good', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-policy-bootstrap-mismatch-'))
  writeManagedRuntimeHome({
    bootstrap: { user: { displayName: 'Ada' } },
    hermesHome,
    manifest: manifest()
  })
  const policyPath = path.join(hermesHome, 'enterprise-policy.json')
  const original = fs.readFileSync(policyPath, 'utf8')
  const mismatched = bootstrapPolicy()
  mismatched.toolPolicySnapshot.policyHash = 'nested-mismatch'

  assert.throws(
    () => replaceManagedPolicySnapshot({ bootstrap: mismatched, hermesHome }),
    /bootstrap payload is invalid/
  )
  assert.equal(fs.readFileSync(policyPath, 'utf8'), original)
})

test('managed policy refresh preserves the original file when atomic rename fails', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-policy-rename-failure-'))
  writeManagedRuntimeHome({
    bootstrap: { user: { displayName: 'Ada' } },
    hermesHome,
    manifest: manifest()
  })
  const policyPath = path.join(hermesHome, 'enterprise-policy.json')
  const original = fs.readFileSync(policyPath, 'utf8')
  const fsImpl = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    readFileSync: fs.readFileSync,
    renameSync: () => {
      throw new Error('simulated atomic rename failure')
    },
    unlinkSync: fs.unlinkSync,
    writeFileSync: fs.writeFileSync
  }

  assert.throws(
    () => replaceManagedPolicySnapshot({
      bootstrap: bootstrapPolicy(),
      fsImpl,
      hermesHome
    }),
    /simulated atomic rename failure/
  )
  assert.equal(fs.readFileSync(policyPath, 'utf8'), original)
  assert.deepEqual(fs.readdirSync(hermesHome).filter(name => name.endsWith('.tmp')), [])
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
  assert.equal(state.providerRuntime, null)
  assert.equal(state.messagingChannelPolicy.status, 'fail-closed')
  assert.equal(state.messagingChannelPolicy.reason, 'policy_snapshot_incomplete')
  assert.deepEqual(state.messagingChannelPolicy.allowedChannelIds, [])
  assert.deepEqual(state.allowedModels, ['m1'])
})

test('managed runtime state requires both HTTP documents and matching policy snapshots', () => {
  const validBootstrap = { mode: 'managed', messagingChannelPolicy: managedPolicy }
  const validManifest = manifest()

  for (const [bootstrap, runtimeManifest] of [
    [null, validManifest],
    [validBootstrap, null],
    [{ mode: 'managed', messagingChannelPolicy: null }, validManifest],
    [validBootstrap, { ...validManifest, messagingChannelPolicy: null }]
  ]) {
    const decision = publicEnterpriseState({ bootstrap, manifest: runtimeManifest }).messagingChannelPolicy
    assert.equal(decision.status, 'fail-closed')
    assert.equal(decision.reason, 'policy_snapshot_incomplete')
    assert.deepEqual(decision.allowedChannelIds, [])
  }

  const differentPolicy = {
    ...managedPolicy,
    allowedChannelIds: [],
    userManageableChannelIds: [],
    visibleChannelIds: []
  }
  differentPolicy.policyHash = computeMessagingChannelPolicyHash(differentPolicy)
  const mismatch = publicEnterpriseState({
    bootstrap: validBootstrap,
    manifest: { ...validManifest, messagingChannelPolicy: differentPolicy }
  }).messagingChannelPolicy

  assert.equal(mismatch.status, 'fail-closed')
  assert.equal(mismatch.reason, 'policy_snapshot_mismatch')
})

test('managed runtime cannot be downgraded by a single unmanaged HTTP document', () => {
  const unmanaged = { mode: 'unmanaged', messagingChannelPolicy: null }

  for (const [bootstrap, runtimeManifest] of [
    [null, unmanaged],
    [unmanaged, null]
  ]) {
    const decision = publicEnterpriseState({ bootstrap, manifest: runtimeManifest }).messagingChannelPolicy

    assert.equal(decision.mode, 'managed')
    assert.equal(decision.status, 'fail-closed')
    assert.equal(decision.reason, 'policy_mode_mismatch')
    assert.deepEqual(decision.visibleChannelIds, [])
    assert.deepEqual(decision.allowedChannelIds, [])
  }
})

test('public enterprise state allowlists provider runtime operational metadata', () => {
  const state = publicEnterpriseState({
    bootstrap: { user: { displayName: 'Ada' } },
    manifest: manifest({
      providerRuntime: {
        presetKey: 'kimi-anthropic-compatible',
        presetVersion: '1.0.0',
        supportLevel: 'implemented-auto-verified',
        executionMode: 'shadow',
        endpointMode: 'translate',
        protocolKey: 'anthropic_messages',
        publicGatewayEndpoint: '/v1/messages',
        effectivePolicyHash: 'A'.repeat(64),
        runtimeHash: 'b'.repeat(64),
        warnings: [
          {
            code: 'provider_preset_legacy_fallback',
            safeSummary: 'A legacy profile was mapped to a safe compatibility preset.'
          },
          {
            code: 'unsafe-warning',
            safeSummary: 'Authorization: Bearer warning-secret-sentinel'
          }
        ],
        auth: { headerName: 'X-Credential-Sentinel', credential: 'credential-sentinel' },
        baseUrl: 'https://user:base-url-sentinel@gateway.example.com/v1?apiKey=query-sentinel',
        rawPolicy: {
          prompt: 'prompt-sentinel',
          tools: [{ name: 'tool-schema-sentinel' }]
        },
        unknownFutureField: { secret: 'unknown-field-sentinel' }
      }
    })
  })

  assert.deepEqual(state.providerRuntime, {
    presetKey: 'kimi-anthropic-compatible',
    presetVersion: '1.0.0',
    supportLevel: 'implemented-auto-verified',
    executionMode: 'shadow',
    endpointMode: 'translate',
    protocolKey: 'anthropic_messages',
    publicGatewayEndpoint: '/v1/messages',
    effectivePolicyHash: 'a'.repeat(64),
    runtimeHash: 'b'.repeat(64),
    warnings: [
      {
        code: 'provider_preset_legacy_fallback',
        safeSummary: 'A legacy profile was mapped to a safe compatibility preset.'
      },
      {
        code: 'unsafe-warning',
        safeSummary: 'Provider runtime policy warning.'
      }
    ]
  })
  const serialized = JSON.stringify(state.providerRuntime)
  for (const sentinel of [
    'warning-secret-sentinel',
    'credential-sentinel',
    'base-url-sentinel',
    'query-sentinel',
    'prompt-sentinel',
    'tool-schema-sentinel',
    'unknown-field-sentinel',
    'headerName',
    'rawPolicy'
  ]) {
    assert.equal(serialized.includes(sentinel), false)
  }
})

test('provider runtime metadata bounds collections and rejects hostile scalar coercion', () => {
  const bounded = publicEnterpriseState({
    manifest: manifest({
      providerRuntime: {
        presetKey: 'openai-compatible',
        publicGatewayEndpoint: `/${'x'.repeat(256)}`,
        warnings: Array.from({ length: 24 }, (_, index) => ({
          code: `safe-warning-${index}`,
          safeSummary: `Safe warning ${index}.`
        }))
      }
    })
  }).providerRuntime

  assert.equal(bounded.publicGatewayEndpoint, undefined)
  assert.equal(bounded.warnings.length, 16)
  assert.equal(bounded.warnings[15].code, 'safe-warning-15')

  const hostile = publicEnterpriseState({
    manifest: manifest({
      providerRuntime: {
        presetKey: 123,
        presetVersion: { toString: () => '1.0.0' },
        supportLevel: ['implemented-auto-verified'],
        executionMode: { value: 'canonical' },
        endpointMode: 42,
        protocolKey: ['chat_completions'],
        publicGatewayEndpoint: { path: '/v1/chat/completions' },
        effectivePolicyHash: { value: 'a'.repeat(64) },
        runtimeHash: 123,
        warnings: [
          { code: 123, safeSummary: 'Must be dropped.' },
          { code: 'object-summary', safeSummary: { secret: 'summary-object-sentinel' } }
        ]
      }
    })
  }).providerRuntime

  assert.deepEqual(hostile, {
    warnings: [{ code: 'object-summary', safeSummary: 'Provider runtime policy warning.' }]
  })
  assert.equal(JSON.stringify(hostile).includes('summary-object-sentinel'), false)
})

test('current provider runtime follows profile id when same-model profile order changes', () => {
  const profileA = {
    id: 'profile-a',
    apiMode: 'chat_completions',
    model: 'shared-model',
    providerRuntime: {
      presetKey: 'openai-official-chat',
      presetVersion: '1.0.0',
      supportLevel: 'implemented-auto-verified',
      executionMode: 'legacy',
      endpointMode: 'strict',
      protocolKey: 'chat_completions',
      publicGatewayEndpoint: '/v1/chat/completions',
      effectivePolicyHash: 'a'.repeat(64),
      runtimeHash: 'b'.repeat(64),
      warnings: []
    }
  }
  const profileB = {
    id: 'profile-b',
    apiMode: 'anthropic_messages',
    model: 'shared-model',
    providerRuntime: {
      presetKey: 'anthropic-official',
      presetVersion: '1.0.0',
      supportLevel: 'provider-certified',
      executionMode: 'canonical',
      endpointMode: 'translate',
      protocolKey: 'anthropic_messages',
      publicGatewayEndpoint: '/v1/messages',
      effectivePolicyHash: 'c'.repeat(64),
      runtimeHash: 'd'.repeat(64),
      warnings: []
    }
  }

  for (const modelProfiles of [[profileA, profileB], [profileB, profileA]]) {
    const state = publicEnterpriseState({
      manifest: manifest({
        allowedModels: ['shared-model'],
        currentModel: 'shared-model',
        currentModelProfileId: 'profile-b',
        defaultModel: 'shared-model',
        defaultModelProfileId: 'profile-a',
        modelProfiles,
        providerRuntime: undefined
      })
    })

    assert.equal(state.currentModelProfileId, 'profile-b')
    assert.equal(state.apiMode, 'anthropic_messages')
    assert.equal(state.providerRuntime.presetKey, 'anthropic-official')
    assert.equal(state.providerRuntime.executionMode, 'canonical')
    assert.equal(state.providerRuntime.endpointMode, 'translate')
  }
})

test('unknown current profile id does not fall back to a same-model profile', () => {
  const state = publicEnterpriseState({
    manifest: manifest({
      allowedModels: ['shared-model'],
      currentModel: 'shared-model',
      currentModelProfileId: 'missing-profile',
      defaultModel: 'shared-model',
      defaultModelProfileId: 'missing-profile',
      modelProfiles: [
        {
          id: 'different-profile',
          apiMode: 'anthropic_messages',
          model: 'shared-model',
          providerRuntime: {
            presetKey: 'anthropic-official',
            presetVersion: '1.0.0',
            supportLevel: 'provider-certified',
            executionMode: 'canonical',
            endpointMode: 'strict',
            protocolKey: 'anthropic_messages',
            publicGatewayEndpoint: '/v1/messages',
            effectivePolicyHash: 'a'.repeat(64),
            runtimeHash: 'b'.repeat(64),
            warnings: []
          }
        }
      ],
      providerRuntime: undefined
    })
  })

  assert.equal(state.currentModelProfileId, null)
  assert.equal(state.providerRuntime, null)
  assert.equal(state.apiMode, 'chat_completions')
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
  assert.match(config, /display:\n {2}language: "ja"/)
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
  assert.match(config, /display:\n {2}language: "zh"/)
})

test('managed runtime home is scoped by enterprise user identity', () => {
  assert.match(
    enterpriseUserPathSegment({ id: 'B4EBB599-6E5C-443F-A823-EE3D534FB6C5' }),
    /^b4ebb599-6e5c-443f-a823-ee3d534fb6c5-[a-f0-9]{16}$/
  )
  assert.match(enterpriseUserPathSegment({ userName: 'view@example.com' }), /^view-example\.com-[a-f0-9]{16}$/)
  assert.match(enterpriseUserPathSegment({ userName: '../其它 用户' }), /^user-[a-f0-9]{16}$/)
  assert.notEqual(
    resolveManagedHermesHome('/tmp/hermes', { id: 'user-a' }),
    resolveManagedHermesHome('/tmp/hermes', { id: 'user-b' })
  )
  assert.notEqual(
    resolveManagedHermesHome('/tmp/hermes', { id: 'a/b' }),
    resolveManagedHermesHome('/tmp/hermes', { id: 'a-b' })
  )
})

test('managed home upgrade atomically carries forward same-user enterprise skills', t => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-home-upgrade-'))
  t.after(() => fs.rmSync(userDataPath, { force: true, recursive: true }))
  const legacyHome = path.join(userDataPath, 'enterprise', 'users', 'user-a', 'hermes-home')
  writeManagedRuntimeHome({
    bootstrap: { user: { id: 'user-a', displayName: 'Ada' } },
    hermesHome: legacyHome,
    manifest: manifest()
  })
  const skillPath = path.join(legacyHome, 'skills', 'expense-review', 'SKILL.md')
  fs.mkdirSync(path.dirname(skillPath), { recursive: true })
  fs.writeFileSync(skillPath, '# Expense review', 'utf8')

  const upgradedHome = resolveManagedHermesHome(userDataPath, { id: 'user-a' })

  assert.notEqual(upgradedHome, legacyHome)
  assert.equal(fs.existsSync(legacyHome), false)
  assert.equal(fs.readFileSync(path.join(upgradedHome, 'skills', 'expense-review', 'SKILL.md'), 'utf8'), '# Expense review')
  assert.equal(readManagedPolicySnapshot({ expectedUserId: 'user-a', hermesHome: upgradedHome }).valid, true)
})

test('managed home upgrade never adopts a colliding legacy directory owned by another user', t => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-home-mismatch-'))
  t.after(() => fs.rmSync(userDataPath, { force: true, recursive: true }))
  const legacyHome = path.join(userDataPath, 'enterprise', 'users', 'a-b', 'hermes-home')
  writeManagedRuntimeHome({
    bootstrap: { user: { id: 'a/b', displayName: 'Legacy owner' } },
    hermesHome: legacyHome,
    manifest: manifest()
  })
  const skillPath = path.join(legacyHome, 'skills', 'private-skill', 'SKILL.md')
  fs.mkdirSync(path.dirname(skillPath), { recursive: true })
  fs.writeFileSync(skillPath, '# Private', 'utf8')

  const currentHome = resolveManagedHermesHome(userDataPath, { id: 'a-b' })

  assert.notEqual(currentHome, legacyHome)
  assert.equal(fs.existsSync(currentHome), false)
  assert.equal(fs.existsSync(skillPath), true)
  assert.equal(readManagedPolicySnapshot({ expectedUserId: 'a-b', hermesHome: legacyHome }).valid, false)
})
