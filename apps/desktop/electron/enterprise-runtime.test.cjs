const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  createEnterpriseRuntime,
  extractModelProfilesResponse,
  resolveEnterpriseRuntimeOptions,
  runtimeManifestRequestBody,
  unauthenticatedState
} = require('./enterprise-runtime.cjs')

// Mirrors the U5 P2 Gateway DesktopBootstrapResponse contract. It deliberately
// is not a compatibility fixture for the older P1 bootstrap shape, which did
// not carry the strict policy metadata and tool-policy snapshot.
function validBootstrap(overrides = {}) {
  const generatedAt = overrides.generatedAt || '2026-07-14T08:00:00Z'
  const policyHash = overrides.policyHash || 'bootstrap-policy-hash'
  const policyVersion = overrides.policyVersion || 'role-policy.v1'
  const snapshotOverrides = overrides.toolPolicySnapshot || {}

  return {
    capabilities: ['skills.manage'],
    generatedAt,
    lockedSurfaces: ['skills'],
    policyHash,
    policyVersion,
    user: { displayName: 'Ada' },
    ...overrides,
    toolPolicySnapshot: {
      capabilityFlags: [],
      generatedAt,
      mcpServers: [],
      policyHash,
      policyVersion: `tool-policy.v1+roles:${policyVersion}`,
      skills: [],
      tools: [],
      toolSets: [],
      ...snapshotOverrides
    }
  }
}

test('valid bootstrap fixture represents the U5 P2 Gateway dual-version policy contract', () => {
  const bootstrap = validBootstrap()

  assert.equal(bootstrap.policyVersion, 'role-policy.v1')
  assert.equal(bootstrap.toolPolicySnapshot.policyVersion, 'tool-policy.v1+roles:role-policy.v1')
  assert.equal(bootstrap.policyHash, bootstrap.toolPolicySnapshot.policyHash)
  assert.equal(bootstrap.generatedAt, bootstrap.toolPolicySnapshot.generatedAt)
  assert.deepEqual(
    Object.keys(bootstrap.toolPolicySnapshot).filter(key => [
      'capabilityFlags',
      'mcpServers',
      'skills',
      'tools',
      'toolSets'
    ].includes(key)).sort(),
    ['capabilityFlags', 'mcpServers', 'skills', 'toolSets', 'tools']
  )
})

test('resolveEnterpriseRuntimeOptions enables managed mode from gateway url env', () => {
  assert.deepEqual(resolveEnterpriseRuntimeOptions({ HERMES_ENTERPRISE_GATEWAY_URL: 'https://gw.example.com/' }), {
    enabled: true,
    gatewayUrl: 'https://gw.example.com'
  })
  assert.deepEqual(resolveEnterpriseRuntimeOptions({}), { enabled: false, gatewayUrl: '' })
})

test('resolveEnterpriseRuntimeOptions loads machine config without requiring a terminal environment', () => {
  const readFileSync = filePath => {
    if (filePath !== 'machine.json') {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    return JSON.stringify({ schemaVersion: 1, enabled: true, gatewayUrl: 'https://machine-gateway.example.com/' })
  }

  assert.deepEqual(resolveEnterpriseRuntimeOptions({}, { configPaths: ['machine.json'], readFileSync }), {
    enabled: true,
    gatewayUrl: 'https://machine-gateway.example.com'
  })
})

test('resolveEnterpriseRuntimeOptions keeps machine deployment config over user environment', () => {
  const readFileSync = () => JSON.stringify({ schemaVersion: 1, gatewayUrl: 'https://machine.example.com' })

  assert.deepEqual(
    resolveEnterpriseRuntimeOptions(
      { HERMES_ENTERPRISE_GATEWAY_URL: 'https://override.example.com' },
      { configPaths: ['machine.json'], readFileSync }
    ),
    { enabled: true, gatewayUrl: 'https://machine.example.com' }
  )
})

test('resolveEnterpriseRuntimeOptions uses environment only when no deployment config exists', () => {
  const readFileSync = () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  }

  assert.deepEqual(
    resolveEnterpriseRuntimeOptions(
      { HERMES_ENTERPRISE_GATEWAY_URL: 'https://dev-gateway.example.com/' },
      { configPaths: ['machine.json', 'portable.json', 'user.json'], readFileSync }
    ),
    { enabled: true, gatewayUrl: 'https://dev-gateway.example.com' }
  )
})

