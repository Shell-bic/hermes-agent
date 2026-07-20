const assert = require('node:assert/strict')
const test = require('node:test')

const {
  fixedManagedFailure,
  normalizeManagedBackendExit,
  normalizeManagedBootProgress
} = require('./enterprise-managed-backend-failure.cjs')

const SENTINELS = [
  'dsk_MACHINE_CONFIG_ONLY_SENTINEL',
  'https://private.invalid/tenant?token=secret',
  'C:\\Users\\private-user\\enterprise-runtime',
  'Error: raw failure\n    at C:\\private\\backend.cjs:7:1'
]

const lifecycle = { lifecycleEpoch: 17, state: 'running' }

test('machine-config managed child errors produce only fixed safe log, boot, exit, and thrown error data', () => {
  const raw = new Error(SENTINELS.join(' | '))
  raw.stack = SENTINELS.join('\n')
  const failure = fixedManagedFailure('start', lifecycle, raw)
  const outputs = JSON.stringify({
    boot: failure.bootUpdate,
    error: { message: failure.error.message, stack: failure.error.stack },
    exit: failure.exitPayload,
    log: failure.logMessage
  })

  for (const sentinel of SENTINELS) assert.equal(outputs.includes(sentinel), false)
  assert.equal(failure.enterpriseError.errorCode, 'enterprise_backend_start_failed')
  assert.equal(failure.enterpriseError.lifecycleEpoch, 17)
  assert.equal(failure.enterpriseError.message, 'Hermes backend could not start. Try again.')
  assert.equal(failure.error.stack, 'Error: Hermes backend could not start. Try again.')
  assert.doesNotMatch(failure.error.stack, /(?:[A-Za-z]:\\|https?:\/\/|\n\s+at\s)/)
})

test('managed output boundaries replace raw error, URL, path, signal, and exit fields with a fixed envelope', () => {
  const hostile = SENTINELS.join(' | ')
  const boot = normalizeManagedBootProgress(
    { error: hostile, message: hostile, phase: 'backend.error', running: false },
    { enabled: true, lifecycle }
  )
  const exit = normalizeManagedBackendExit(
    { code: hostile, error: hostile, signal: hostile },
    { enabled: true, lifecycle }
  )
  const outputs = JSON.stringify({ boot, exit })

  for (const sentinel of SENTINELS) assert.equal(outputs.includes(sentinel), false)
  assert.equal(exit.code, null)
  assert.equal(exit.signal, null)
  assert.equal(boot.enterpriseError.lifecycleEpoch, 17)
})

test('unmanaged output boundaries preserve legacy payloads', () => {
  const boot = { error: SENTINELS[0], message: SENTINELS[1], phase: 'backend.error' }
  const exit = { code: 9, signal: 'SIGTERM', error: SENTINELS[2] }

  assert.equal(normalizeManagedBootProgress(boot, { enabled: false }), boot)
  assert.equal(normalizeManagedBackendExit(exit, { enabled: false }), exit)
})
