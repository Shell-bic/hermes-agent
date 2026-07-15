const assert = require('node:assert/strict')
const { execFile, execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { childEnvironment } = require('./launcher-core.cjs')
const { WindowsProcessHandleMonitor } = require('./process-tree.cjs')

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => reject(new Error('process exit timeout')), timeoutMs)
    child.once('close', () => { clearTimeout(timer); resolve() })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

function spawnIdle() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', windowsHide: true
  })
}

function fileTimeNow() {
  return (BigInt(Date.now()) * 10_000n + 116_444_736_000_000_000n).toString()
}

test('Windows process-handle monitor rejects a reused PID identity without replacing the pinned identity', {
  skip: process.platform !== 'win32',
  timeout: 30_000
}, async () => {
  const script = path.join(__dirname, 'windows-process-handle-monitor.ps1')
  const result = await new Promise((resolve, reject) => {
    execFile('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
      cwd: __dirname,
      env: { ...childEnvironment(), PB02_HANDLE_MONITOR_IDENTITY_SELF_TEST: '1' },
      windowsHide: true
    }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))
  })
  assert.equal(result.stdout.trim(), 'IDENTITY_SELF_TEST_PASS')
  assert.equal(result.stderr, '')

  const source = fs.readFileSync(script, 'utf8')
  assert.equal(source.includes(['AssignProcess', 'ToJobObject'].join('')), false)
  assert.equal(source.includes(['Terminate', 'JobObject'].join('')), false)
  assert.equal(source.includes('TerminateProcess(entry.Handle'), true)
  const electronRootMethod = source.slice(
    source.indexOf('public int AttachElectronRoot'),
    source.indexOf('public int PinReported')
  )
  const open = electronRootMethod.indexOf('OpenProcessIdentity(pid, true, true)')
  const validate = electronRootMethod.indexOf('ValidateElectronRoot(root)')
  const electronRootValidation = source.slice(
    source.indexOf('void ValidateElectronRoot'),
    source.indexOf('static void VerifyStillSame')
  )
  const snapshot = electronRootValidation.indexOf('SnapshotParents()')
  const postSnapshotAlive = electronRootValidation.indexOf('VerifyStillSame(root)', snapshot)
  assert.ok(open >= 0 && validate > open, 'Electron root handle and creation identity must be pinned before parent validation')
  assert.ok(snapshot >= 0, 'Electron root parent validation must use a process snapshot')
  assert.ok(postSnapshotAlive > snapshot, 'the same pinned Electron handle must be alive after parent snapshot')
  assert.equal(source.includes('launcher.Identity > monitorSelf.Identity || monitorSelf.Identity > bootstrap.Identity'), true)
  const initialValidation = source.slice(
    source.indexOf('void ValidateInitialControlChain'),
    source.indexOf('void ValidateElectronRoot')
  )
  const initialSnapshot = initialValidation.indexOf('SnapshotParents()')
  assert.ok(initialValidation.indexOf('VerifyStillSame(monitorSelf)', initialSnapshot) > initialSnapshot,
    'the same pinned monitor handle must be alive after parent snapshot')
})

test('Windows process-handle monitor rejects a bootstrap that is not a direct launcher child', {
  skip: process.platform !== 'win32',
  timeout: 30_000
}, async () => {
  const monitor = WindowsProcessHandleMonitor.prepare(childEnvironment(), __dirname)
  await monitor.bootstrapReady
  const intermediateScript = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    'process.stdout.write(String(child.pid) + "\\n")',
    'setInterval(() => {}, 1000)'
  ].join(';')
  const intermediate = spawn(process.execPath, ['-e', intermediateScript], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
  })
  intermediate.stdout.setEncoding('utf8')
  const bootstrapPid = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('bootstrap pid timeout')), 5_000)
    intermediate.stdout.on('data', chunk => {
      buffer += chunk
      const match = buffer.match(/^([1-9][0-9]*)\r?\n/u)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
    intermediate.once('error', reject)
  })
  try {
    await assert.rejects(() => monitor.attach(bootstrapPid), /tree_monitor_failed/u)
    assert.equal(isAlive(process.pid), true)
    assert.equal(isAlive(intermediate.pid), true)
    assert.equal(isAlive(bootstrapPid), true)
  } finally {
    monitor.dispose()
    if (isAlive(bootstrapPid)) {
      try { process.kill(bootstrapPid) } catch {}
    }
    if (isAlive(intermediate.pid)) intermediate.kill()
    await waitForExit(intermediate).catch(() => {})
  }
})

