const test = require('node:test')
const assert = require('node:assert/strict')

const { createEnterpriseWeComRuntimeControlClient } = require('./enterprise-wecom-runtime-control.cjs')

const safeResponse = {
  bindingId: '01234567-89ab-4def-8abc-0123456789ab', connected: true,
  contractVersion: 'enterprise-wecom-runtime-control.v1', errorCode: null, errorMessage: null, state: 'connected'
}

test('runtime control token and Bot secret remain on the main-to-child request only', async () => {
  const calls = []
  const client = createEnterpriseWeComRuntimeControlClient({
    fetchImpl: async (url, options) => {
      calls.push([url, options])
      return { json: async () => ({ ...safeResponse, secret: 'must-not-return' }), ok: true }
    },
    getConnection: async () => ({ baseUrl: 'http://127.0.0.1:8123' }),
    getRuntimeToken: () => 'main-only-runtime-token'
  })
  const status = await client.attach({ secret: 'bot-secret' })
  assert.equal(calls[0][1].headers['X-Hermes-Enterprise-Runtime-Token'], 'main-only-runtime-token')
  assert.equal(JSON.parse(calls[0][1].body).secret, 'bot-secret')
  assert.equal(JSON.stringify(status).includes('must-not-return'), false)
  assert.equal(JSON.stringify(status).includes('main-only-runtime-token'), false)
})

test('runtime status and detach use the private control routes', async () => {
  const calls = []
  const client = createEnterpriseWeComRuntimeControlClient({
    fetchImpl: async (url, options) => { calls.push([url, options]); return { json: async () => safeResponse, ok: true } },
    getConnection: async () => ({ baseUrl: 'http://127.0.0.1:8123' }), getRuntimeToken: () => 'token'
  })
  await client.status()
  await client.detach(safeResponse.bindingId)
  assert.equal(calls[0][0].endsWith('/api/enterprise/wecom/status'), true)
  assert.equal(calls[0][1].method, 'GET')
  assert.equal(calls[1][0].endsWith('/api/enterprise/wecom/detach'), true)
  assert.equal(JSON.parse(calls[1][1].body).bindingId, safeResponse.bindingId)
})
