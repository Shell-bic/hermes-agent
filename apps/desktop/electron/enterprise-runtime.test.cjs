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

test('resolveEnterpriseRuntimeOptions enables managed mode from gateway url env', () => {
  assert.deepEqual(resolveEnterpriseRuntimeOptions({ HERMES_ENTERPRISE_GATEWAY_URL: 'https://gw.example.com/' }), {
    enabled: true,
    gatewayUrl: 'https://gw.example.com'
  })
  assert.deepEqual(resolveEnterpriseRuntimeOptions({}), { enabled: false, gatewayUrl: '' })
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
      return { lockedSurfaces: ['providers'], policyVersion: 'pv-1', user: { displayName: 'Ada' } }
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

test('enterprise runtime scopes managed Hermes home by desktop user when userDataPath is used', async () => {
  let currentUser = { id: 'user-a', displayName: 'User A' }
  const authStore = {
    readSession: () => ({ desktopToken: 'desktop-token', user: currentUser })
  }
  const client = {
    bootstrap: async () => ({ user: currentUser }),
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
      return { lockedSurfaces: ['providers'], policyVersion: 'pv-2', user: { displayName: 'Ada' } }
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
          modelProfiles: payload.manifest.modelProfiles.map(({ providerSecret, ...profile }) => profile),
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