test('Windows process-handle monitor rejects an Electron root outside the pinned bootstrap', {
  skip: process.platform !== 'win32',
  timeout: 30_000
}, async () => {
  const monitor = WindowsProcessHandleMonitor.prepare(childEnvironment(), __dirname)
  await monitor.bootstrapReady
  const bootstrap = spawnIdle()
  const unrelated = spawnIdle()
  try {
    await monitor.attach(bootstrap.pid)
    await assert.rejects(() => monitor.pinElectronRoot(unrelated.pid), /tree_monitor_failed/u)
    assert.equal(isAlive(process.pid), true)
    assert.equal(isAlive(bootstrap.pid), true)
    assert.equal(isAlive(unrelated.pid), true)
  } finally {
    monitor.dispose()
    if (isAlive(bootstrap.pid)) bootstrap.kill()
    if (isAlive(unrelated.pid)) unrelated.kill()
    await Promise.all([waitForExit(bootstrap).catch(() => {}), waitForExit(unrelated).catch(() => {})])
  }
})

test('Windows process-handle monitor terminates only explicitly pinned target processes while caller and sibling survive', {
  skip: process.platform !== 'win32',
  timeout: 30_000
}, async () => {
  const guard = WindowsProcessHandleMonitor.prepare(childEnvironment(), __dirname)
  await guard.bootstrapReady
  const parentScript = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    'process.stdout.write(String(child.pid) + "\\n")',
    'setInterval(() => {}, 1000)'
  ].join(';')
  const sibling = spawnIdle()
  const callerPid = process.pid
  const parent = spawn(process.execPath, ['-e', parentScript], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  })
  parent.stdout.setEncoding('utf8')
  const descendantPid = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('descendant pid timeout')), 5_000)
    parent.stdout.on('data', chunk => {
      buffer += chunk
      const match = buffer.match(/^([1-9][0-9]*)\r?\n/u)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    parent.once('error', reject)
  })

  try {
    await guard.attach(parent.pid)
    await guard.pinElectronRoot(descendantPid)
    await guard.pinSnapshot(1, fileTimeNow(), [descendantPid])
    const result = await guard.quiesce()
    assert.equal(result.quiescent, true)
    assert.ok(result.capturedProcessCount >= 2)
    assert.equal(isAlive(parent.pid), false)
    assert.equal(isAlive(descendantPid), false)
    assert.equal(isAlive(callerPid), true)
    assert.equal(isAlive(sibling.pid), true)
    assert.equal(isAlive(guard.process.pid), false)
  } finally {
    if (isAlive(parent.pid)) {
      try { execFileSync('taskkill.exe', ['/PID', String(parent.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    }
    if (isAlive(sibling.pid)) sibling.kill()
    await waitForExit(sibling).catch(() => {})
  }
})

test('Windows process-handle monitor does not capture unrelated work after the root exits', {
  skip: process.platform !== 'win32',
  timeout: 30_000
}, async () => {
  const guard = WindowsProcessHandleMonitor.prepare(childEnvironment(), __dirname)
  await guard.bootstrapReady
  const target = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10000)'], {
    stdio: 'ignore', windowsHide: true
  })
  let unrelated = null
  try {
    await guard.attach(target.pid)
    target.kill()
    await waitForExit(target)
    unrelated = spawnIdle()
    const result = await guard.quiesce()
    assert.equal(result.quiescent, true)
    assert.ok(result.capturedProcessCount >= 1)
    assert.equal(isAlive(unrelated.pid), true)
    assert.equal(isAlive(process.pid), true)
    assert.equal(isAlive(guard.process.pid), false)
  } finally {
    guard.dispose()
    if (unrelated && isAlive(unrelated.pid)) unrelated.kill()
    if (unrelated) await waitForExit(unrelated).catch(() => {})
    if (isAlive(target.pid)) target.kill()
  }
})

test('Windows process-handle monitor crash fails closed without killing caller, target, or sibling', {
  skip: process.platform !== 'win32',
  timeout: 30_000
}, async () => {
  const monitor = WindowsProcessHandleMonitor.prepare(childEnvironment(), __dirname)
  await monitor.bootstrapReady
  const target = spawnIdle()
  const sibling = spawnIdle()
  try {
    await monitor.attach(target.pid)
    monitor.process.kill()
    await waitForExit(monitor.process)
    await assert.rejects(() => monitor.quiesce(), /tree_monitor_failed/u)
    assert.equal(isAlive(process.pid), true)
    assert.equal(isAlive(target.pid), true)
    assert.equal(isAlive(sibling.pid), true)
  } finally {
    monitor.dispose()
    if (isAlive(target.pid)) target.kill()
    if (isAlive(sibling.pid)) sibling.kill()
    await Promise.all([waitForExit(target).catch(() => {}), waitForExit(sibling).catch(() => {})])
  }
})
