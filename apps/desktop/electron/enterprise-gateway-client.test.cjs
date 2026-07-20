const test = require('node:test')
const assert = require('node:assert/strict')

const {
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
  assert.equal(
    normalizeEnterpriseGatewayBaseUrl('https://gateway.example.com/path/'),
    'https://gateway.example.com/path'
  )
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
