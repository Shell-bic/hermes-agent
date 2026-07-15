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
