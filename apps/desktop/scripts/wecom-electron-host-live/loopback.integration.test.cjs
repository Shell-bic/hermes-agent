const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

test('pinned Electron uses IPC and fails closed against an unreachable loopback Gateway', { timeout: 30_000 }, async () => {
  const profileRoot = path.join(os.tmpdir(), `pb02-live-ipc-${crypto.randomUUID()}`)
  const state = 'A'.repeat(43)
  const authorizationUrl = `https://127.0.0.1:1/wecom/bot-poc/${crypto.randomUUID()}?state=${state}`
  const child = spawn(process.execPath, [path.join(__dirname, 'run.cjs')], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: false
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.write(`${JSON.stringify({
    protocolVersion: 1,
    command: 'start',
    runId: crypto.randomUUID(),
    authorizationUrl,
    gatewayOrigin: 'https://127.0.0.1:1',
    profileRoot
  })}\n`)

  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  try {
    assert.equal(exit.code, 1)
    assert.equal(exit.signal, null)
    assert.equal(stderr, '')
    const lines = stdout.trim().split(/\r?\n/u)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^PB02_ELECTRON_LIVE_RESULT=/u)
    const result = JSON.parse(lines[0].slice('PB02_ELECTRON_LIVE_RESULT='.length))
    assert.equal(result.failureCode, 'gateway_load_failed')
    assert.equal(result.electronVersion, '40.10.2')
    assert.equal(result.cleanupStatus, 'retained')
    assert.equal(result.producerMarkerStatus, 'operator_asserted')
    assert.equal(stdout.includes(authorizationUrl), false)
    assert.equal(stdout.includes(state), false)

    const marker = JSON.parse(fs.readFileSync(path.join(profileRoot, '.wecom-pb02-producer.json'), 'utf8'))
    assert.equal(marker.runId.length, 36)
    assert.equal(marker.producer, 'electron-auth-probe')
    assert.equal(marker.quiescent, true)
    assert.match(marker.finishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}\+00:00$/u)
    assert.equal(stdout.includes(marker.runId), false)
    assert.equal(fs.readFileSync(path.join(profileRoot, '.wecom-pb02-producer.json'), 'utf8').includes(state), false)
    assert.throws(() => process.kill(marker.producerPid, 0))
  } finally {
    fs.rmSync(profileRoot, { recursive: true, force: true })
  }
})
