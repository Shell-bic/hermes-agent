const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DESKTOP_CAPABILITIES_HEADER,
  DESKTOP_CLIENT_CAPABILITIES,
  EnterpriseGatewayError,
  createEnterpriseGatewayClient,
  normalizeEnterpriseGatewayBaseUrl,
  normalizeLoginMethodsResponse
} = require('./enterprise-gateway-client.cjs')

function jsonResponse(payload, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => JSON.stringify(payload)
  }
}

test('enterprise Gateway URL requires HTTPS except for localhost rehearsal', () => {
  assert.equal(normalizeEnterpriseGatewayBaseUrl('https://gateway.example.com/path/'), 'https://gateway.example.com/path')
  assert.equal(normalizeEnterpriseGatewayBaseUrl('http://localhost:5100/'), 'http://localhost:5100')
  assert.equal(normalizeEnterpriseGatewayBaseUrl('http://127.0.0.1:5100/'), 'http://127.0.0.1:5100')
  assert.throws(() => normalizeEnterpriseGatewayBaseUrl('http://10.0.0.5:5100'), /must use https/)
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
