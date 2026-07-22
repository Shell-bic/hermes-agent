const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DESKTOP_BOOTSTRAP_CONTRACT_HEADER,
  DESKTOP_BOOTSTRAP_CONTRACT_VERSION,
  DESKTOP_CAPABILITIES_HEADER,
  DESKTOP_CLIENT_CAPABILITIES,
  EnterpriseGatewayError,
  createEnterpriseGatewayClient,
  normalizeEnterpriseGatewayBaseUrl,
  normalizeLoginMethodsResponse,
  normalizeMeResponse
} = require('./enterprise-gateway-client.cjs')

function jsonResponse(payload, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => JSON.stringify(payload)
  }
}

test('enterprise Gateway URL requires HTTPS except for localhost or explicitly allowed private IP rehearsal', () => {
  assert.equal(
    normalizeEnterpriseGatewayBaseUrl('https://gateway.example.com/path/'),
    'https://gateway.example.com/path'
  )
  assert.equal(normalizeEnterpriseGatewayBaseUrl('http://localhost:5100/'), 'http://localhost:5100')
  assert.equal(normalizeEnterpriseGatewayBaseUrl('http://127.0.0.1:5100/'), 'http://127.0.0.1:5100')
  assert.throws(() => normalizeEnterpriseGatewayBaseUrl('http://10.0.0.5:5100'), /must use https/)
  assert.equal(
    normalizeEnterpriseGatewayBaseUrl('http://172.31.1.49:6500/', { allowInsecureLanHttp: true }),
    'http://172.31.1.49:6500'
  )
  assert.equal(
    normalizeEnterpriseGatewayBaseUrl('http://192.168.1.20:6500', { allowInsecureLanHttp: true }),
    'http://192.168.1.20:6500'
  )
  assert.throws(
    () => normalizeEnterpriseGatewayBaseUrl('http://8.8.8.8:6500', { allowInsecureLanHttp: true }),
    /must use https/
  )
  assert.throws(
    () => normalizeEnterpriseGatewayBaseUrl('http://gateway.example.com:6500', { allowInsecureLanHttp: true }),
    /must use https/
  )
})

test('login methods normalize only explicitly enabled known methods and keep auth origin main-only', () => {
  assert.deepEqual(
    normalizeLoginMethodsResponse({
      defaultMethod: 'unknown',
      enterpriseDisplayName: 'Example Corp',
      methods: [
        { enabled: true, id: 'wecom-qr' },
        { enabled: false, id: 'password' },
        { enabled: true, id: 'unknown' }
      ],
      weComAuthorizationOrigin: 'https://auth.example.com'
    }),
    {
      defaultMethod: 'wecom-qr',
      enterpriseDisplayName: 'Example Corp',
      methods: ['wecom-qr'],
      weComAuthorizationOrigin: 'https://auth.example.com'
    }
  )
})

test('account response normalizes the formal bare UserSummary contract', async () => {
  const user = { displayName: 'Fixture User', id: 'user-a', userName: 'fixture' }
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async () => jsonResponse(user)
  })

  assert.deepEqual(await client.me('dsk_session'), { user })
})

test('account response keeps compatibility with user and account wrappers', () => {
  assert.deepEqual(normalizeMeResponse({ user: { id: 'user-a' } }), { user: { id: 'user-a' } })
  assert.deepEqual(normalizeMeResponse({ account: { accountId: 'account-a' } }), {
    user: { accountId: 'account-a' }
  })
})

test('account response rejects empty and malformed identities without session fallback', () => {
  const malformed = [null, [], {}, { id: '  ' }, { user: null }, { user: [] }, { user: {} }, { account: { id: {} } }]
  for (const payload of malformed) {
    assert.throws(
      () => normalizeMeResponse(payload),
      error => error instanceof EnterpriseGatewayError && error.code === 'enterprise_gateway_contract_invalid'
    )
  }
})

