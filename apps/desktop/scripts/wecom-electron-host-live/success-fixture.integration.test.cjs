const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { childEnvironment } = require('./launcher-core.cjs')
const { WindowsProcessHandleMonitor } = require('./process-tree.cjs')

function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function runScenario(scenario, pfxPath, password) {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pb02-success-${scenario}-`))
  for (const name of ['profile', 'session-data', 'logs', 'crash-dumps', 'cache']) fs.mkdirSync(path.join(profileRoot, name))
  const monitor = process.platform === 'win32'
    ? WindowsProcessHandleMonitor.prepare(childEnvironment(), __dirname)
    : null
  if (monitor) await monitor.bootstrapReady
  const execution = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'electron-success-fixture-bootstrap.cjs')], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: {
        ...process.env,
        PB02_FIXTURE_SCENARIO: scenario,
        PB02_FIXTURE_PROFILE: profileRoot,
        PB02_FIXTURE_PFX: pfxPath,
        PB02_FIXTURE_PFX_PASSWORD: password
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: false
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const attached = monitor ? monitor.attach(child.pid) : Promise.resolve()
    let electronPid = null
    let lastSequence = 0
    let finalKey = null
    let finalStableCount = 0
    let finalSnapshotComplete = false
    let lateUtilityPid = null
    let lateUtilityObserved = false
    let messageChain = Promise.resolve()
    child.on('message', message => {
      messageChain = messageChain.then(async () => {
        if (message?.kind === 'electron_producer' && Number.isSafeInteger(message.pid) && !electronPid) {
          electronPid = message.pid
          await attached
          if (monitor) await monitor.pinElectronRoot(electronPid)
          return
        }
        if (message?.kind === 'process_snapshot' && Number.isSafeInteger(message.sequence) &&
            typeof message.sampledAtFileTime === 'string' && Array.isArray(message.pids) && electronPid &&
            message.sequence === lastSequence + 1 && message.pids.includes(electronPid)) {
          if (monitor) await monitor.pinSnapshot(message.sequence, message.sampledAtFileTime, message.pids)
          if (lateUtilityPid && message.pids.includes(lateUtilityPid)) lateUtilityObserved = true
          lastSequence = message.sequence
          if (message.final) {
            const key = [...message.pids].sort((left, right) => left - right).join(',')
            finalStableCount = key === finalKey ? finalStableCount + 1 : 1
            finalKey = key
          } else {
            finalStableCount = 0
            finalKey = null
          }
          child.send({ kind: 'process_snapshot_ack', sequence: message.sequence })
          return
        }
        if (message?.kind === 'fixture_late_utility' && Object.keys(message).length === 2 &&
            Number.isSafeInteger(message.pid) && message.pid > 0 && !lateUtilityPid) {
          lateUtilityPid = message.pid
          return
        }
        if (message?.kind === 'final_snapshot_complete' && Object.keys(message).length === 1 && finalStableCount >= 3) {
          finalSnapshotComplete = true
          return
        }
        throw new Error('fixture_protocol_invalid')
      })
    })
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      monitor?.dispose()
      reject(new Error(`${scenario}_fixture_timeout`))
    }, 30_000)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      void attached.then(async () => {
        await messageChain
        const tree = monitor ? await monitor.quiesce() : { quiescent: true, capturedProcessCount: 1 }
        const lines = stdout.trim().split(/\r?\n/u)
        assert.equal(lines.length, 1)
        assert.match(lines[0], /^PB02_ELECTRON_LIVE_FIXTURE_RESULT=/u)
        const record = JSON.parse(lines[0].slice('PB02_ELECTRON_LIVE_FIXTURE_RESULT='.length))
        resolve({ code, record, stderr, tree, monitorPid: monitor?.process.pid, finalSnapshotComplete, lateUtilityObserved })
      }).catch(error => {
        monitor?.dispose()
        reject(error)
      }).finally(() => fs.rmSync(profileRoot, { recursive: true, force: true }))
    })
  })
  return execution
}

test('shared pinned Electron host covers success, nested popup denial, and redirect denial', { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb02-success-cert-'))
  const pfxPath = path.join(root, 'fixture.pfx')
  const password = crypto.randomBytes(24).toString('base64url')
  try {
    execFileSync('dotnet', ['dev-certs', 'https', '--export-path', pfxPath, '--password', password], {
      stdio: 'ignore', windowsHide: true
    })
    const success = await runScenario('success', pfxPath, password)
    const successDiagnostic = JSON.stringify({
      record: success.record,
      tree: success.tree,
      exit: { code: success.code, monitorAlive: isAlive(success.monitorPid), finalSnapshotComplete: success.finalSnapshotComplete }
    })
    assert.equal(success.code, 0, successDiagnostic)
    assert.equal(success.record.result, 'PASS')
    assert.equal(success.record.failureCode, 'none')
    assert.equal(success.record.popupCreated, true)
    assert.equal(success.record.officialOriginObserved, true)
    assert.equal(success.record.navigationPolicyPassed, true)
    assert.equal(success.tree.quiescent, true)
    assert.ok(success.tree.capturedProcessCount >= (process.platform === 'win32' ? 2 : 1))
    assert.equal(success.finalSnapshotComplete, true)
    assert.equal(success.lateUtilityObserved, true)
    assert.equal(isAlive(success.monitorPid), false)

    const nested = await runScenario('nested', pfxPath, password)
    assert.equal(nested.code, 1)
    assert.equal(nested.record.failureCode, 'popup_blocked')
    assert.equal(nested.record.navigationPolicyPassed, false)
    assert.equal(nested.finalSnapshotComplete, true)
    assert.equal(isAlive(nested.monitorPid), false)

    const redirect = await runScenario('redirect', pfxPath, password)
    assert.equal(redirect.code, 1)
    assert.equal(redirect.record.failureCode, 'navigation_blocked')
    assert.equal(redirect.record.navigationPolicyPassed, false)
    assert.equal(redirect.finalSnapshotComplete, true)
    assert.equal(isAlive(redirect.monitorPid), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
