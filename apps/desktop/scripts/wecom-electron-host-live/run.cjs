const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')
const {
  ELECTRON_VERSION,
  MAX_PROTOCOL_LINE_BYTES,
  ProtocolError,
  ProtocolState,
  parseJsonLine,
  serializePublicResult,
  validateChildRecord
} = require('./protocol.cjs')
const {
  bootstrapArguments,
  childEnvironment,
  createIsolatedProfile,
  finalRecordFromChild,
  sanitizedFailure,
  verifyPinnedElectron,
  writeProducerMarker
} = require('./launcher-core.cjs')
const { attachProcessTree, childProcessOptions, prepareProcessTree } = require('./process-tree.cjs')

const CHILD_OUTPUT_LIMIT = 16 * 1024
const SHUTDOWN_TIMEOUT_MS = 15_000
const protocol = new ProtocolState()
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
let child = null
let start = null
let childStdout = ''
let childStderrBytes = 0
let childResult = null
let outputWritten = false
let profileCreated = false
let shutdownTimer = null
let observedElectronVersion = 'unavailable'
let pendingFailureCode = null
let treeMonitor = null
let treeQuiescencePromise = null
let childReady = false
let pendingShutdownMessage = null
let electronProducerPid = null
let childMessageChain = Promise.resolve()
let lastSnapshotSequence = 0
let finalSnapshotKey = null
let finalSnapshotStableCount = 0
let finalSnapshotComplete = false

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function isProcessSnapshot(value) {
  return exactKeys(value, ['final', 'kind', 'pids', 'sampledAtFileTime', 'sequence']) &&
    value.kind === 'process_snapshot' && typeof value.final === 'boolean' &&
    Number.isSafeInteger(value.sequence) && value.sequence > 0 &&
    typeof value.sampledAtFileTime === 'string' && /^[1-9][0-9]{16,18}$/u.test(value.sampledAtFileTime) &&
    Array.isArray(value.pids) && value.pids.length >= 1 && value.pids.length <= 64 &&
    value.pids.every(pid => Number.isSafeInteger(pid) && pid > 0) && new Set(value.pids).size === value.pids.length
}

function writeFinal(record) {
  if (outputWritten) return
  outputWritten = true
  input.close()
  if (shutdownTimer) clearTimeout(shutdownTimer)
  process.stdout.write(`${serializePublicResult(record)}\n`)
  process.exitCode = record.result === 'PASS' ? 0 : 1
}

function terminateChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  ensureTreeQuiescent().then(quiescent => {
    if (!quiescent && child && child.exitCode === null && child.signalCode === null) {
      try { child.kill() } catch {}
    }
  })
}

function ensureTreeQuiescent() {
  if (treeQuiescencePromise) return treeQuiescencePromise
  treeQuiescencePromise = (async () => {
    if (!treeMonitor) return false
    try {
      const result = await treeMonitor.quiesce()
      const minimumProcessCount = electronProducerPid ? 2 : 1
      return result?.quiescent === true && Number.isSafeInteger(result.capturedProcessCount) &&
        result.capturedProcessCount >= minimumProcessCount
    } catch {
      return false
    }
  })()
  return treeQuiescencePromise
}

function fail(code, state = {}) {
  if (outputWritten) return
  if (child && child.exitCode === null && child.signalCode === null) {
    pendingFailureCode = code
    terminateChild()
    return
  }
  writeFinal(sanitizedFailure(code, {
    electronVersion: observedElectronVersion,
    cleanupStatus: profileCreated ? 'retained' : 'not_created',
    producerMarkerStatus: 'not_written',
    ...state
  }))
}