test('WeCom client uses the frozen Gateway routes and request bodies', async () => {
  const calls = []
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async (url, options) => {
      calls.push([url, options])
      if (url.endsWith('/methods')) {
        return jsonResponse({ methods: ['password'] })
      }
      if (url.endsWith('/start')) {
        return jsonResponse({ transactionId: 'tx' })
      }
      if (url.includes('/status/')) {
        return jsonResponse({ status: 'pending' })
      }
      if (url.endsWith('/redeem')) {
        return jsonResponse({ desktopToken: 'dsk_secret', user: { displayName: 'Ada' } })
      }
      return jsonResponse({ ok: true })
    }
  })

  await client.loginMethods()
  await client.startWeCom({ challenge: 'challenge' })
  await client.weComStatus('tx/value')
  await client.redeemWeCom({ transactionId: 'tx', verifier: 'verifier' })
  await client.cancelWeCom('tx')

  assert.equal(calls[0][0], 'https://gateway.example.com/api/desktop/auth/methods')
  assert.deepEqual(JSON.parse(calls[1][1].body), { challenge: 'challenge' })
  assert.equal(calls[2][0].endsWith('/api/desktop/auth/wecom/status/tx%2Fvalue'), true)
  assert.deepEqual(JSON.parse(calls[3][1].body), { transactionId: 'tx', verifier: 'verifier' })
  assert.deepEqual(JSON.parse(calls[4][1].body), { transactionId: 'tx' })
})

test('Gateway ProblemDetails preserves stable code detail and HTTP status', async () => {
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async () =>
      jsonResponse(
        {
          code: 'wecom-out-of-scope',
          detail: 'Sign-in is not available.',
          status: 403,
          title: 'Forbidden',
          type: 'https://errors.example.com/wecom-out-of-scope'
        },
        { ok: false, status: 403, statusText: 'Forbidden' }
      )
  })

  await assert.rejects(
    () => client.loginMethods(),
    error => {
      assert.equal(error instanceof EnterpriseGatewayError, true)
      assert.equal(error.code, 'wecom-out-of-scope')
      assert.equal(error.status, 403)
      assert.match(error.message, /Sign-in is not available/)
      return true
    }
  )
})

test('only bootstrap sends the Desktop bootstrap contract header', async () => {
  const calls = []
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async (url, options) => {
      calls.push({ options, url: String(url) })
      return jsonResponse({ bootstrapContractVersion: 2, methods: [] })
    }
  })

  await client.bootstrap('dsk_secret')
  await client.loginMethods()
  await client.modelProfiles('dsk_secret')

  assert.equal(calls[0].options.headers[DESKTOP_BOOTSTRAP_CONTRACT_HEADER], String(DESKTOP_BOOTSTRAP_CONTRACT_VERSION))
  assert.equal(Object.hasOwn(calls[1].options.headers, DESKTOP_BOOTSTRAP_CONTRACT_HEADER), false)
  assert.equal(Object.hasOwn(calls[2].options.headers, DESKTOP_BOOTSTRAP_CONTRACT_HEADER), false)
})

test('personal Bot client uses explicit owner verification issuance and runtime routes', async () => {
  const calls = []
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async (url, options) => {
      calls.push([url, options])
      return jsonResponse({ ok: true })
    }
  })

  await client.createWeComPersonalBotTransaction('desktop-token', {
    clientCapabilities: ['messaging-channel-policy.v1'],
    contractVersion: 'wecom-bot-transaction.v1'
  })
  await client.issueWeComPersonalBotOwnerVerification('desktop-token', 'binding/value')
  await client.weComPersonalBotRuntimeConfig('desktop-token', 'binding/value')
  await client.acquireWeComPersonalBotRuntimeLease('runtime-token')
  await client.leaseWeComPersonalBotInbox('runtime-token', { maxMessages: 1 })

  assert.equal(calls[0][0], 'https://gateway.example.com/v1/wecom-personal-bot/transactions')
  assert.equal(calls[0][1].method, 'POST')
  assert.equal(calls[1][0], 'https://gateway.example.com/v1/wecom-personal-bot/bindings/binding%2Fvalue/owner-verification')
  assert.equal(calls[1][1].method, 'POST')
  assert.equal(calls[1][1].body, undefined)
  assert.equal(
    calls[2][0],
    'https://gateway.example.com/v1/wecom-personal-bot/bindings/binding%2Fvalue/runtime-config'
  )
  assert.equal(calls[2][1].headers.Authorization, 'Bearer desktop-token')
  assert.equal(calls[2][1].cache, 'no-store')
  assert.equal(calls[3][0], 'https://gateway.example.com/v1/wecom-personal-bot/runtime/lease')
  assert.equal(calls[3][1].headers.Authorization, 'Bearer runtime-token')
  assert.deepEqual(JSON.parse(calls[4][1].body), { maxMessages: 1 })
})

