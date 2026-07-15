const fs = require('node:fs')
const path = require('node:path')

const PROTOCOL_VERSION = 1
const ELECTRON_VERSION = '40.10.2'
const OFFICIAL_AUTH_ORIGIN = 'https://work.weixin.qq.com'
const OFFICIAL_AUTH_PATH = '/ai/qc/gen'
const MAX_PROTOCOL_LINE_BYTES = 16 * 1024
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const TRANSACTION_PATH_PATTERN = /^\/wecom\/bot-poc\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u

const START_KEYS = Object.freeze([
  'authorizationUrl',
  'command',
  'gatewayOrigin',
  'profileRoot',
  'protocolVersion',
  'runId'
])
const SHUTDOWN_KEYS = Object.freeze(['command', 'protocolVersion'])
const RESULT_KEYS = Object.freeze([
  'cleanupStatus',
  'electronVersion',
  'failureCode',
  'navigationPolicyPassed',
  'officialOriginObserved',
  'popupCreated',
  'producerMarkerStatus',
  'protocolVersion',
  'result'
])
const FAILURE_CODES = new Set([
  'authorization_url_invalid',
  'child_result_invalid',
  'child_output_unexpected',
  'duplicate_shutdown',
  'duplicate_start',
  'electron_child_failed',
  'electron_unavailable',
  'gateway_load_failed',
  'gateway_origin_invalid',
  'internal_failure',
  'ipc_start_timeout',
  'launcher_protocol_eof',
  'live_input_invalid',
  'navigation_blocked',
  'none',
  'operator_canceled',
  'popup_blocked',
  'popup_load_failed',
  'popup_not_observed',
  'producer_marker_failed',
  'profile_create_failed',
  'profile_root_exists',
  'protocol_eof',
  'renderer_crashed',
  'renderer_unresponsive',
  'result_invalid',
  'shutdown_before_start',
  'shutdown_invalid',
  'shutdown_timeout',
  'tree_monitor_failed',
  'tree_not_quiescent'
])

class ProtocolError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function parseJsonLine(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES || line.includes('\0')) {
    throw new ProtocolError('live_input_invalid')
  }
  try {
    const parsed = JSON.parse(line)
    if (!isPlainObject(parsed)) throw new ProtocolError('live_input_invalid')
    return parsed
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    throw new ProtocolError('live_input_invalid')
  }
}

function exactSingleSearchKey(url, key) {
  const keys = Array.from(url.searchParams.keys())
  return keys.length === 1 && keys[0] === key && url.searchParams.getAll(key).length === 1
}

function validateStart(value, options = {}) {
  if (!hasExactKeys(value, START_KEYS) || value.protocolVersion !== PROTOCOL_VERSION || value.command !== 'start') {
    throw new ProtocolError('live_input_invalid')
  }
  if (typeof value.runId !== 'string' || !GUID_PATTERN.test(value.runId)) throw new ProtocolError('live_input_invalid')
  if (typeof value.profileRoot !== 'string' || !path.isAbsolute(value.profileRoot) || path.normalize(value.profileRoot) !== value.profileRoot) {
    throw new ProtocolError('live_input_invalid')
  }
  if (options.requireMissingProfile !== false && fs.existsSync(value.profileRoot)) throw new ProtocolError('profile_root_exists')

  let gateway
  let authorization
  try {
    gateway = new URL(value.gatewayOrigin)
    authorization = new URL(value.authorizationUrl)
  } catch {
    throw new ProtocolError('live_input_invalid')
  }
  if (typeof value.gatewayOrigin !== 'string' || gateway.protocol !== 'https:' || gateway.username || gateway.password ||
      gateway.pathname !== '/' || gateway.search || gateway.hash || value.gatewayOrigin !== gateway.origin) {
    throw new ProtocolError('gateway_origin_invalid')
  }
  if (typeof value.authorizationUrl !== 'string' || authorization.protocol !== 'https:' || authorization.username ||
      authorization.password || authorization.hash || authorization.origin !== gateway.origin ||
      !TRANSACTION_PATH_PATTERN.test(authorization.pathname) || !exactSingleSearchKey(authorization, 'state') ||
      !STATE_PATTERN.test(authorization.searchParams.get('state') || '')) {
    throw new ProtocolError('authorization_url_invalid')
  }

  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    command: 'start',
    runId: value.runId,
    authorizationUrl: authorization.href,
    gatewayOrigin: gateway.origin,
    profileRoot: value.profileRoot,
    authorizationPath: authorization.pathname,
    state: authorization.searchParams.get('state')
  })
}