test('resolveEnterpriseRuntimeOptions lets an explicit disabled deployment config block environment fallback', () => {
  const readFileSync = filePath => {
    if (filePath === 'machine.json') {
      return JSON.stringify({ schemaVersion: 1, enabled: false })
    }
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  }

  assert.deepEqual(
    resolveEnterpriseRuntimeOptions(
      { HERMES_ENTERPRISE_GATEWAY_URL: 'https://user-override.example.com' },
      { configPaths: ['machine.json', 'portable.json'], readFileSync }
    ),
    { enabled: false, gatewayUrl: '' }
  )
})

test('resolveEnterpriseRuntimeOptions rejects unsafe environment gateway URLs', () => {
  for (const [gatewayUrl, message] of [
    ['http://10.0.0.5:5100', /must use https/],
    ['https://user:password@gateway.example.com', /must not contain credentials/],
    ['https://gateway.example.com?tenant=one', /must not contain a query or fragment/],
    ['https://gateway.example.com#login', /must not contain a query or fragment/],
    ['https://gateway.example.com/wecom', /must be an origin without a path/]
  ]) {
    assert.throws(() => resolveEnterpriseRuntimeOptions({ HERMES_ENTERPRISE_GATEWAY_URL: gatewayUrl }), message)
  }

  assert.throws(
    () =>
      resolveEnterpriseRuntimeOptions({
        HERMES_DESKTOP_ENTERPRISE_GATEWAY_URL: 'https://legacy.example.com/unsafe-path'
      }),
    /must be an origin without a path/
  )
})

test('enterprise unauthenticated state carries the default ui policy', () => {
  const state = unauthenticatedState()

  assert.deepEqual(state.uiPolicy, {
    defaultLocale: 'zh',
    allowLanguageChange: true,
    lockedLocale: false
  })
  assert.equal(state.toolPolicySnapshot, null)
  assert.equal(state.policyHash, null)
  assert.equal(state.generatedAt, null)
})

test('enterprise runtime extracts model profiles from common gateway response shapes', () => {
  const profiles = [{ id: 'm1', model: 'm1', name: 'Model 1' }]

  assert.deepEqual(extractModelProfilesResponse(profiles), profiles)
  assert.deepEqual(extractModelProfilesResponse({ modelProfiles: profiles }), profiles)
  assert.deepEqual(extractModelProfilesResponse({ profiles }), profiles)
  assert.deepEqual(extractModelProfilesResponse({ items: profiles }), profiles)
  assert.deepEqual(extractModelProfilesResponse({ models: profiles }), profiles)
  assert.deepEqual(extractModelProfilesResponse({ results: profiles }), profiles)
  assert.deepEqual(extractModelProfilesResponse({ data: { modelProfiles: profiles } }), profiles)
  assert.deepEqual(extractModelProfilesResponse(null), [])
})

test('enterprise runtime prepares managed launch without exposing gateway token publicly', async () => {
  const authStore = {
    readPublicSession: () => ({ user: { displayName: 'Ada' } }),
    readSession: () => ({ desktopToken: 'desktop-token', user: { displayName: 'Ada' } }),
    writeSession: () => undefined
  }
  const calls = []
  const client = {
    bootstrap: async token => {
      calls.push(['bootstrap', token])
      return validBootstrap({ lockedSurfaces: ['providers'], policyVersion: 'pv-1' })
    },
    modelProfiles: async token => {
      calls.push(['profiles', token])
      return { modelProfiles: [{ id: 'm1', model: 'm1', name: 'Model 1' }] }
    },
    runtimeManifest: async (token, body) => {
      calls.push(['manifest', token, body])
      return {
        allowedModels: ['m1'],
        defaultModel: 'm1',
        gatewayApiBaseUrl: 'https://gw.example.com',
        gatewayToken: 'gateway-token',
        manifestId: 'mf-1',
        sessionId: 'sess-1'
      }
    }
  }
  const runtime = createEnterpriseRuntime({
    authStore,
    client,
    enabled: true,
    gatewayUrl: 'https://gw.example.com',
    homeWriter: ({ manifest }) => ({
      env: { COMPANY_GATEWAY_TOKEN: manifest.gatewayToken, HERMES_HOME: 'managed-home' },
      hermesHome: 'managed-home',
      publicState: {
        allowedModels: manifest.allowedModels,
        authenticated: true,
        enabled: true,
        lockedSurfaces: ['providers'],
        status: 'authenticated',
        user: { displayName: 'Ada' }
      }
    }),
    managedHermesHome: 'managed-home'
  })

  const launch = await runtime.prepareLaunch({ preferredModel: 'm1' })

  assert.equal(launch.hermesHome, 'managed-home')
  assert.equal(launch.env.COMPANY_GATEWAY_TOKEN, 'gateway-token')
  assert.equal(JSON.stringify(launch.publicState).includes('gateway-token'), false)
  assert.deepEqual(calls, [
    ['bootstrap', 'desktop-token'],
    ['profiles', 'desktop-token'],
    ['manifest', 'desktop-token', { preferredModel: 'm1', preferredModelProfileId: 'm1' }]
  ])
})