test('personal Bot identity client owns binding and link identifiers in main process', async () => {
  const calls = []
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async (url, options) => {
      calls.push([url, options])
      return jsonResponse({ ok: true })
    }
  })

  await client.weComPersonalBotIdentityClaim('desktop-token', 'binding/value')
  await client.issueWeComPersonalBotIdentityClaim('desktop-token', 'binding/value')
  await client.weComPersonalBotChannelIdentities('desktop-token')
  await client.unlinkWeComPersonalBotChannelIdentity('desktop-token', 'link/value')

  assert.equal(calls[0][0].endsWith('/bindings/binding%2Fvalue/identity-claim'), true)
  assert.equal(calls[1][0].endsWith('/bindings/binding%2Fvalue/identity-claims'), true)
  assert.equal(calls[1][1].method, 'POST')
  assert.deepEqual(JSON.parse(calls[1][1].body), {})
  assert.equal(calls[2][0].endsWith('/channel-identities'), true)
  assert.equal(calls[3][0].endsWith('/channel-identities/link%2Fvalue'), true)
  assert.equal(calls[3][1].method, 'DELETE')
})

test('bootstrap and runtime manifest send the trusted main-process capability handshake', async () => {
  const calls = []
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async (url, options) => {
      calls.push({ options, url })
      if (String(url).endsWith('/api/desktop/auth/me')) {
        return jsonResponse({
          id: '00000000-0000-0000-0000-000000000001',
          userName: 'fixture-user',
          displayName: 'Fixture User'
        })
      }
      return jsonResponse({ ok: true })
    }
  })

  await client.bootstrap('dsk_fixture')
  await client.runtimeManifest('dsk_fixture', { preferredModel: null })
  await client.me('dsk_fixture')

  assert.equal(DESKTOP_CAPABILITIES_HEADER, 'X-Hermes-Desktop-Capabilities')
  assert.deepEqual(DESKTOP_CLIENT_CAPABILITIES, ['messaging-channel-policy.v1'])
  assert.equal(calls[0].options.headers[DESKTOP_CAPABILITIES_HEADER], 'messaging-channel-policy.v1')
  assert.equal(calls[1].options.headers[DESKTOP_CAPABILITIES_HEADER], 'messaging-channel-policy.v1')
  assert.equal(calls[2].options.headers[DESKTOP_CAPABILITIES_HEADER], undefined)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer dsk_fixture')
})

test('Gateway request timeout aborts and returns a stable non-enumerating code', async () => {
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    timeoutMs: 5
  })

  await assert.rejects(
    () => client.loginMethods(),
    error => {
      assert.equal(error.code, 'gateway-timeout')
      return true
    }
  )
})

test('authenticated Gateway JSON and raw requests forbid redirect token forwarding', async () => {
  const calls = []
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async (url, init) => {
      calls.push({ init, url: String(url) })
      if (String(url).includes('/download')) {
        return new Response(null, { headers: { location: 'https://evil.example/steal' }, status: 302 })
      }
      return jsonResponse(
        { code: 'redirect_refused' },
        { ok: false, status: 302, statusText: 'Found' }
      )
    }
  })

  await assert.rejects(client.bootstrap('dsk_secret'), error => error.status === 302)
  const raw = await client.downloadSkillPackage('dsk_secret', 'invoice-review', 1)
  assert.equal(raw.status, 302)
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.headers.Authorization, 'Bearer dsk_secret')
    assert.equal(call.url.startsWith('https://gateway.example.com/'), true)
  }
})

