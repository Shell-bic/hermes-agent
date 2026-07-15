const fs = require('node:fs')
const path = require('node:path')
const { createElectronHost } = require('./electron-host.cjs')
const {
  ELECTRON_VERSION,
  OFFICIAL_AUTH_ORIGIN,
  OFFICIAL_AUTH_PATH,
  ProtocolError,
  validateShutdown,
  validateStart
} = require('./protocol.cjs')

let app = null
let host = null
let startReceived = false
let shutdownReceived = false
let exited = false
let finalizing = false
let snapshotSequence = 0
let snapshotTimer = null
let snapshotInFlight = Promise.resolve()
const pendingSnapshotAcks = new Map()
const startTimeout = setTimeout(() => directFailure('ipc_start_timeout'), 10_000)

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function fileTimeNow() {
  const unixMilliseconds = performance.timeOrigin + performance.now()
  const wholeMilliseconds = Math.floor(unixMilliseconds)
  const fractionalTicks = Math.floor((unixMilliseconds - wholeMilliseconds) * 10_000)
  return (BigInt(wholeMilliseconds) * 10_000n + BigInt(fractionalTicks) + 116_444_736_000_000_000n).toString()
}

function processSnapshot() {
  const sampledAtFileTime = fileTimeNow()
  const pids = [...new Set([process.pid, ...app.getAppMetrics().map(metric => metric.pid)])]
    .filter(pid => Number.isSafeInteger(pid) && pid > 0)
    .sort((left, right) => left - right)
  if (pids.length < 1 || pids.length > 64) throw new ProtocolError('tree_monitor_failed')
  return { pids, sampledAtFileTime }
}

function sendSnapshot(final) {
  const sequence = ++snapshotSequence
  const snapshot = processSnapshot()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSnapshotAcks.delete(sequence)
      reject(new ProtocolError('tree_monitor_failed'))
    }, 5_000)
    pendingSnapshotAcks.set(sequence, {
      resolve: () => { clearTimeout(timer); resolve(snapshot.pids) },
      reject: error => { clearTimeout(timer); reject(error) }
    })
    process.send({
      kind: 'process_snapshot',
      sequence,
      final,
      sampledAtFileTime: snapshot.sampledAtFileTime,
      pids: snapshot.pids
    }, error => {
      if (!error) return
      const pending = pendingSnapshotAcks.get(sequence)
      pendingSnapshotAcks.delete(sequence)
      pending?.reject(new ProtocolError('tree_monitor_failed'))
    })
  })
}

function scheduleSnapshotPump() {
  if (finalizing || exited) return
  snapshotTimer = setTimeout(() => {
    snapshotInFlight = sendSnapshot(false)
    snapshotInFlight.then(scheduleSnapshotPump, () => directFailure('tree_monitor_failed'))
  }, 25)
  snapshotTimer.unref()
}

function directFailure(failureCode) {
  if (exited) return
  exited = true
  finalizing = true
  if (snapshotTimer) clearTimeout(snapshotTimer)
  const record = {
    protocolVersion: 1,
    result: 'FAIL',
    failureCode,
    electronVersion: ELECTRON_VERSION,
    popupCreated: false,
    officialOriginObserved: false,
    navigationPolicyPassed: false
  }
  const exit = () => app ? app.exit(1) : process.exit(1)
  if (process.connected) process.send(record, exit)
  else exit()
}

async function finish(record) {
  if (exited || finalizing) return
  finalizing = true
  if (snapshotTimer) clearTimeout(snapshotTimer)
  try {
    await snapshotInFlight
    let previous = null
    let stable = 0
    for (let attempt = 0; attempt < 40 && stable < 3; attempt += 1) {
      const pids = await sendSnapshot(true)
      const key = pids.join(',')
      stable = key === previous ? stable + 1 : 1
      previous = key
      if (stable < 3) await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (stable < 3) throw new ProtocolError('tree_monitor_failed')
    await new Promise((resolve, reject) => {
      process.send({ kind: 'final_snapshot_complete' }, error => error ? reject(error) : resolve())
    })
    exited = true
    const code = record.result === 'PASS' ? 0 : 1
    process.send(record, () => app.exit(code))
  } catch {
    directFailure('tree_monitor_failed')
  }
}

function initialize(message) {
  clearTimeout(startTimeout)
  try {
    const start = validateStart(message, { requireMissingProfile: false })
    const root = fs.lstatSync(start.profileRoot)
    if (!root.isDirectory() || root.isSymbolicLink()) throw new ProtocolError('live_input_invalid')
    for (const name of ['profile', 'session-data', 'logs', 'crash-dumps', 'cache']) {
      const info = fs.lstatSync(path.join(start.profileRoot, name))
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtocolError('live_input_invalid')
    }
    const electron = require('electron')
    app = electron.app
    if (process.versions.electron !== ELECTRON_VERSION || app.isReady()) throw new ProtocolError('electron_unavailable')
    app.setPath('userData', path.join(start.profileRoot, 'profile'))
    app.setPath('sessionData', path.join(start.profileRoot, 'session-data'))
    app.setPath('logs', path.join(start.profileRoot, 'logs'))
    app.setPath('crashDumps', path.join(start.profileRoot, 'crash-dumps'))
    app.setPath('cache', path.join(start.profileRoot, 'cache'))
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-breakpad')
    app.on('window-all-closed', () => {})
    host = createElectronHost({
      app,
      BrowserWindow: electron.BrowserWindow,
      session: electron.session,
      webContents: electron.webContents,
      start,
      authOrigin: OFFICIAL_AUTH_ORIGIN,
      authPath: OFFICIAL_AUTH_PATH,
      onFinish: record => { void finish(record) }
    })
    void app.whenReady().then(scheduleSnapshotPump, () => directFailure('tree_monitor_failed'))
    void host.start()
  } catch (error) {
    directFailure(error instanceof ProtocolError ? error.code : 'live_input_invalid')
  }
}

process.on('message', message => {
  if (exited) return
  if (message?.kind === 'process_snapshot_ack') {
    if (!exactKeys(message, ['kind', 'sequence']) || !Number.isSafeInteger(message.sequence) || message.sequence <= 0) {
      directFailure('tree_monitor_failed')
      return
    }
    const pending = pendingSnapshotAcks.get(message.sequence)
    if (!pending) {
      directFailure('tree_monitor_failed')
      return
    }
    pendingSnapshotAcks.delete(message.sequence)
    pending.resolve()
    return
  }
  if (finalizing) return
  if (!startReceived) {
    startReceived = true
    initialize(message)
    return
  }
  try {
    if (message?.command === 'start') throw new ProtocolError('duplicate_start')
    validateShutdown(message)
    if (shutdownReceived) throw new ProtocolError('duplicate_shutdown')
    shutdownReceived = true
    host?.shutdown()
  } catch (error) {
    host ? host.fail(error instanceof ProtocolError ? error.code : 'shutdown_invalid') : directFailure('shutdown_invalid')
  }
})
process.on('disconnect', () => host ? host.fail('protocol_eof') : directFailure('protocol_eof'))
process.on('uncaughtException', () => host ? host.fail('internal_failure') : directFailure('internal_failure'))
process.on('unhandledRejection', () => host ? host.fail('internal_failure') : directFailure('internal_failure'))