test('enterprise runtime accepts a WeCom session through the same private session writer', async () => {
  const writes = []
  const runtime = createEnterpriseRuntime({
    authStore: {
      readSession: () => null,
      writeSession: session => writes.push(session)
    },
    client: {},
    enabled: true,
    gatewayUrl: 'https://gw.example.com'
  })

  const state = await runtime.acceptLoginSession({
    desktopToken: 'dsk_secret',
    expiresAt: '2099-07-13T00:00:00Z',
    user: { displayName: 'Ada' }
  })
  assert.equal(state.authenticated, true)
  assert.deepEqual(state.user, { displayName: 'Ada' })
  assert.equal(JSON.stringify(state).includes('dsk_secret'), false)
  assert.equal(writes.length, 1)
})

test('enterprise runtime revokes a newly issued session when secure persistence fails', async () => {
  const calls = []
  const runtime = createEnterpriseRuntime({
    authStore: {
      clear: () => calls.push(['clear']),
      writeSession: () => {
        throw new Error('secure storage unavailable')
      }
    },
    client: {
      logout: async token => calls.push(['logout', token])
    },
    enabled: true,
    gatewayUrl: 'https://gw.example.com'
  })

  await assert.rejects(
    runtime.acceptLoginSession({ desktopToken: 'dsk_orphan', user: { displayName: 'Ada' } }),
    /secure storage unavailable/
  )
  assert.deepEqual(calls, [['clear'], ['logout', 'dsk_orphan']])
  assert.equal(runtime.getPublicState().authenticated, false)
})

test('enterprise runtime clears a rejected stored session instead of treating it as offline', async () => {
  let cleared = 0
  const runtime = createEnterpriseRuntime({
    authStore: {
      clear: () => (cleared += 1),
      readSession: () => ({ desktopToken: 'dsk_stale' })
    },
    client: {
      me: async () => {
        throw Object.assign(new Error('Unauthorized'), { status: 401 })
      }
    },
    enabled: true,
    gatewayUrl: 'https://gw.example.com'
  })

  const state = await runtime.refreshPublicState()
  assert.equal(state.authenticated, false)
  assert.equal(cleared, 1)
})

test('enterprise runtime rejects an invalid initial bootstrap before profiles, manifest, or home writes', async () => {
  const calls = []
  const runtime = createEnterpriseRuntime({
    authStore: {
      readSession: () => ({ desktopToken: 'desktop-token', user: { displayName: 'Ada' } })
    },
    client: {
      bootstrap: async () => {
        calls.push('bootstrap')
        return validBootstrap({ lockedSurfaces: { invalid: true } })
      },
      modelProfiles: async () => {
        calls.push('profiles')
        return { modelProfiles: [] }
      },
      runtimeManifest: async () => {
        calls.push('manifest')
        return {}
      }
    },
    enabled: true,
    homeWriter: () => {
      calls.push('homeWriter')
      return {}
    },
    managedHermesHome: 'managed-home'
  })

  await assert.rejects(
    () => runtime.prepareLaunch(),
    error => {
      assert.equal(error.code, 'enterprise_policy_payload_invalid')
      assert.equal(error.message, 'Enterprise policy bootstrap payload is invalid.')
      return true
    }
  )
  assert.deepEqual(calls, ['bootstrap'])
})