function validateShutdown(value) {
  if (!hasExactKeys(value, SHUTDOWN_KEYS) || value.protocolVersion !== PROTOCOL_VERSION || value.command !== 'shutdown') {
    throw new ProtocolError('shutdown_invalid')
  }
  return Object.freeze({ protocolVersion: PROTOCOL_VERSION, command: 'shutdown' })
}

class ProtocolState {
  constructor() {
    this.phase = 'awaiting_start'
  }

  accept(value, options = {}) {
    if (this.phase === 'awaiting_start') {
      if (value?.command !== 'start') throw new ProtocolError('shutdown_before_start')
      const start = validateStart(value, options)
      this.phase = 'running'
      return start
    }
    if (this.phase === 'running') {
      if (value?.command === 'start') throw new ProtocolError('duplicate_start')
      const shutdown = validateShutdown(value)
      this.phase = 'shutdown_received'
      return shutdown
    }
    throw new ProtocolError(value?.command === 'shutdown' ? 'duplicate_shutdown' : 'duplicate_start')
  }
}

function createResult(fields = {}) {
  const record = {
    protocolVersion: PROTOCOL_VERSION,
    result: fields.result === 'PASS' ? 'PASS' : 'FAIL',
    failureCode: FAILURE_CODES.has(fields.failureCode) ? fields.failureCode : 'internal_failure',
    electronVersion: fields.electronVersion === ELECTRON_VERSION ? ELECTRON_VERSION : 'unavailable',
    popupCreated: fields.popupCreated === true,
    officialOriginObserved: fields.officialOriginObserved === true,
    navigationPolicyPassed: fields.navigationPolicyPassed === true,
    cleanupStatus: ['not_created', 'retained', 'failed'].includes(fields.cleanupStatus) ? fields.cleanupStatus : 'not_created',
    producerMarkerStatus: fields.producerMarkerStatus === 'operator_asserted' ? 'operator_asserted' : 'not_written'
  }
  if (record.result === 'PASS') {
    const valid = record.failureCode === 'none' && record.electronVersion === ELECTRON_VERSION && record.popupCreated &&
      record.officialOriginObserved && record.navigationPolicyPassed && record.cleanupStatus === 'retained' &&
      record.producerMarkerStatus === 'operator_asserted'
    if (!valid) throw new ProtocolError('result_invalid')
  }
  return record
}

function validateChildRecord(value) {
  const expectedKeys = [
    'electronVersion',
    'failureCode',
    'navigationPolicyPassed',
    'officialOriginObserved',
    'popupCreated',
    'protocolVersion',
    'result'
  ]
  if (!hasExactKeys(value, expectedKeys) || value.protocolVersion !== PROTOCOL_VERSION ||
      !['PASS', 'FAIL'].includes(value.result) || !FAILURE_CODES.has(value.failureCode) ||
      value.electronVersion !== ELECTRON_VERSION || typeof value.popupCreated !== 'boolean' ||
      typeof value.officialOriginObserved !== 'boolean' || typeof value.navigationPolicyPassed !== 'boolean') {
    throw new ProtocolError('child_result_invalid')
  }
  return value
}

function serializePublicResult(record) {
  const normalized = createResult(record)
  if (!hasExactKeys(normalized, RESULT_KEYS)) throw new ProtocolError('result_invalid')
  return `PB02_ELECTRON_LIVE_RESULT=${JSON.stringify(normalized)}`
}

module.exports = {
  ELECTRON_VERSION,
  FAILURE_CODES,
  GUID_PATTERN,
  MAX_PROTOCOL_LINE_BYTES,
  OFFICIAL_AUTH_ORIGIN,
  OFFICIAL_AUTH_PATH,
  PROTOCOL_VERSION,
  ProtocolError,
  ProtocolState,
  createResult,
  exactSingleSearchKey,
  hasExactKeys,
  parseJsonLine,
  serializePublicResult,
  validateShutdown,
  validateChildRecord,
  validateStart
}
