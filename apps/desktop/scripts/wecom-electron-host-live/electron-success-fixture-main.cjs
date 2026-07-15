const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const { app, BrowserWindow, session, utilityProcess, webContents } = require('electron')
const { createElectronHost } = require('./electron-host.cjs')

const scenario = process.env.PB02_FIXTURE_SCENARIO
const profileRoot = process.env.PB02_FIXTURE_PROFILE
const pfxPath = process.env.PB02_FIXTURE_PFX
const passphrase = process.env.PB02_FIXTURE_PFX_PASSWORD
if (!['success', 'nested', 'redirect'].includes(scenario) || !profileRoot || !pfxPath || !passphrase) process.exit(1)

for (const [name, directory] of Object.entries({
  userData: 'profile', sessionData: 'session-data', logs: 'logs', crashDumps: 'crash-dumps', cache: 'cache'
})) app.setPath(name, path.join(profileRoot, directory))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-breakpad')
app.on('window-all-closed', () => {})

const transactionId = '22222222-2222-4222-8222-222222222222'
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const state = 'A'.repeat(43)
const tls = { pfx: fs.readFileSync(pfxPath), passphrase }
let gatewayServer
let authServer
let host
let finished = false
let snapshotSequence = 0
let snapshotTimer = null
let snapshotInFlight = Promise.resolve()
const pendingSnapshotAcks = new Map()
let lateUtilityStarted = false

function fileTimeNow() {
  const unixMilliseconds = performance.timeOrigin + performance.now()
  const wholeMilliseconds = Math.floor(unixMilliseconds)
  const fractionalTicks = Math.floor((unixMilliseconds - wholeMilliseconds) * 10_000)
  return (BigInt(wholeMilliseconds) * 10_000n + BigInt(fractionalTicks) + 116_444_736_000_000_000n).toString()
}

function sendSnapshot(final) {
  const sequence = ++snapshotSequence
  const sampledAtFileTime = fileTimeNow()
  const pids = [...new Set([process.pid, ...app.getAppMetrics().map(metric => metric.pid)])]
    .filter(pid => Number.isSafeInteger(pid) && pid > 0)
    .sort((left, right) => left - right)
  if (pids.length < 1 || pids.length > 64) return Promise.reject(new Error('snapshot_invalid'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSnapshotAcks.delete(sequence)
      reject(new Error('snapshot_timeout'))
    }, 5_000)
    pendingSnapshotAcks.set(sequence, {
      resolve: () => { clearTimeout(timer); resolve(pids) },
      reject: error => { clearTimeout(timer); reject(error) }
    })
    process.send({ kind: 'process_snapshot', sequence, final, sampledAtFileTime, pids }, error => {
      if (!error) return
      const pending = pendingSnapshotAcks.get(sequence)
      pendingSnapshotAcks.delete(sequence)
      pending?.reject(error)
    })
  })
}

function scheduleSnapshot() {
  if (finished) return
  snapshotTimer = setTimeout(() => {
    snapshotInFlight = sendSnapshot(false)
    snapshotInFlight.then(scheduleSnapshot, () => app.exit(1))
  }, 25)
  snapshotTimer.unref()
}

process.on('message', message => {
  if (message?.kind !== 'process_snapshot_ack' || !Number.isSafeInteger(message.sequence)) return app.exit(1)
  const pending = pendingSnapshotAcks.get(message.sequence)
  if (!pending) return app.exit(1)
  pendingSnapshotAcks.delete(message.sequence)
  pending.resolve()
})

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

async function finish(record) {
  if (finished) return
  finished = true
  if (snapshotTimer) clearTimeout(snapshotTimer)
  await snapshotInFlight
  await Promise.all([close(gatewayServer), close(authServer)])
  let previous = null
  let stable = 0
  for (let attempt = 0; attempt < 40 && stable < 3; attempt += 1) {
    const pids = await sendSnapshot(true)
    const key = pids.join(',')
    stable = key === previous ? stable + 1 : 1
    previous = key
    if (stable < 3) await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (stable < 3) throw new Error('snapshot_unstable')
  await new Promise((resolve, reject) => process.send({ kind: 'final_snapshot_complete' }, error => error ? reject(error) : resolve()))
  process.stdout.write(`PB02_ELECTRON_LIVE_FIXTURE_RESULT=${JSON.stringify(record)}\n`)
  app.exit(record.result === 'PASS' ? 0 : 1)
}

async function main() {
  let authOrigin
  authServer = https.createServer(tls, (request, response) => {
    const url = new URL(request.url, authOrigin)
    if (url.pathname === '/ai/qc/gen' && scenario === 'redirect') {
      response.writeHead(302, { Location: `${authOrigin}/redirected` })
      response.end()
      return
    }
    if (url.pathname === '/ai/qc/gen') {
      const nested = scenario === 'nested'
        ? `<script>window.open(${JSON.stringify(`${authOrigin}/nested`)}, '_blank')</script>`
        : ''
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(`<!doctype html><html><body>fixture popup${nested}</body></html>`)
      return
    }
    response.writeHead(404)
    response.end()
  })
  const authPort = await listen(authServer)
  authOrigin = `https://127.0.0.1:${authPort}`

  let gatewayOrigin
  gatewayServer = https.createServer(tls, (request, response) => {
    const url = new URL(request.url, gatewayOrigin)
    if (url.pathname !== `/wecom/bot-poc/${transactionId}`) {
      response.writeHead(404)
      response.end()
      return
    }
    const popupUrl = `${authOrigin}/ai/qc/gen?source=fixture.source&state=${state}&timestamp=1784088000000`
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(`<!doctype html><html><body><script>
      history.replaceState(null, '', location.pathname);
      setTimeout(() => window.open(${JSON.stringify(popupUrl)}, '_blank'), 25);
    </script>fixture gateway</body></html>`)
  })
  const gatewayPort = await listen(gatewayServer)
  gatewayOrigin = `https://127.0.0.1:${gatewayPort}`
  const authorizationUrl = `${gatewayOrigin}/wecom/bot-poc/${transactionId}?state=${state}`
  const start = {
    protocolVersion: 1,
    command: 'start',
    runId,
    authorizationUrl,
    gatewayOrigin,
    profileRoot,
    authorizationPath: `/wecom/bot-poc/${transactionId}`,
    state
  }
  host = createElectronHost({
    app, BrowserWindow, session, webContents, start,
    authOrigin,
    authPath: '/ai/qc/gen',
    configureSession: isolated => isolated.setCertificateVerifyProc((request, callback) => {
      callback(request.hostname === '127.0.0.1' ? 0 : -3)
    }),
    onObservation: observation => {
      if (scenario === 'success' && observation.mainHistorySanitized && observation.officialOriginObserved && !lateUtilityStarted) {
        lateUtilityStarted = true
        const utility = utilityProcess.fork(path.join(__dirname, 'electron-success-fixture-late-utility.cjs'), [], {
          serviceName: 'PB02 late utility fixture'
        })
        utility.once('spawn', () => {
          process.send({ kind: 'fixture_late_utility', pid: utility.pid })
          setTimeout(() => host.shutdown(), 100)
        })
        utility.once('error', () => app.exit(1))
      }
    },
    onFinish: record => void finish(record)
  })
  await app.whenReady()
  scheduleSnapshot()
  await host.start()
}

main().catch(() => {
  process.stdout.write('PB02_ELECTRON_LIVE_FIXTURE_RESULT={"result":"FAIL","failureCode":"fixture_internal"}\n')
  app.exit(1)
})