test('enterprise runtime manifest body sends preferredModel only when selected', () => {
  assert.deepEqual(runtimeManifestRequestBody({ preferredModel: '  claude-sonnet  ' }), {
    preferredModel: 'claude-sonnet'
  })
  assert.deepEqual(
    runtimeManifestRequestBody({
      modelProfiles: [{ id: 'profile-1', model: 'kimi-for-coding', name: 'Kimi' }],
      preferredModel: 'enterprise-profile:profile-1'
    }),
    {
      preferredModel: 'kimi-for-coding',
      preferredModelProfileId: 'profile-1'
    }
  )
  assert.deepEqual(runtimeManifestRequestBody({ preferredModel: '' }), {})
  assert.deepEqual(runtimeManifestRequestBody({ profile: 'default' }), {})
  assert.deepEqual(runtimeManifestRequestBody(), {})
})

test('enterprise selectModel IPC refreshes manifest state without tearing down the backend', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf("ipcMain.handle('hermes:enterprise:selectModel'")
  assert.notEqual(start, -1, 'missing hermes:enterprise:selectModel IPC handler')
  const end = source.indexOf("ipcMain.handle('hermes:enterprise:logout'", start)
  assert.notEqual(end, -1, 'missing following enterprise logout IPC handler')
  const handler = source.slice(start, end)

  assert.match(handler, /enterpriseRuntime\.selectModel\(model\)/)
  assert.doesNotMatch(handler, /teardownPrimaryBackendAndWait\(/)
})

test('enterprise getConnection awaits policy preparation before runtime resolution and Python spawn', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf('async function startHermes()')
  assert.notEqual(start, -1, 'missing startHermes')
  const end = source.indexOf('\nasync function ', start + 1)
  assert.notEqual(end, -1, 'missing function after startHermes')
  const startHermes = source.slice(start, end)
  const prepare = startHermes.indexOf('enterpriseLaunch = await enterpriseRuntime.prepareLaunch()')
  const resolveRuntime = startHermes.indexOf('await ensureRuntime(')
  const spawnBackend = startHermes.indexOf('hermesProcess = spawn(')

  assert.ok(prepare >= 0, 'startHermes must await enterprise prepareLaunch')
  assert.ok(resolveRuntime > prepare, 'runtime resolution must occur only after prepareLaunch succeeds')
  assert.ok(spawnBackend > resolveRuntime, 'Python backend spawn must occur only after runtime resolution')
})

