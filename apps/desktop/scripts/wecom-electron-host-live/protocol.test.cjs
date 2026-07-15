const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  ProtocolError,
  ProtocolState,
  createResult,
  serializePublicResult,
  validateChildRecord,
  validateStart
} = require('./protocol.cjs')
const {
  childArguments,
  childEnvironment,
  producerMarker,
  sanitizedFailure
} = require('./launcher-core.cjs')

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const transactionId = '22222222-2222-4222-8222-222222222222'
const state = 'A'.repeat(43)

function startRequest(profileRoot = path.join(os.tmpdir(), `pb02-live-${Date.now()}-${Math.random()}`)) {
  return {
    protocolVersion: 1,
    command: 'start',
    runId,
    authorizationUrl: `https://gateway.example.test/wecom/bot-poc/${transactionId}?state=${state}`,
    gatewayOrigin: 'https://gateway.example.test',
    profileRoot
  }
}

function expectCode(fn, code) {
  assert.throws(fn, error => error instanceof ProtocolError && error.code === code)
}

test('accepts one strict start followed by one strict shutdown', () => {
  const protocol = new ProtocolState()
  assert.equal(protocol.accept(startRequest()).command, 'start')
  assert.deepEqual(protocol.accept({ protocolVersion: 1, command: 'shutdown' }), { protocolVersion: 1, command: 'shutdown' })
})

test('rejects duplicate start and duplicate shutdown', () => {
  const first = new ProtocolState()
  first.accept(startRequest())
  expectCode(() => first.accept(startRequest()), 'duplicate_start')

  const second = new ProtocolState()
  second.accept(startRequest())
  second.accept({ protocolVersion: 1, command: 'shutdown' })
  expectCode(() => second.accept({ protocolVersion: 1, command: 'shutdown' }), 'duplicate_shutdown')
})

test('rejects shutdown before start and unknown fields', () => {
  expectCode(() => new ProtocolState().accept({ protocolVersion: 1, command: 'shutdown' }), 'shutdown_before_start')
  expectCode(() => validateStart({ ...startRequest(), extra: true }), 'live_input_invalid')
})

test('requires canonical run id, absolute missing profile root and exact 43-character state', () => {
  expectCode(() => validateStart({ ...startRequest(), runId: runId.toUpperCase() }), 'live_input_invalid')
  expectCode(() => validateStart(startRequest('relative-profile')), 'live_input_invalid')
  expectCode(() => validateStart({ ...startRequest(), authorizationUrl: `https://gateway.example.test/wecom/bot-poc/${transactionId}?state=${'A'.repeat(42)}` }), 'authorization_url_invalid')

  const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'pb02-live-existing-'))
  try {
    expectCode(() => validateStart(startRequest(existing)), 'profile_root_exists')
  } finally {
    fs.rmSync(existing, { recursive: true, force: true })
  }
})

test('rejects non-HTTPS, non-exact origins and authorization paths', () => {
  expectCode(() => validateStart({ ...startRequest(), gatewayOrigin: 'http://gateway.example.test' }), 'gateway_origin_invalid')
  expectCode(() => validateStart({ ...startRequest(), gatewayOrigin: 'https://gateway.example.test/' }), 'gateway_origin_invalid')
  expectCode(() => validateStart({ ...startRequest(), authorizationUrl: `https://other.example.test/wecom/bot-poc/${transactionId}?state=${state}` }), 'authorization_url_invalid')
  expectCode(() => validateStart({ ...startRequest(), authorizationUrl: `https://gateway.example.test/wrong/${transactionId}?state=${state}` }), 'authorization_url_invalid')
  expectCode(() => validateStart({ ...startRequest(), authorizationUrl: `https://gateway.example.test/wecom/bot-poc/${transactionId}?state=${state}&extra=1` }), 'authorization_url_invalid')
})

test('public PASS output has only the fixed nine fields', () => {
  const line = serializePublicResult(createResult({
    result: 'PASS',
    failureCode: 'none',
    electronVersion: '40.10.2',
    popupCreated: true,
    officialOriginObserved: true,
    navigationPolicyPassed: true,
    cleanupStatus: 'retained',
    producerMarkerStatus: 'operator_asserted'
  }))
  const value = JSON.parse(line.slice('PB02_ELECTRON_LIVE_RESULT='.length))
  assert.deepEqual(Object.keys(value).sort(), [
    'cleanupStatus', 'electronVersion', 'failureCode', 'navigationPolicyPassed',
    'officialOriginObserved', 'popupCreated', 'producerMarkerStatus', 'protocolVersion', 'result'
  ])
})