test('install operations use dsk for create/commit and restrict srt to read-only reconciliation', async () => {
  const calls = []
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async (url, options) => {
      calls.push({ options, url })
      return jsonResponse({ ok: true })
    }
  })
  const body = {
    clientOperationId: 'desktop-op',
    skillKey: 'expense-review',
    packageRevision: 1,
    artifactSha256: 'a'.repeat(64)
  }
  await client.createSkillInstallOperation('dsk_session', body)
  await client.commitSkillInstallOperation('dsk_session', '8bd3e8fb-8f0d-4f1c-8850-f79e48a8aac5')
  await client.getSkillInstallOperation('8bd3e8fb-8f0d-4f1c-8850-f79e48a8aac5', {
    reconciliationToken: 'srt_operation-secret'
  })

  assert.equal(calls[0].options.headers.Authorization, 'Bearer dsk_session')
  assert.deepEqual(JSON.parse(calls[0].options.body), body)
  assert.equal(calls[1].options.headers.Authorization, 'Bearer dsk_session')
  assert.equal(calls[1].url.endsWith('/commit'), true)
  assert.equal(calls[2].options.method, 'GET')
  assert.equal(calls[2].options.headers.Authorization, 'Bearer srt_operation-secret')
  assert.throws(
    () => client.commitSkillInstallOperation('srt_operation-secret', '8bd3e8fb-8f0d-4f1c-8850-f79e48a8aac5'),
    error => error.code === 'desktop_session_required'
  )
})

test('Gateway request timeout settles even when fetch ignores AbortSignal before headers', async () => {
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: () => new Promise(() => {}),
    timeoutMs: 5
  })

  await assert.rejects(client.loginMethods(), error => error.code === 'gateway-timeout')
})

test('caller cancellation wins permanently when fetch ignores AbortSignal before headers', async () => {
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: () => new Promise(() => {}),
    timeoutMs: 20
  })
  const controller = new AbortController()
  const request = client.requestJson('/api/test', { signal: controller.signal })
  controller.abort()

  await assert.rejects(request, error => error.code === 'request-canceled')
  await new Promise(resolve => setTimeout(resolve, 30))
})

test('pre-aborted JSON request never calls fetch', async () => {
  let calls = 0
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async () => { calls += 1 }
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(client.requestJson('/api/test', { signal: controller.signal }), error => error.code === 'request-canceled')
  assert.equal(calls, 0)
})

test('Gateway request timeout remains active while reading the response body', async () => {
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async (_url, options) => ({
      ok: true,
      text: async () =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true })
        })
    }),
    timeoutMs: 5
  })

  await assert.rejects(
    () => client.loginMethods(),
    error => {
      assert.equal(error.code, 'gateway-timeout')
      return true
    }
  )
})

test('raw package caller abort remains active after headers and cancels an unconsumed body', async () => {
  let canceled = false
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true
          },
          pull() {
            return new Promise(() => {})
          }
        })
      ),
    timeoutMs: 1_000
  })
  const controller = new AbortController()
  const response = await client.downloadSkillPackage('dsk_secret', 'invoice-review', 1, {
    signal: controller.signal
  })

  controller.abort()
  await assert.rejects(response.arrayBuffer(), error => error.code === 'request-canceled')
  assert.equal(canceled, true)
})

test('raw package caller abort settles before headers when fetch ignores AbortSignal', async () => {
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: () => new Promise(() => {}),
    timeoutMs: 1_000
  })
  const controller = new AbortController()
  const request = client.downloadSkillPackage('dsk_secret', 'invoice-review', 1, { signal: controller.signal })
  controller.abort()
  await assert.rejects(request, error => error.code === 'request-canceled')
})

test('pre-aborted raw package request never calls fetch', async () => {
  let calls = 0
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async () => { calls += 1 }
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    client.downloadSkillPackage('dsk_secret', 'invoice-review', 1, { signal: controller.signal }),
    error => error.code === 'request-canceled'
  )
  assert.equal(calls, 0)
})

test('raw package timeout settles before headers when fetch ignores AbortSignal', async () => {
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: () => new Promise(() => {}),
    timeoutMs: 5
  })
  await assert.rejects(
    client.downloadSkillPackage('dsk_secret', 'invoice-review', 1),
    error => error.code === 'gateway-timeout'
  )
})

test('raw package timeout covers a body that never starts or finishes and settles with one stable error', async () => {
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.com',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {})
          }
        })
      ),
    timeoutMs: 5
  })
  const response = await client.downloadSkillPackage('dsk_secret', 'invoice-review', 1)
  await new Promise(resolve => setTimeout(resolve, 15))
  await assert.rejects(response.arrayBuffer(), error => error.code === 'gateway-timeout')
})