test('enterprise policy refresh IPC is trusted and does not restart the backend', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf("ipcMain.handle('hermes:enterprise:refreshPolicy'")
  assert.notEqual(start, -1, 'missing hermes:enterprise:refreshPolicy IPC handler')
  const end = source.indexOf("ipcMain.handle('hermes:enterprise:login'", start)
  assert.notEqual(end, -1, 'missing following enterprise login IPC handler')
  const handler = source.slice(start, end)

  assert.match(handler, /assertTrustedEnterpriseSender\(event\)/)
  assert.match(handler, /enterpriseRuntime\.refreshPolicy\(\)/)
  assert.doesNotMatch(handler, /teardownPrimaryBackendAndWait\(/)
  assert.doesNotMatch(handler, /startHermes\(/)

  const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8')
  assert.match(preload, /refreshPolicy:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('hermes:enterprise:refreshPolicy'\)/)
})

test('enterprise policy refresh uses authenticated bootstrap and exposes current metadata', async () => {
  const calls = []
  const policy = {
    capabilities: ['skills.use'],
    generatedAt: '2026-07-14T08:00:00Z',
    lockedSurfaces: ['skills'],
    policyHash: 'hash-2',
    policyVersion: 'pv-2',
    role: { name: 'Employee' },
    toolPolicySnapshot: { generatedAt: '2026-07-14T08:00:00Z', policyHash: 'hash-2', policyVersion: 'pv-2' },
    uiPolicy: { defaultLocale: 'zh', allowLanguageChange: false, lockedLocale: true },
    user: { displayName: 'Ada' }
  }
  const runtime = createEnterpriseRuntime({
    authStore: { readSession: () => ({ desktopToken: 'desktop-token', user: { displayName: 'Ada' } }) },
    client: {
      bootstrap: async token => {
        calls.push(['bootstrap', token])
        return { policyVersion: 'pv-2', toolPolicySnapshot: policy.toolPolicySnapshot }
      }
    },
    enabled: true,
    managedHermesHome: 'managed-home',
    policyReader: () => ({ policy: null, valid: false }),
    policyWriter: payload => {
      calls.push(['write', payload.hermesHome])
      return { generatedAt: policy.generatedAt, policy, policyHash: policy.policyHash, policyVersion: policy.policyVersion }
    }
  })

  const state = await runtime.refreshPolicy()

  assert.deepEqual(calls, [['bootstrap', 'desktop-token'], ['write', 'managed-home']])
  assert.equal(state.policyRefreshStatus, 'current')
  assert.equal(state.policyStale, false)
  assert.equal(state.policyVersion, 'pv-2')
  assert.equal(state.policyHash, 'hash-2')
  assert.equal(state.generatedAt, '2026-07-14T08:00:00Z')
  assert.equal(JSON.stringify(state).includes('desktop-token'), false)
})

test('enterprise policy refresh retains last-known-good on failure and fails closed without one', async () => {
  const cachedPolicy = {
    generatedAt: '2026-07-13T08:00:00Z',
    lockedSurfaces: ['skills'],
    policyHash: 'hash-lkg',
    policyVersion: 'pv-lkg',
    toolPolicySnapshot: { generatedAt: '2026-07-13T08:00:00Z', policyHash: 'hash-lkg', policyVersion: 'pv-lkg' }
  }
  let hasCachedPolicy = true
  const logs = []
  const runtime = createEnterpriseRuntime({
    authStore: { readSession: () => ({ desktopToken: 'desktop-token' }) },
    client: {
      bootstrap: async () => {
        const error = new Error('server echoed desktop-token')
        error.code = 'desktop-token-SECRET-remote-controlled-error-code'
        error.status = 503
        throw error
      }
    },
    enabled: true,
    managedHermesHome: 'managed-home',
    policyReader: () => hasCachedPolicy
      ? { policy: cachedPolicy, valid: true }
      : { policy: null, valid: false },
    policyWriter: () => {
      throw new Error('must not write')
    },
    rememberLog: line => logs.push(line)
  })

  const stale = await runtime.refreshPolicy()
  assert.equal(stale.policyRefreshStatus, 'stale')
  assert.equal(stale.policyStale, true)
  assert.equal(stale.policyHash, 'hash-lkg')
  assert.equal(stale.policyRefreshError, 'Enterprise policy refresh failed (HTTP 503).')

  hasCachedPolicy = false
  const failed = await runtime.refreshPolicy()
  assert.equal(failed.policyRefreshStatus, 'failed')
  assert.equal(failed.policyStale, false)
  assert.equal(failed.policyHash, null)
  assert.equal(failed.toolPolicySnapshot, null)
  assert.equal(logs.join('\n').includes('desktop-token'), false)
  assert.equal(logs.join('\n').includes('SECRET'), false)
  assert.match(logs.join('\n'), /category=http_error status=503/)
})

test('enterprise policy refresh is single-flight across concurrent renderer requests', async () => {
  let releaseBootstrap
  let bootstrapCalls = 0
  let writes = 0
  const bootstrapPending = new Promise(resolve => {
    releaseBootstrap = resolve
  })
  const policy = {
    generatedAt: '2026-07-14T08:00:00Z',
    policyHash: 'hash-concurrent',
    policyVersion: 'pv-concurrent',
    toolPolicySnapshot: { generatedAt: '2026-07-14T08:00:00Z', policyHash: 'hash-concurrent', policyVersion: 'pv-concurrent' }
  }
  const runtime = createEnterpriseRuntime({
    authStore: { readSession: () => ({ desktopToken: 'desktop-token' }) },
    client: {
      bootstrap: async () => {
        bootstrapCalls += 1
        return bootstrapPending
      }
    },
    enabled: true,
    managedHermesHome: 'managed-home',
    policyReader: () => ({ policy: null, valid: false }),
    policyWriter: () => {
      writes += 1
      return { generatedAt: policy.generatedAt, policy, policyHash: policy.policyHash, policyVersion: policy.policyVersion }
    }
  })

  const first = runtime.refreshPolicy()
  const second = runtime.refreshPolicy()
  assert.equal(first, second)
  assert.equal(bootstrapCalls, 1)

  releaseBootstrap({ policyHash: 'hash-concurrent' })
  const [firstState, secondState] = await Promise.all([first, second])
  assert.equal(writes, 1)
  assert.equal(firstState.policyHash, 'hash-concurrent')
  assert.equal(secondState.policyHash, 'hash-concurrent')
})

test('enterprise runtime scopes managed Hermes home by desktop user when userDataPath is used', async () => {
  let currentUser = { id: 'user-a', displayName: 'User A' }
  const authStore = {
    readSession: () => ({ desktopToken: 'desktop-token', user: currentUser })
  }
  const client = {
    bootstrap: async () => validBootstrap({ user: currentUser }),
    modelProfiles: async () => ({ modelProfiles: [{ id: 'm1', model: 'm1', name: 'Model 1' }] }),
    runtimeManifest: async () => ({
      allowedModels: ['m1'],
      defaultModel: 'm1',
      gatewayApiBaseUrl: 'https://gw.example.com',
      gatewayToken: 'gateway-token',
      manifestId: 'mf-1',
      sessionId: 'sess-1'
    })
  }
  const homes = []
  const runtime = createEnterpriseRuntime({
    authStore,
    client,
    enabled: true,
    gatewayUrl: 'https://gw.example.com',
    homeWriter: payload => {
      homes.push(payload.hermesHome)
      return {
        env: { HERMES_HOME: payload.hermesHome },
        hermesHome: payload.hermesHome,
        publicState: {
          allowedModels: ['m1'],
          authenticated: true,
          enabled: true,
          lockedSurfaces: [],
          status: 'authenticated',
          user: currentUser
        }
      }
    },
    userDataPath: '/tmp/hermes-user-data'
  })

  await runtime.prepareLaunch()
  currentUser = { id: 'user-b', displayName: 'User B' }
  await runtime.prepareLaunch()

  assert.equal(homes[0], path.join('/tmp/hermes-user-data', 'enterprise', 'users', 'user-a', 'hermes-home'))
  assert.equal(homes[1], path.join('/tmp/hermes-user-data', 'enterprise', 'users', 'user-b', 'hermes-home'))
})

test('enterprise runtime selectModel validates policy and rewrites managed home without public secrets', async () => {
  const authStore = {
    readSession: () => ({ desktopToken: 'desktop-token', user: { displayName: 'Ada' } })
  }
  const calls = []
  const client = {
    bootstrap: async token => {
      calls.push(['bootstrap', token])
      return validBootstrap({ lockedSurfaces: ['providers'], policyVersion: 'pv-2' })
    },
    modelProfiles: async token => {
      calls.push(['profiles', token])
      return {
        modelProfiles: [
          {
            id: 'profile-1',
            apiFormat: 'openai-chat',
            capabilities: { reasoning: true },
            displayName: 'Model 1',
            model: 'm1',
            providerName: 'OpenAI',
            runtimeDefaults: { reasoningEffort: 'medium' }
          },
          {
            id: 'profile-2',
            apiFormat: 'anthropic-messages',
            displayName: 'Model 2',
            model: 'm2',
            providerName: 'Anthropic'
          }
        ]
      }
    },
    runtimeManifest: async (token, body) => {
      calls.push(['manifest', token, body])
      return {
        allowedModels: ['m1', 'm2'],
        auxiliaryPolicy: { mode: 'follow-main' },
        capabilities: { reasoning: true },
        defaultModel: body.preferredModel,
        gatewayApiBaseUrl: 'https://gw.example.com',
        gatewayToken: 'gateway-token',
        manifestId: 'mf-2',
        modelProfiles: [
          {
            id: 'profile-2',
            apiFormat: 'anthropic-messages',
            displayName: 'Model 2',
            model: 'm2',
            providerName: 'Anthropic',
            providerSecret: 'do-not-render'
          }
        ],
        runtimeDefaults: { serviceTier: 'auto' },
        sessionId: 'sess-2'
      }
    }
  }
  const writes = []
  const runtime = createEnterpriseRuntime({
    authStore,
    client,
    enabled: true,
    gatewayUrl: 'https://gw.example.com',
    homeWriter: payload => {
      writes.push(payload)
      return {
        env: { COMPANY_GATEWAY_TOKEN: payload.manifest.gatewayToken, HERMES_HOME: payload.hermesHome },
        hermesHome: payload.hermesHome,
        publicState: {
          allowedModels: payload.manifest.allowedModels,
          authenticated: true,
          auxiliaryPolicy: payload.manifest.auxiliaryPolicy,
          capabilities: payload.manifest.capabilities,
          currentModel: payload.manifest.defaultModel,
          currentModelProfileId: 'profile-2',
          defaultModel: payload.manifest.defaultModel,
          enabled: true,
          lockedSurfaces: ['providers'],
          modelProfiles: payload.manifest.modelProfiles.map(profile =>
            Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'providerSecret'))
          ),
          policyVersion: 'pv-2',
          role: null,
          runtimeDefaults: payload.manifest.runtimeDefaults,
          status: 'authenticated',
          user: { displayName: 'Ada' }
        }
      }
    },
    managedHermesHome: 'managed-home'
  })

  await runtime.prepareLaunch({ preferredModel: 'm1' })
  const state = await runtime.selectModel('m2')
  await runtime.prepareLaunch()

  assert.equal(writes.length, 3)
  assert.equal(writes[1].manifest.defaultModel, 'm2')
  assert.equal(writes[2].manifest.defaultModel, 'm2')
  assert.equal(writes[1].hermesHome, 'managed-home')
  assert.equal(state.currentModel, 'm2')
  assert.equal(JSON.stringify(state).includes('gateway-token'), false)
  assert.equal(JSON.stringify(state).includes('do-not-render'), false)
  assert.deepEqual(calls, [
    ['bootstrap', 'desktop-token'],
    ['profiles', 'desktop-token'],
    ['manifest', 'desktop-token', { preferredModel: 'm1', preferredModelProfileId: 'profile-1' }],
    ['bootstrap', 'desktop-token'],
    ['profiles', 'desktop-token'],
    ['manifest', 'desktop-token', { preferredModel: 'm2', preferredModelProfileId: 'profile-2' }],
    ['bootstrap', 'desktop-token'],
    ['profiles', 'desktop-token'],
    ['manifest', 'desktop-token', { preferredModel: 'm2', preferredModelProfileId: 'profile-2' }]
  ])
  await assert.rejects(() => runtime.selectModel('not-allowed'), /not allowed by enterprise policy/)
})