async function finishAfterChildExit(pid, exitCode, signal) {
  if (outputWritten) return
  await childMessageChain
  let record = childResult
  if (childStdout.trim() && !pendingFailureCode) pendingFailureCode = 'child_output_unexpected'

  const treeQuiescent = await ensureTreeQuiescent()
  if (!treeQuiescent) {
    writeFinal(sanitizedFailure(pendingFailureCode === 'tree_monitor_failed' ? 'tree_monitor_failed' : 'tree_not_quiescent', {
      electronVersion: observedElectronVersion,
      popupCreated: record?.popupCreated,
      officialOriginObserved: record?.officialOriginObserved,
      navigationPolicyPassed: record?.navigationPolicyPassed,
      cleanupStatus: 'failed',
      producerMarkerStatus: 'not_written'
    }))
    return
  }

  if (!finalSnapshotComplete) {
    writeFinal(sanitizedFailure(pendingFailureCode || record?.failureCode || 'tree_monitor_failed', {
      electronVersion: observedElectronVersion,
      popupCreated: record?.popupCreated,
      officialOriginObserved: record?.officialOriginObserved,
      navigationPolicyPassed: record?.navigationPolicyPassed,
      cleanupStatus: 'failed',
      producerMarkerStatus: 'not_written'
    }))
    return
  }

  let markerWritten = false
  if (profileCreated && start && Number.isSafeInteger(electronProducerPid) && electronProducerPid > 0) {
    try {
      writeProducerMarker(start.profileRoot, start.runId, electronProducerPid)
      markerWritten = true
    } catch {
      writeFinal(sanitizedFailure('producer_marker_failed', {
        electronVersion: observedElectronVersion,
        popupCreated: record?.popupCreated,
        officialOriginObserved: record?.officialOriginObserved,
        navigationPolicyPassed: record?.navigationPolicyPassed,
        cleanupStatus: 'failed',
        producerMarkerStatus: 'not_written'
      }))
      return
    }
  }

  if (!record && pendingFailureCode) {
    record = {
      electronVersion: observedElectronVersion,
      popupCreated: false,
      officialOriginObserved: false,
      navigationPolicyPassed: false,
      result: 'FAIL',
      failureCode: pendingFailureCode
    }
  }
  if (!record) {
    writeFinal(sanitizedFailure(exitCode === null && signal ? 'electron_child_failed' : 'child_result_invalid', {
      electronVersion: observedElectronVersion,
      cleanupStatus: profileCreated ? 'retained' : 'not_created',
      producerMarkerStatus: markerWritten ? 'operator_asserted' : 'not_written'
    }))
    return
  }
  if (pendingFailureCode) {
    record = {
      ...(record || {
        electronVersion: observedElectronVersion,
        popupCreated: false,
        officialOriginObserved: false,
        navigationPolicyPassed: false
      }),
      result: 'FAIL',
      failureCode: pendingFailureCode
    }
  } else if ((exitCode !== 0 || signal) && record.result !== 'FAIL') {
    record = { ...record, result: 'FAIL', failureCode: 'electron_child_failed' }
  }
  try {
    writeFinal(finalRecordFromChild(record, markerWritten))
  } catch {
    writeFinal(sanitizedFailure('child_result_invalid', {
      electronVersion: observedElectronVersion,
      popupCreated: record.popupCreated,
      officialOriginObserved: record.officialOriginObserved,
      navigationPolicyPassed: record.navigationPolicyPassed,
      cleanupStatus: profileCreated ? 'retained' : 'not_created',
      producerMarkerStatus: markerWritten ? 'operator_asserted' : 'not_written'
    }))
  }
}

