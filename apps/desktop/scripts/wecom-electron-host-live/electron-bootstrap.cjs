const { spawn } = require('node:child_process')
const path = require('node:path')
const {
  ELECTRON_VERSION,
  ProtocolError,
  validateChildRecord,
  validateShutdown,
  validateStart
} = require('./protocol.cjs')
const { childArguments, childEnvironment, electronExecutable, verifyPinnedElectron } = require('./launcher-core.cjs')

let electron = null
let started = false
let resultSent = false
let shutdownSent = false
let rootAcknowledged = false
let pendingStart = null
let rootAckTimer = null

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function isSnapshot(value) {
  return exactKeys(value, ['final', 'kind', 'pids', 'sampledAtFileTime', 'sequence']) &&
    value.kind === 'process_snapshot' && typeof value.final === 'boolean' &&
    Number.isSafeInteger(value.sequence) && value.sequence > 0 &&
    typeof value.sampledAtFileTime === 'string' && /^[1-9][0-9]{16,18}$/u.test(value.sampledAtFileTime) &&
    Array.isArray(value.pids) && value.pids.length >= 1 && value.pids.length <= 64 &&
    value.pids.every(pid => Number.isSafeInteger(pid) && pid > 0) && new Set(value.pids).size === value.pids.length
}

function failure(code) {
  return {
    protocolVersion: 1,
    result: 'FAIL',
    failureCode: code,
    electronVersion: ELECTRON_VERSION,
    popupCreated: false,
    officialOriginObserved: false,
    navigationPolicyPassed: false
  }
}

function sendResult(record) {
  if (resultSent) return
  resultSent = true
  if (process.connected) process.send(record, () => {})
}

function stop() {
  if (electron && electron.exitCode === null && electron.signalCode === null) {
    try { electron.kill() } catch {}
  }
}

function startElectron(message) {
  validateStart(message, { requireMissingProfile: false })
  verifyPinnedElectron(__dirname)
  electron = spawn(electronExecutable(__dirname), childArguments(__dirname), {
    cwd: path.resolve(__dirname, '..', '..'),
    env: childEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: false
  })
  let stdoutBytes = 0
  let stderrBytes = 0
  electron.stdout.on('data', chunk => { stdoutBytes += chunk.length; if (stdoutBytes > 16 * 1024) stop() })
  electron.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 16 * 1024) stop() })
  electron.on('message', record => {
    if (isSnapshot(record)) {
      if (process.connected) process.send(record, error => { if (error) stop() })
      return
    }
    if (exactKeys(record, ['kind']) && record.kind === 'final_snapshot_complete') {
      if (process.connected) process.send(record, error => { if (error) stop() })
      return
    }
    try { sendResult(validateChildRecord(record)) }
    catch { sendResult(failure('child_result_invalid')); stop() }
  })
  electron.on('error', () => { sendResult(failure('electron_child_failed')); stop() })
  electron.on('close', code => {
    if (!resultSent) sendResult(failure(code === 0 ? 'child_result_invalid' : 'electron_child_failed'))
    setImmediate(() => process.exit(resultSent && code === 0 ? 0 : 1))
  })
  if (process.connected) process.send({ kind: 'electron_producer', pid: electron.pid })
  pendingStart = message
  rootAckTimer = setTimeout(() => { sendResult(failure('tree_monitor_failed')); stop() }, 5_000)
}

process.on('message', message => {
  try {
    if (!started) {
      started = true
      startElectron(message)
      return
    }
    if (exactKeys(message, ['kind']) && message.kind === 'electron_root_ack') {
      if (rootAcknowledged || !electron || !pendingStart) throw new ProtocolError('tree_monitor_failed')
      rootAcknowledged = true
      clearTimeout(rootAckTimer)
      const start = pendingStart
      pendingStart = null
      electron.send(start, error => {
        if (error) { sendResult(failure('electron_child_failed')); stop() }
      })
      return
    }
    if (exactKeys(message, ['kind', 'sequence']) && message.kind === 'process_snapshot_ack') {
      if (!electron || electron.exitCode !== null || electron.signalCode !== null) throw new ProtocolError('tree_monitor_failed')
      electron.send(message, error => {
        if (error) { sendResult(failure('tree_monitor_failed')); stop() }
      })
      return
    }
    if (message?.command === 'start') throw new ProtocolError('duplicate_start')
    validateShutdown(message)
    if (shutdownSent) throw new ProtocolError('duplicate_shutdown')
    shutdownSent = true
    if (!electron || electron.exitCode !== null || electron.signalCode !== null) throw new ProtocolError('electron_child_failed')
    electron.send(message, error => {
      if (error) { sendResult(failure('electron_child_failed')); stop() }
    })
  } catch (error) {
    sendResult(failure(error instanceof ProtocolError ? error.code : 'internal_failure'))
    stop()
  }
})
process.on('disconnect', () => { stop(); process.exit(1) })
process.on('uncaughtException', () => { sendResult(failure('internal_failure')); stop() })
process.on('unhandledRejection', () => { sendResult(failure('internal_failure')); stop() })
