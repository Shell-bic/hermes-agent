const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const http = require('node:http')
const https = require('node:https')
const { createNodeJsonFetcher } = require('./enterprise-http-transport.cjs')

function fakeRequest() {
  const request = new EventEmitter()
  request.abortCalls = 0
  request.destroyCalls = 0
  request.abort = () => { request.abortCalls += 1 }
  request.destroy = () => { request.destroyCalls += 1 }
  request.end = () => {}
  request.setHeader = () => {}
  request.setTimeout = () => {}
  request.write = () => {}
  return request
}

test('Node enterprise JSON abort destroys request and attached response and settles once', async () => {
  const request = fakeRequest()
  let receiveResponse
  const response = new EventEmitter()
  response.destroyCalls = 0
  response.destroy = () => { response.destroyCalls += 1 }
  response.headers = {}
  response.statusCode = 200
  const fetchJson = createNodeJsonFetcher({
    defaultTimeoutMs: 1_000,
    http: { request: (_url, _options, callback) => { receiveResponse = callback; return request } },
    https: { request: () => request },
    resolveTimeoutMs: value => value || 1_000
  })
  const controller = new AbortController()
  const pending = fetchJson('http://127.0.0.1/api/test', 'token', { signal: controller.signal })
  receiveResponse(response)
  controller.abort()
  request.emit('error', new Error('late socket error'))

  await assert.rejects(pending, error => error.code === 'request-canceled')
  assert.equal(response.destroyCalls, 1)
  assert.equal(request.destroyCalls, 1)
})

test('pre-aborted Node enterprise JSON never creates an HTTP request', async () => {
  let calls = 0
  const fetchJson = createNodeJsonFetcher({
    defaultTimeoutMs: 1_000,
    http: { request: () => { calls += 1 } },
    https: { request: () => { calls += 1 } },
    resolveTimeoutMs: value => value || 1_000
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(fetchJson('http://127.0.0.1/api/test', 'token', { signal: controller.signal }), error => {
    return error.code === 'request-canceled'
  })
  assert.equal(calls, 0)
})

test('Node enterprise JSON abort settles against a real hanging HTTP server', async t => {
  const server = http.createServer(() => {})
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  const address = server.address()
  const fetchJson = createNodeJsonFetcher({
    defaultTimeoutMs: 5_000,
    http,
    https,
    resolveTimeoutMs: value => value || 5_000
  })
  const controller = new AbortController()
  const pending = fetchJson(`http://127.0.0.1:${address.port}/hang`, 'token', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, error => error.code === 'request-canceled')
})

test('Node incomplete response settles gateway-offline instead of hanging without end', async () => {
  const request = fakeRequest()
  let receiveResponse
  const response = new EventEmitter()
  response.destroy = () => {}
  response.headers = {}
  response.statusCode = 200
  const fetchJson = createNodeJsonFetcher({
    defaultTimeoutMs: 1_000,
    http: { request: (_url, _options, callback) => { receiveResponse = callback; return request } },
    https: { request: () => request },
    resolveTimeoutMs: value => value || 1_000
  })
  const pending = fetchJson('http://127.0.0.1/api/test', 'token')
  receiveResponse(response)
  response.emit('aborted')
  await assert.rejects(pending, error => error.code === 'gateway-offline')
})