test('enterprise runtime rejects invalid selectModel bootstrap before profiles, manifest, or home writes', async () => {
  const payloadSentinel = 'remote-invalid-bootstrap-payload-sentinel'
  const calls = []
  const runtime = createEnterpriseRuntime({
    authStore: {
      readSession: () => ({ desktopToken: 'desktop-token', user: { displayName: 'Ada' } })
    },
    client: {
      bootstrap: async () => {
        calls.push('bootstrap')
        return validBootstrap({ capabilities: [`../${payloadSentinel}`] })
      },
      modelProfiles: async () => {
        calls.push('profiles')
        return { modelProfiles: [] }
      },
      runtimeManifest: async () => {
        calls.push('manifest')
        return {}
      }
    },
    enabled: true,
    homeWriter: () => {
      calls.push('homeWriter')
      return {}
    },
    managedHermesHome: 'managed-home'
  })
  runtime.lastPublicState = {
    ...runtime.lastPublicState,
    allowedModels: ['m2'],
    authenticated: true,
    modelProfiles: [{ id: 'profile-2', model: 'm2' }],
    status: 'authenticated'
  }

  await assert.rejects(
    () => runtime.selectModel('m2'),
    error => {
      assert.equal(error.code, 'enterprise_policy_payload_invalid')
      assert.equal(error.message, 'Enterprise policy bootstrap payload is invalid.')
      assert.equal(error.message.includes(payloadSentinel), false)
      return true
    }
  )
  assert.deepEqual(calls, ['bootstrap'])
})

test('enterprise runtime binds managed identity before every managed home write', async () => {
  const calls = []
  const runtime = createEnterpriseRuntime({
    authStore: {
      readSession: () => ({ desktopToken: 'desktop-token', user: { id: 'user-a' } })
    },
    client: {
      bootstrap: async () => {
        calls.push('bootstrap')
        return validBootstrap({ user: { id: 'user-a' } })
      },
      modelProfiles: async () => {
        calls.push('profiles')
        return { modelProfiles: [] }
      },
      runtimeManifest: async () => {
        calls.push('manifest')
        return {}
      }
    },
    enabled: true,
    homeWriter: () => {
      calls.push('homeWriter')
      return {}
    },
    managedHermesHome: 'managed-home',
    managedIdentityBinder: identity => {
      calls.push(['identity', identity])
      const error = new Error('identity rejected before write')
      error.code = 'enterprise_profile_not_managed'
      throw error
    }
  })

  await assert.rejects(
    () => runtime.prepareLaunch(),
    error => error.code === 'enterprise_profile_not_managed'
  )
  assert.deepEqual(calls, [
    'bootstrap',
    'profiles',
    'manifest',
    ['identity', { hermesHome: 'managed-home', user: { id: 'user-a' } }]
  ])
})