test('child failureCode is restricted to the fixed allowlist', () => {
  const hostile = {
    protocolVersion: 1,
    result: 'FAIL',
    failureCode: 'raw_error_https://secret.example/?state=leak',
    electronVersion: '40.10.2',
    popupCreated: false,
    officialOriginObserved: false,
    navigationPolicyPassed: false
  }
  expectCode(() => validateChildRecord(hostile), 'child_result_invalid')
  assert.equal(sanitizedFailure('raw_error_https://secret.example').failureCode, 'internal_failure')
})

test('IPC disconnect and shutdown timeout remain sanitized stable failures', () => {
  for (const code of ['launcher_protocol_eof', 'protocol_eof', 'ipc_start_timeout', 'shutdown_timeout']) {
    const record = sanitizedFailure(code, { electronVersion: '40.10.2', cleanupStatus: 'retained' })
    assert.equal(record.result, 'FAIL')
    assert.equal(record.failureCode, code)
    assert.equal(JSON.stringify(record).includes('Error'), false)
    assert.equal(JSON.stringify(record).includes('https://'), false)
  }
})

test('sensitive start data never enters Electron argv, environment, result or producer marker', () => {
  const secretUrl = startRequest().authorizationUrl
  const sensitive = `${secretUrl}|state=${state}|bot-secret-value`
  const argv = JSON.stringify(childArguments(__dirname))
  const environment = JSON.stringify(childEnvironment({
    PATH: process.env.PATH,
    AUTHORIZATION_URL: secretUrl,
    WECOM_SECRET: sensitive,
    HERMES_HOME: sensitive
  }))
  const result = serializePublicResult(sanitizedFailure('electron_child_failed'))
  const marker = JSON.stringify(producerMarker(runId, 12345))
  assert.match(JSON.parse(marker).finishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}\+00:00$/u)
  for (const value of [argv, environment, result, marker]) {
    assert.equal(value.includes(secretUrl), false)
    assert.equal(value.includes(state), false)
    assert.equal(value.includes('bot-secret-value'), false)
  }
})

test('launcher pins bootstrap and Electron root before sending the sensitive start IPC', () => {
  const source = fs.readFileSync(path.join(__dirname, 'run.cjs'), 'utf8')
  const attach = source.indexOf('await treeMonitor.attach(child.pid)')
  const send = source.indexOf('child.send({', attach)
  assert.ok(attach >= 0)
  assert.ok(send > attach)

  const bootstrap = fs.readFileSync(path.join(__dirname, 'electron-bootstrap.cjs'), 'utf8')
  const rootAck = bootstrap.indexOf("message.kind === 'electron_root_ack'")
  const electronStart = bootstrap.indexOf('electron.send(start', rootAck)
  assert.ok(rootAck >= 0)
  assert.ok(electronStart > rootAck)
})

test('trusted Electron samples FILETIME before every AppMetrics enumeration', () => {
  for (const name of ['electron-live-main.cjs', 'electron-success-fixture-main.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8')
    const metrics = source.indexOf('app.getAppMetrics()')
    const sampled = source.lastIndexOf('fileTimeNow()', metrics)
    assert.ok(metrics >= 0, `${name} must enumerate AppMetrics`)
    assert.ok(sampled >= 0 && sampled < metrics, `${name} must capture sampledAtFileTime before AppMetrics`)
  }
})

test('invalid launcher input returns one sanitized public failure line and no stderr', () => {
  const execution = spawnSync(process.execPath, [path.join(__dirname, 'run.cjs')], {
    encoding: 'utf8',
    input: '{"protocolVersion":1,"command":"start","authorizationUrl":"https://secret.invalid/?state=leak"}\n'
  })
  const lines = execution.stdout.trim().split(/\r?\n/u)
  assert.equal(execution.status, 1)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^PB02_ELECTRON_LIVE_RESULT=/u)
  assert.equal(execution.stdout.includes('secret.invalid'), false)
  assert.equal(execution.stdout.includes('state=leak'), false)
  assert.equal(execution.stderr, '')
})