async function launch(request) {
  try {
    verifyPinnedElectron(__dirname)
    observedElectronVersion = ELECTRON_VERSION
    createIsolatedProfile(request.profileRoot)
    profileCreated = true
  } catch (error) {
    fail(error instanceof ProtocolError ? error.code : (profileCreated ? 'profile_create_failed' : 'electron_unavailable'))
    return
  }

  try {
    treeMonitor = prepareProcessTree(childEnvironment(), __dirname)
    if (treeMonitor) await treeMonitor.bootstrapReady
  } catch {
    treeMonitor?.dispose?.()
    fail('tree_monitor_failed', { cleanupStatus: 'failed' })
    return
  }

  try {
    child = spawn(process.execPath, bootstrapArguments(__dirname), {
      cwd: path.resolve(__dirname, '..', '..'),
      env: childEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: false,
      ...childProcessOptions()
    })
  } catch {
    fail('electron_child_failed')
    return
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    childStdout += chunk
    if (Buffer.byteLength(childStdout, 'utf8') > CHILD_OUTPUT_LIMIT) {
      childStdout = ''
      pendingFailureCode = 'child_result_invalid'
      terminateChild()
    }
  })
  child.stderr.on('data', chunk => {
    childStderrBytes += chunk.length
    if (childStderrBytes > CHILD_OUTPUT_LIMIT) {
      pendingFailureCode = 'electron_child_failed'
      terminateChild()
    }
  })
  async function handleChildMessage(message) {
    try {
      if (exactKeys(message, ['kind', 'pid']) && message.kind === 'electron_producer' &&
          Number.isSafeInteger(message.pid) && message.pid > 0 && electronProducerPid === null) {
        electronProducerPid = message.pid
        await treeMonitor.pinElectronRoot(message.pid)
        child.send({ kind: 'electron_root_ack' }, error => { if (error) fail('tree_monitor_failed') })
        return
      }
      if (isProcessSnapshot(message)) {
        if (!electronProducerPid || message.sequence !== lastSnapshotSequence + 1 || !message.pids.includes(electronProducerPid)) {
          throw new ProtocolError('tree_monitor_failed')
        }
        await treeMonitor.pinSnapshot(message.sequence, message.sampledAtFileTime, message.pids)
        lastSnapshotSequence = message.sequence
        if (message.final) {
          const key = [...message.pids].sort((left, right) => left - right).join(',')
          finalSnapshotStableCount = key === finalSnapshotKey ? finalSnapshotStableCount + 1 : 1
          finalSnapshotKey = key
        } else {
          finalSnapshotStableCount = 0
          finalSnapshotKey = null
        }
        child.send({ kind: 'process_snapshot_ack', sequence: message.sequence }, error => {
          if (error) fail('tree_monitor_failed')
        })
        return
      }
      if (exactKeys(message, ['kind']) && message.kind === 'final_snapshot_complete') {
        if (finalSnapshotStableCount < 3 || finalSnapshotComplete) throw new ProtocolError('tree_monitor_failed')
        finalSnapshotComplete = true
        return
      }
      if (childResult) throw new ProtocolError('child_result_invalid')
      childResult = validateChildRecord(message)
    } catch {
      pendingFailureCode = message?.kind ? 'tree_monitor_failed' : 'child_result_invalid'
      terminateChild()
    }
  }
  child.on('message', message => {
    childMessageChain = childMessageChain.then(() => handleChildMessage(message))
  })
  child.on('error', () => fail('electron_child_failed'))
  let exitCode = null
  let exitSignal = null
  child.on('exit', (code, signal) => {
    exitCode = code
    exitSignal = signal
  })
  child.on('close', () => {
    void finishAfterChildExit(child.pid, exitCode, exitSignal)
  })
  try {
    if (treeMonitor) await treeMonitor.attach(child.pid)
    else {
      treeMonitor = attachProcessTree(child.pid, childEnvironment(), __dirname)
      await treeMonitor.ready
    }
    childReady = true
  } catch {
    pendingFailureCode = 'tree_monitor_failed'
    terminateChild()
    return
  }
  if (pendingFailureCode) {
    terminateChild()
    return
  }
  child.send({
    protocolVersion: request.protocolVersion,
    command: request.command,
    runId: request.runId,
    authorizationUrl: request.authorizationUrl,
    gatewayOrigin: request.gatewayOrigin,
    profileRoot: request.profileRoot
  }, error => {
    if (error) fail('electron_child_failed')
  })
  if (pendingShutdownMessage) sendShutdown(pendingShutdownMessage)
}

function sendShutdown(message) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    fail('electron_child_failed')
    return
  }
  child.send(message, error => {
    if (error) fail('electron_child_failed')
  })
  shutdownTimer = setTimeout(() => {
    pendingFailureCode = 'shutdown_timeout'
    terminateChild()
  }, SHUTDOWN_TIMEOUT_MS)
  shutdownTimer.unref()
}

function requestShutdown(message) {
  if (!childReady) {
    pendingShutdownMessage = message
    return
  }
  sendShutdown(message)
}

input.on('line', line => {
  if (outputWritten) return
  if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
    fail('live_input_invalid')
    return
  }
  try {
    const value = parseJsonLine(line)
    const message = protocol.accept(value)
    if (message.command === 'start') {
      start = message
      void launch(message)
    } else {
      requestShutdown(message)
    }
  } catch (error) {
    fail(error instanceof ProtocolError ? error.code : 'live_input_invalid')
  }
})

input.on('close', () => {
  if (!outputWritten && protocol.phase !== 'shutdown_received') fail(start ? 'launcher_protocol_eof' : 'live_input_invalid')
})

process.on('SIGINT', () => fail('operator_canceled'))
process.on('SIGTERM', () => fail('operator_canceled'))
process.on('exit', () => treeMonitor?.dispose?.())
process.on('uncaughtException', () => fail('internal_failure'))
process.on('unhandledRejection', () => fail('internal_failure'))
