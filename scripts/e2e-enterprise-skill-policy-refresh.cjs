#!/usr/bin/env node

/**
 * U5 P2 partial cross-process acceptance harness.
 *
 * Starts the real Gateway and the built Electron application. Electron owns
 * the real Python backend; this harness talks to the production preload bridge
 * through a random Chrome DevTools Protocol port.
 *
 * Usage:
 *   node scripts/e2e-enterprise-skill-policy-refresh.cjs --gateway-root <path>
 *
 * Optional:
 *   --python <path>
 *   U5_P2_KEEP_TEMP=1
 *   U5_P2_VERBOSE=1
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const DESKTOP_ROOT = path.resolve(__dirname, '..')
const DESKTOP_APP_ROOT = path.join(DESKTOP_ROOT, 'apps', 'desktop')
const FIXTURE_NAME = 'expense-review'
const FIXTURE_ROOT = path.join(
  DESKTOP_ROOT,
  'contracts',
  'enterprise-skill-hub',
  'v1',
  'fixtures',
  'valid',
  FIXTURE_NAME
)
const DEFAULT_PASSWORD = 'ChangeMe!12345'
const GATES = [
  'real Gateway and built Electron startup',
  'renderer login and Python backend connection',
  'available-to-blocked policy hash refresh',
  'invalid bootstrap preserves stale last-known-good',
  'Electron and backend PID stability',
  'Gateway-down stale last-known-good refresh',
  'no-LKG fail-closed',
  'prompt and new-session behavior',
  'Bundle and Cron operation snapshots',
  'desktop-token-only artifact scan',
  'Gateway/backend token sentinel scan',
  'cleanup'
]

function parseArguments(argv) {
  const options = { python: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--gateway-root') options.gatewayRoot = path.resolve(argv[++index] || '')
    else if (value === '--python') options.python = path.resolve(argv[++index] || '')
    else if (value === '--help' || value === '-h') options.help = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  return options
}

function usage() {
  console.log(
    'Usage: node scripts/e2e-enterprise-skill-policy-refresh.cjs ' +
      '--gateway-root <path> [--python <path>]'
  )
}

function recordGate(results, gate, status, detail) {
  assert.ok(GATES.includes(gate), `Unknown gate: ${gate}`)
  if (!results.has(gate)) results.set(gate, { detail, status })
}

function printResults(results) {
  for (const gate of GATES) {
    const result = results.get(gate) || { status: 'NOT-RUN', detail: 'blocked by an earlier gate' }
    console.log(`${result.status} ${gate}: ${result.detail}`)
  }
  console.log([...results.values()].some(result => result.status === 'FAIL') ? 'overall=failed' : 'overall=partial')
}

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  return port
}

function isBootstrapPath(requestUrl) {
  try {
    return new URL(requestUrl, 'http://fault-proxy.local').pathname === '/api/desktop/bootstrap'
  } catch {
    return false
  }
}

function isRuntimeManifestPath(requestUrl) {
  try {
    return new URL(requestUrl, 'http://fault-proxy.local').pathname === '/api/desktop/runtime-manifest'
  } catch {
    return false
  }
}

function mutateBootstrapPayload(payload, fault) {
  const result = structuredClone(payload)
  result.harnessFaultMarker = fault.marker

  switch (fault.kind) {
    case 'locked-missing':
      delete result.lockedSurfaces
      break
    case 'locked-type':
      result.lockedSurfaces = { marker: fault.marker }
      break
    case 'capabilities-duplicate':
      result.capabilities = ['chat', 'chat']
      break
    case 'capabilities-control':
      result.capabilities = ['chat', `${fault.marker}\u0000control`]
      break
    case 'capabilities-path':
      result.capabilities = [`../${fault.marker}`]
      break
    default:
      throw new Error(`Unknown bootstrap fault: ${fault.kind}`)
  }

  return result
}

async function startGatewayFaultProxy({ targetBaseUrl }) {
  const state = {
    bootstrapFault: null,
    desktopTokens: new Set(),
    faultMarkers: new Set(),
    gatewayTokens: new Set()
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestChunks = []
      for await (const chunk of request) requestChunks.push(chunk)
      const requestBody = Buffer.concat(requestChunks)
      const authorization = String(request.headers.authorization || '')
      const desktopToken = authorization.match(/^Bearer\s+(dsk_[A-Za-z0-9_-]+)$/i)?.[1]
      if (desktopToken) state.desktopTokens.add(desktopToken)

      if (isBootstrapPath(request.url) && state.bootstrapFault?.kind === 'status-503') {
        const body = Buffer.from(JSON.stringify({
          detail: 'Enterprise bootstrap is temporarily unavailable.',
          status: 503,
          title: 'Service Unavailable'
        }))
        response.writeHead(503, {
          'Content-Length': String(body.length),
          'Content-Type': 'application/problem+json'
        })
        response.end(body)
        return
      }

      const upstream = await fetch(new URL(request.url, targetBaseUrl), {
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : requestBody,
        headers: request.headers,
        method: request.method,
        redirect: 'manual'
      })
      let body = Buffer.from(await upstream.arrayBuffer())
      let contentType = upstream.headers.get('content-type') || 'application/octet-stream'

      if (upstream.ok && isBootstrapPath(request.url) && state.bootstrapFault) {
        const payload = JSON.parse(body.toString('utf8'))
        const mutated = mutateBootstrapPayload(payload, state.bootstrapFault)
        state.faultMarkers.add(state.bootstrapFault.marker)
        body = Buffer.from(JSON.stringify(mutated))
        contentType = 'application/json; charset=utf-8'
      }

      if (upstream.ok && isRuntimeManifestPath(request.url)) {
        const payload = JSON.parse(body.toString('utf8'))
        const gatewayToken = String(payload?.gatewayToken || '').trim()
        if (gatewayToken) state.gatewayTokens.add(gatewayToken)
      }

      const headers = {}
      for (const [name, value] of upstream.headers.entries()) {
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) {
          headers[name] = value
        }
      }
      headers['content-length'] = String(body.length)
      headers['content-type'] = contentType
      response.writeHead(upstream.status, headers)
      response.end(body)
    } catch {
      const body = Buffer.from(JSON.stringify({
        detail: 'Enterprise Gateway upstream request failed.',
        status: 502,
        title: 'Bad Gateway'
      }))
      response.writeHead(502, {
        'Content-Length': String(body.length),
        'Content-Type': 'application/problem+json'
      })
      response.end(body)
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
    port: address.port,
    setBootstrapFault(fault) {
      state.bootstrapFault = fault
    },
    state
  }
}

function gatewayDll(gatewayRoot) {
  const buildRoot = path.join(gatewayRoot, 'EnterpriseGateway.Api', 'bin', 'Debug')
  if (!fs.existsSync(buildRoot)) return null
  return fs
    .readdirSync(buildRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(buildRoot, entry.name, 'EnterpriseGateway.Api.dll'))
    .find(candidate => fs.existsSync(candidate)) || null
}

function pathCandidates(command) {
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
    return result.status === 0 ? result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : []
  }
  const result = spawnSync('sh', ['-lc', `command -v -a ${command} 2>/dev/null || true`], { encoding: 'utf8' })
  return result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
}

function pythonWorks(candidate) {
  if (!candidate) return false
  const result = spawnSync(
    candidate,
    [
      '-c',
      [
        'import fastapi, uvicorn, yaml',
        'import concurrent_log_handler, hermes_logging',
        'import hermes_cli.web_server, run_agent',
        'print("u5-p2-python-ready")'
      ].join('; ')
    ],
    {
      cwd: DESKTOP_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONPATH: [DESKTOP_ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
      },
      windowsHide: true
    }
  )
  return result.status === 0 && result.stdout.includes('u5-p2-python-ready')
}

function resolvePython(explicit) {
  const candidates = [
    explicit,
    process.env.HERMES_DESKTOP_PYTHON,
    process.env.PYTHON,
    ...pathCandidates(process.platform === 'win32' ? 'python' : 'python3'),
    ...(process.platform === 'win32' ? [] : pathCandidates('python'))
  ].filter(Boolean)
  const seen = new Set()
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    if (pythonWorks(resolved)) return resolved
  }
  return null
}

function lineBuffer(label, stream, logPath) {
  let tail = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    tail = (tail + chunk).slice(-20000)
    fs.appendFileSync(logPath, chunk, 'utf8')
    if (process.env.U5_P2_VERBOSE === '1') process.stdout.write(`[${label}] ${chunk}`)
  })
  return () => tail
}

function startProcess(label, command, args, { cwd, env, logPath }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const stdout = lineBuffer(label, child.stdout, logPath)
  const stderr = lineBuffer(label, child.stderr, logPath)
  return { child, label, stdout, stderr }
}

async function stopProcess(info, tree = false) {
  if (!info || info.child.exitCode != null || info.child.signalCode != null) return
  const exited = new Promise(resolve => info.child.once('exit', resolve))
  if (tree && process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(info.child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
  } else {
    info.child.kill()
  }
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 7000))])
  if (info.child.exitCode == null && info.child.signalCode == null) {
    info.child.kill('SIGKILL')
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 7000))])
  }
  assert.ok(
    info.child.exitCode != null || info.child.signalCode != null,
    `${info.label} did not exit after termination`
  )
}

async function waitForGateway(info, baseUrl, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    if (info.child.exitCode != null) {
      throw new Error(`Gateway exited before readiness.\n${info.stdout()}\n${info.stderr()}`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/desktop/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'view', password: DEFAULT_PASSWORD })
      })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for Gateway: ${lastError?.message || 'no response'}`)
}

async function startGateway(context) {
  const info = startProcess('gateway', process.env.DOTNET || 'dotnet', [context.gatewayDll], {
    cwd: path.join(context.gatewayRoot, 'EnterpriseGateway.Api'),
    env: {
      ASPNETCORE_ENVIRONMENT: 'Development',
      'ConnectionStrings__EnterpriseGateway': `Data Source=${context.databasePath}`,
      'Gateway__PublicBaseUrl': `${context.gatewayBaseUrl}/v1`,
      'Kestrel__Endpoints__http__Url': context.gatewayBaseUrl,
      'SkillHub__ArtifactRoot': context.artifactRoot,
      'SkillHub__CatalogRoot': context.catalogRoot,
      'SkillHub__Enabled': 'true'
    },
    logPath: path.join(context.runRoot, 'gateway.log')
  })
  await waitForGateway(info, context.gatewayBaseUrl)
  return info
}

async function jsonRequest(url, { body, method = 'GET', token } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = text
  }
  if (!response.ok) throw new Error(`${response.status} ${payload?.detail || payload?.message || text}`)
  return payload
}

async function setSkillPolicy(baseUrl, status) {
  const login = await jsonRequest(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    body: { username: 'admin', password: DEFAULT_PASSWORD }
  })
  const token = login.token
  const roles = await jsonRequest(`${baseUrl}/api/admin/roles`, { token })
  const role = roles.find(item => item.name === 'default-employee')
  assert.ok(role, 'default-employee role not found')
  const policy = await jsonRequest(`${baseUrl}/api/admin/roles/${role.id}/tool-policy`, { token })
  const skill = policy.skills.find(item => item.key === FIXTURE_NAME)
  assert.ok(skill, `${FIXTURE_NAME} is not in the role policy catalog`)
  await jsonRequest(`${baseUrl}/api/admin/roles/${role.id}/tool-policy`, {
    method: 'PUT',
    token,
    body: {
      skills: [{
        id: skill.id,
        status,
        reason: `U5 P2 acceptance ${status}`
      }]
    }
  })
}

async function waitForCdpTarget(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) return target
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for Electron CDP target: ${lastError?.message || 'no page target'}`)
}

async function connectCdp(webSocketDebuggerUrl) {
  assert.equal(typeof WebSocket, 'function', 'This harness requires a Node runtime with global WebSocket')
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening Electron CDP WebSocket')), 10000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Electron CDP WebSocket failed to open'))
    }, { once: true })
  })

  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { reject, resolve })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { close: () => socket.close(), send }
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
    userGesture: true
  })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  }
  return response.result?.value
}

async function waitForRendererBridge(cdp, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, 'Boolean(window.hermesDesktop?.enterprise?.login && window.hermesDesktop?.getConnection)')) {
        return
      }
    } catch {
      // Renderer may be navigating while the built bundle starts.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for the production preload bridge')
}

function policyStatus(state) {
  return state?.toolPolicySnapshot?.skills?.find(item => item.key === FIXTURE_NAME)?.status || null
}

function portFromBaseUrl(baseUrl) {
  const parsed = new URL(baseUrl)
  return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
}

function listeningProcessId(port) {
  if (process.platform === 'win32') {
    const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) return null
    for (const line of result.stdout.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/)
      if (columns.length < 5 || columns[3] !== 'LISTENING') continue
      const local = columns[1]
      if (Number(local.slice(local.lastIndexOf(':') + 1)) === port) return Number(columns[4]) || null
    }
    return null
  }
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  return result.status === 0 ? Number(result.stdout.trim().split(/\r?\n/)[0]) || null : null
}

async function waitForPortClosed(port, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!listeningProcessId(port)) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${label} port ${port} remained open after process termination`)
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function scanTokenArtifacts(runRoot) {
  const findings = []
  const allowedExtensions = new Set(['.json', '.log', '.md', '.txt', '.yaml', '.yml'])
  const pending = [runRoot]
  while (pending.length) {
    const current = pending.pop()
    let entries = []
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(target)
        continue
      }
      if (!entry.isFile() || !allowedExtensions.has(path.extname(entry.name).toLowerCase())) continue
      const stat = await fs.promises.stat(target).catch(() => null)
      if (!stat || stat.size > 5 * 1024 * 1024) continue
      const content = await fs.promises.readFile(target, 'utf8').catch(() => '')
      if (/dsk_[A-Za-z0-9_-]{8,}/.test(content)) findings.push(path.relative(runRoot, target))
    }
  }
  return findings
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    usage()
    return
  }

  const results = new Map()
  recordGate(results, 'no-LKG fail-closed', 'NOT-RUN', 'a second isolated Electron run is outside this partial harness')
  recordGate(results, 'prompt and new-session behavior', 'NOT-RUN', 'hard-coded partial-harness exclusion')
  recordGate(results, 'Bundle and Cron operation snapshots', 'NOT-RUN', 'hard-coded partial-harness exclusion')
  recordGate(
    results,
    'Gateway/backend token sentinel scan',
    'NOT-RUN',
    'this partial harness scans only persisted desktop dsk_ tokens'
  )

  let runRoot = null
  let gateway = null
  let electron = null
  let cdp = null
  let electronPid = null
  let backendPid = null
  let backendPort = null
  let gatewayPort = null
  let fatal = null

  try {
    assert.ok(options.gatewayRoot, '--gateway-root is required')
    assert.ok(fs.existsSync(FIXTURE_ROOT), `Canonical fixture not found: ${FIXTURE_ROOT}`)
    const dll = gatewayDll(options.gatewayRoot)
    assert.ok(dll, 'Built Gateway DLL was not found; run dotnet build first')
    const electronExecutable = process.platform === 'win32'
      ? path.join(DESKTOP_APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(DESKTOP_APP_ROOT, 'node_modules', '.bin', 'electron')
    assert.ok(fs.existsSync(electronExecutable), 'Electron dependencies are not installed')
    assert.ok(fs.existsSync(path.join(DESKTOP_APP_ROOT, 'dist', 'index.html')), 'Built Desktop renderer was not found; run npm run build first')
    const python = resolvePython(options.python)
    assert.ok(python, 'No usable Python with Hermes web dependencies was found; pass --python <path>')

    runRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-u5-p2-policy-refresh-'))
    gatewayPort = await reservePort()
    const cdpPort = await reservePort()
    const context = {
      artifactRoot: path.join(runRoot, 'artifacts'),
      catalogRoot: path.join(runRoot, 'catalog'),
      databasePath: path.join(runRoot, 'enterprise-gateway.db'),
      gatewayBaseUrl: `http://127.0.0.1:${gatewayPort}`,
      gatewayDll: dll,
      gatewayRoot: options.gatewayRoot,
      runRoot
    }
    await fs.promises.mkdir(context.catalogRoot, { recursive: true })
    await fs.promises.cp(FIXTURE_ROOT, path.join(context.catalogRoot, FIXTURE_NAME), { recursive: true })

    gateway = await startGateway(context)
    electron = startProcess(
      'electron',
      electronExecutable,
      [`--remote-debugging-port=${cdpPort}`, DESKTOP_APP_ROOT],
      {
        cwd: DESKTOP_APP_ROOT,
        env: {
          HERMES_DESKTOP_CWD: runRoot,
          HERMES_DESKTOP_HERMES_ROOT: DESKTOP_ROOT,
          HERMES_DESKTOP_PYTHON: python,
          HERMES_DESKTOP_USER_DATA_DIR: path.join(runRoot, 'desktop-user-data'),
          HERMES_ENTERPRISE_DESKTOP: '1',
          HERMES_ENTERPRISE_GATEWAY_URL: context.gatewayBaseUrl,
          HERMES_HOME: path.join(runRoot, 'bootstrap-hermes-home')
        },
        logPath: path.join(runRoot, 'desktop-launcher.log')
      }
    )
    electronPid = electron.child.pid
    const target = await waitForCdpTarget(cdpPort)
    cdp = await connectCdp(target.webSocketDebuggerUrl)
    await waitForRendererBridge(cdp)
    recordGate(results, 'real Gateway and built Electron startup', 'PASS', `Gateway and Electron PID ${electronPid} became ready`)

    await evaluate(
      cdp,
      `(async () => window.hermesDesktop.enterprise.login(${JSON.stringify({ username: 'view', password: DEFAULT_PASSWORD })}))()`
    )
    const connection = await evaluate(cdp, '(async () => window.hermesDesktop.getConnection())()')
    assert.ok(connection?.baseUrl, 'getConnection did not return a backend baseUrl')
    backendPort = portFromBaseUrl(connection.baseUrl)
    const backendDeadline = Date.now() + 15000
    while (!backendPid && Date.now() < backendDeadline) {
      backendPid = listeningProcessId(backendPort)
      if (!backendPid) await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(backendPid, `Could not resolve the Python backend PID listening on ${backendPort}`)
    recordGate(results, 'renderer login and Python backend connection', 'PASS', `renderer login started backend PID ${backendPid}`)

    const initialState = await evaluate(cdp, '(async () => window.hermesDesktop.enterprise.status())()')
    assert.equal(policyStatus(initialState), 'available', `${FIXTURE_NAME} must start available`)
    assert.ok(initialState.policyHash, 'prepared runtime status did not expose a policy hash')

    await setSkillPolicy(context.gatewayBaseUrl, 'blocked')
    const blockedState = await evaluate(cdp, '(async () => window.hermesDesktop.enterprise.refreshPolicy())()')
    assert.equal(blockedState.policyRefreshStatus, 'current')
    assert.equal(blockedState.policyStale, false)
    assert.equal(policyStatus(blockedState), 'blocked')
    assert.notEqual(blockedState.policyHash, initialState.policyHash, 'policy hash must change after available-to-blocked update')
    recordGate(
      results,
      'available-to-blocked policy hash refresh',
      'PASS',
      `${initialState.policyHash} -> ${blockedState.policyHash}`
    )

    assert.equal(electron.child.pid, electronPid, 'Electron PID changed during policy refresh')
    assert.equal(electron.child.exitCode, null, 'Electron exited during policy refresh')
    assert.equal(listeningProcessId(backendPort), backendPid, 'Python backend PID changed during policy refresh')

    await stopProcess(gateway)
    gateway = null
    await waitForPortClosed(gatewayPort, 'Gateway')
    const staleState = await evaluate(cdp, '(async () => window.hermesDesktop.enterprise.refreshPolicy())()')
    assert.equal(staleState.policyRefreshStatus, 'stale')
    assert.equal(staleState.policyStale, true)
    assert.equal(staleState.policyHash, blockedState.policyHash)
    assert.equal(policyStatus(staleState), 'blocked')
    assert.match(staleState.policyRefreshError || '', /failed/i)
    recordGate(results, 'Gateway-down stale last-known-good refresh', 'PASS', 'blocked policy hash was retained and marked stale')

    assert.equal(electron.child.pid, electronPid, 'Electron PID changed after Gateway-down refresh')
    assert.equal(electron.child.exitCode, null, 'Electron exited after Gateway-down refresh')
    assert.equal(listeningProcessId(backendPort), backendPid, 'Python backend PID changed after Gateway-down refresh')
    recordGate(results, 'Electron and backend PID stability', 'PASS', `Electron ${electronPid}; Python ${backendPid}`)
  } catch (error) {
    fatal = error
    const firstUnrecorded = GATES.find(gate => !results.has(gate) && ![
      'desktop-token-only artifact scan',
      'cleanup'
    ].includes(gate))
    if (firstUnrecorded) recordGate(results, firstUnrecorded, 'FAIL', error.message)
  } finally {
    if (cdp) {
      try {
        cdp.close()
      } catch {
        // The renderer may already be gone.
      }
    }
    let cleanupError = null
    try {
      await stopProcess(electron, true)
      await stopProcess(gateway)
      if (backendPort) await waitForPortClosed(backendPort, 'Python backend')
      if (gatewayPort) await waitForPortClosed(gatewayPort, 'Gateway')
    } catch (error) {
      cleanupError = error
      fatal ||= error
    }

    if (runRoot) {
      try {
        const findings = await scanTokenArtifacts(runRoot)
        if (findings.length) {
          recordGate(results, 'desktop-token-only artifact scan', 'FAIL', `dsk_ token-shaped value found in ${findings.join(', ')}`)
          fatal ||= new Error('Desktop token leaked to isolated text artifacts')
        } else {
          recordGate(
            results,
            'desktop-token-only artifact scan',
            'PASS',
            'no persisted dsk_ desktop token found in isolated text artifacts'
          )
        }
      } catch (error) {
        recordGate(results, 'desktop-token-only artifact scan', 'FAIL', error.message)
        fatal ||= error
      }
    } else {
      recordGate(results, 'desktop-token-only artifact scan', 'NOT-RUN', 'isolated run directory was not created')
    }

    try {
      const lingering = [electronPid, backendPid].filter(processExists)
      if (runRoot && process.env.U5_P2_KEEP_TEMP !== '1') {
        await fs.promises.rm(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
      }
      if (cleanupError) throw cleanupError
      assert.deepEqual(lingering, [], `processes still running: ${lingering.join(', ')}`)
      recordGate(
        results,
        'cleanup',
        'PASS',
        process.env.U5_P2_KEEP_TEMP === '1' && runRoot
          ? `processes stopped; kept ${runRoot}`
          : runRoot
            ? 'isolated processes stopped and state removed'
            : 'no isolated processes or state were created'
      )
    } catch (error) {
      recordGate(results, 'cleanup', 'FAIL', error.message)
      fatal ||= error
    }
  }

  printResults(results)
  if (fatal || [...results.values()].some(result => result.status === 'FAIL')) process.exitCode = 1
}

main().catch(error => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
