#!/usr/bin/env node

/**
 * U5 P2 strict policy-refresh cross-process acceptance harness (partial).
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
const crypto = require('node:crypto')
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
const FIXTURE_ADMIN = 'u5-p2-admin-fixture'
const FIXTURE_USER = 'u5-p2-view-fixture'
const FIXTURE_PASSWORD = 'U5P2-not-a-real-secret-fixture-only-20260721!'
const GATES = [
  'real Gateway and built Electron startup',
  'renderer login and Python backend connection',
  'available-to-blocked policy hash refresh',
  'invalid-200 terminal blocks runtime without adopting LKG',
  'invalid-200 preserves managed-home evidence bytes',
  'invalid-200 terminal revokes Python backend',
  'same-user 503 adopts stale last-known-good',
  'terminal HTTP status matrix',
  'full bootstrap envelope mutation matrix',
  'cross-user never adopts another user LKG',
  'no-LKG fail-closed',
  'current-session prompt hash remains stable',
  'new-session skill index changes after policy refresh',
  'blocked linked skill read is denied through real tool call',
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
  let complete = true
  for (const gate of GATES) {
    const result = results.get(gate) || { status: 'NOT-RUN', detail: 'blocked by an earlier gate' }
    console.log(`${result.status} ${gate}: ${result.detail}`)
    if (result.status !== 'PASS') complete = false
  }
  console.log(complete ? 'overall=passed' : 'overall=failed')
  return complete
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
    gatewayTokens: new Set(),
    requestJournal: []
  }

  function recordRequest(request, status, source = 'upstream') {
    const authorization = String(request.headers.authorization || '')
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || ''
    let pathname = '<invalid-path>'
    try {
      pathname = new URL(request.url, 'http://fault-proxy.local').pathname
    } catch {
      // Keep the invalid-path sentinel; never record a raw URL or query.
    }
    state.requestJournal.push({
      bearerHash: bearer ? crypto.createHash('sha256').update(bearer).digest('hex').slice(0, 10) : null,
      hasDskBearer: bearer.startsWith('dsk_'),
      method: request.method,
      pathname,
      source,
      status
    })
    if (state.requestJournal.length > 200) state.requestJournal.splice(0, state.requestJournal.length - 200)
    assert.ok(state.requestJournal.length <= 200, 'sanitized request journal exceeded its in-memory bound')
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
        recordRequest(request, 503, 'fault')
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
      recordRequest(request, upstream.status)
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
      recordRequest(request, 502, 'proxy-error')
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
        body: JSON.stringify({ username: FIXTURE_USER, password: FIXTURE_PASSWORD })
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
      'SeedAdmin__Password': FIXTURE_PASSWORD,
      'SeedAdmin__UserName': FIXTURE_ADMIN,
      'SeedDesktopUser__DisplayName': 'U5 P2 View Fixture',
      'SeedDesktopUser__Password': FIXTURE_PASSWORD,
      'SeedDesktopUser__UserName': FIXTURE_USER,
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
    body: { username: FIXTURE_ADMIN, password: FIXTURE_PASSWORD }
  })
  const token = login.token
  const roles = await jsonRequest(`${baseUrl}/api/admin/roles`, { token })
  const role = roles.find(item => item.name === 'default-employee')
  assert.ok(role, 'default-employee role not found')
  const policy = await jsonRequest(`${baseUrl}/api/admin/roles/${role.id}/tool-policy`, { token })
  const skill = policy.skills.find(item => item.key === FIXTURE_NAME)
  assert.ok(skill, `${FIXTURE_NAME} is not in the role policy catalog`)
  assert.ok(String(policy.policyVersion || '').trim(), 'role tool policy response did not include policyVersion')
  const entriesToRequest = (entries, targetId = null) => {
    assert.ok(Array.isArray(entries), 'role tool policy response omitted a resource collection')
    return entries.map(entry => ({
      id: entry.id,
      reason: entry.id === targetId
        ? `U5 P2 acceptance ${status}`
        : entry.hasRoleOverride
          ? String(entry.roleReason || '').trim() || null
          : null,
      status: entry.id === targetId
        ? status
        : entry.hasRoleOverride
          ? entry.roleStatus ?? null
          : null
    }))
  }
  await jsonRequest(`${baseUrl}/api/admin/roles/${role.id}/tool-policy`, {
    method: 'PUT',
    token,
    body: {
      capabilityFlags: entriesToRequest(policy.capabilityFlags),
      expectedPolicyVersion: policy.policyVersion,
      mcpServers: entriesToRequest(policy.mcpServers),
      skills: entriesToRequest(policy.skills, skill.id),
      tools: entriesToRequest(policy.tools),
      toolSets: entriesToRequest(policy.toolSets)
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

async function waitForManagedConnection(cdp, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    const lifecycle = await evaluate(cdp, '(async () => window.hermesDesktop.enterprise.lifecycleStatus())()')
    if (lifecycle?.state === 'blocked' || lifecycle?.state === 'stop_failed') {
      const terminal = await evaluate(
        cdp,
        `(async () => {
          const lifecycle = await window.hermesDesktop.enterprise.lifecycleStatus()
          const state = await window.hermesDesktop.enterprise.status()
          return {
            lifecycle: {
              authEpoch: lifecycle.authEpoch,
              lifecycleEpoch: lifecycle.lifecycleEpoch,
              reasonCode: lifecycle.reasonCode,
              state: lifecycle.state
            },
            publicStatus: state?.status || null,
            terminalError: state?.terminalError ? {
              errorCode: state.terminalError.errorCode || null,
              httpStatus: state.terminalError.httpStatus || state.terminalError.status || null,
              recoveryKind: state.terminalError.recoveryKind || null
            } : null
          }
        })()`
      )
      assert.deepEqual(Object.keys(terminal).sort(), ['lifecycle', 'publicStatus', 'terminalError'])
      assert.deepEqual(
        Object.keys(terminal.lifecycle || {}).sort(),
        ['authEpoch', 'lifecycleEpoch', 'reasonCode', 'state']
      )
      if (terminal.terminalError) {
        assert.deepEqual(
          Object.keys(terminal.terminalError).sort(),
          ['errorCode', 'httpStatus', 'recoveryKind']
        )
      }
      throw new Error(`managed lifecycle terminal before backend connection: ${JSON.stringify(terminal)}`)
    }
    try {
      const connection = await evaluate(cdp, '(async () => window.hermesDesktop.getConnection())()')
      if (connection?.baseUrl) return connection
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for managed backend connection: ${lastError?.message || 'no connection'}`)
}

function policyStatus(state) {
  return state?.toolPolicySnapshot?.skills?.find(item => item.key === FIXTURE_NAME)?.status || null
}

function findManagedHermesHome(userDataRoot) {
  const usersRoot = path.join(userDataRoot, 'enterprise', 'users')
  assert.ok(fs.existsSync(usersRoot), 'managed enterprise users root was not created')
  const homes = fs.readdirSync(usersRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(usersRoot, entry.name, 'hermes-home'))
    .filter(candidate => fs.existsSync(candidate))
  assert.equal(homes.length, 1, `expected exactly one managed Hermes home, found ${homes.length}`)
  return homes[0]
}

function managedHomeEvidence(hermesHome) {
  const evidence = {}
  for (const name of ['.env', 'config.yaml', 'enterprise-policy.json']) {
    const filePath = path.join(hermesHome, name)
    assert.ok(fs.existsSync(filePath), `managed runtime file missing: ${name}`)
    evidence[name] = fs.readFileSync(filePath)
  }
  return evidence
}

function assertManagedHomeEvidenceUnchanged(before, after) {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort())
  for (const name of Object.keys(before)) {
    assert.ok(before[name].equals(after[name]), `${name} changed after invalid-200 terminal refresh`)
  }
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

async function waitForProcessExit(pid, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processExists(pid)) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${label} PID ${pid} remained alive after terminal policy revocation`)
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

async function scanSensitiveArtifacts(runRoot) {
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
      const reasons = []
      if (/dsk_[A-Za-z0-9_-]{8,}/.test(content)) reasons.push('desktop-token')
      if (content.includes(FIXTURE_PASSWORD)) reasons.push('fixture-password')
      if (reasons.length) findings.push(`${path.relative(runRoot, target)} (${reasons.join(',')})`)
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
  recordGate(results, 'terminal HTTP status matrix', 'NOT-RUN', 'not implemented in the first strict-refresh slice')
  recordGate(results, 'full bootstrap envelope mutation matrix', 'NOT-RUN', 'only the first lockedSurfaces mutation runs in this slice')
  recordGate(results, 'cross-user never adopts another user LKG', 'NOT-RUN', 'not implemented in the first strict-refresh slice')
  recordGate(results, 'current-session prompt hash remains stable', 'NOT-RUN', 'not implemented in the first strict-refresh slice')
  recordGate(results, 'new-session skill index changes after policy refresh', 'NOT-RUN', 'not implemented in the first strict-refresh slice')
  recordGate(results, 'blocked linked skill read is denied through real tool call', 'NOT-RUN', 'not implemented in the first strict-refresh slice')
  recordGate(results, 'Bundle and Cron operation snapshots', 'NOT-RUN', 'hard-coded partial-harness exclusion')
  recordGate(
    results,
    'Gateway/backend token sentinel scan',
    'NOT-RUN',
    'this partial harness scans only persisted desktop dsk_ tokens'
  )

  let runRoot = null
  let gateway = null
  let gatewayProxy = null
  let electron = null
  let cdp = null
  let electronPid = null
  let backendPid = null
  let backendPort = null
  let gatewayPort = null
  let gatewayProxyPort = null
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
    gatewayProxy = await startGatewayFaultProxy({ targetBaseUrl: context.gatewayBaseUrl })
    gatewayProxyPort = gatewayProxy.port
    const userDataRoot = path.join(runRoot, 'desktop-user-data')
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
          HERMES_DESKTOP_USER_DATA_DIR: userDataRoot,
          HERMES_ENTERPRISE_DESKTOP: '1',
          HERMES_ENTERPRISE_GATEWAY_URL: gatewayProxy.baseUrl,
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

    const loginMethodsState = await evaluate(cdp, '(async () => window.hermesDesktop.enterprise.loginMethods())()')
    assert.ok(loginMethodsState?.methods?.includes('password'), 'isolated Gateway did not advertise password login')
    assert.equal(loginMethodsState.selectedMethod, 'password')
    assert.equal(loginMethodsState.status, 'password-ready')
    const loginState = await evaluate(
      cdp,
      `(async () => window.hermesDesktop.enterprise.login(${JSON.stringify({ username: FIXTURE_USER, password: FIXTURE_PASSWORD })}))()`
    )
    assert.equal(loginState.authenticated, true)
    assert.equal(loginState.user?.userName, FIXTURE_USER)
    const connection = await waitForManagedConnection(cdp)
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

    assert.equal(electron.child.pid, electronPid, 'Electron PID changed during ordinary policy refresh')
    assert.equal(electron.child.exitCode, null, 'Electron exited during ordinary policy refresh')
    assert.equal(listeningProcessId(backendPort), backendPid, 'Python backend PID changed during ordinary policy refresh')

    const managedHermesHome = findManagedHermesHome(userDataRoot)
    const evidenceBefore = managedHomeEvidence(managedHermesHome)

    gatewayProxy.setBootstrapFault({ kind: 'status-503', marker: 'u5-p2-same-user-503' })
    const staleState = await evaluate(cdp, '(async () => window.hermesDesktop.enterprise.refreshPolicy())()')
    assert.equal(staleState.policyRefreshStatus, 'stale')
    assert.equal(staleState.policyStale, true)
    assert.equal(staleState.policyHash, blockedState.policyHash)
    assert.equal(policyStatus(staleState), 'blocked')
    assert.match(staleState.policyRefreshError || '', /HTTP 503/)
    assertManagedHomeEvidenceUnchanged(evidenceBefore, managedHomeEvidence(managedHermesHome))
    assert.equal(electron.child.pid, electronPid, 'Electron PID changed during same-user 503 LKG refresh')
    assert.equal(electron.child.exitCode, null, 'Electron exited during same-user 503 LKG refresh')
    assert.equal(listeningProcessId(backendPort), backendPid, 'Python backend listener changed during same-user 503 LKG refresh')
    assert.equal(processExists(backendPid), true, 'Python backend process exited during same-user 503 LKG refresh')
    recordGate(
      results,
      'same-user 503 adopts stale last-known-good',
      'PASS',
      `policy ${blockedState.policyHash} and Electron/Python PIDs remained stable`
    )

    gatewayProxy.setBootstrapFault(null)
    gatewayProxy.setBootstrapFault({ kind: 'locked-missing', marker: 'u5-p2-invalid-200-locked-missing' })
    const invalidState = await evaluate(cdp, '(async () => window.hermesDesktop.enterprise.refreshPolicy())()')
    assert.equal(invalidState.status, 'error')
    assert.equal(invalidState.authenticated, true)
    assert.equal(invalidState.policyStale, false)
    assert.equal(invalidState.policyHash, null)
    assert.equal(invalidState.toolPolicySnapshot, null)
    assert.notEqual(invalidState.policyRefreshStatus, 'stale')
    assert.equal(policyStatus(invalidState), null)
    assert.match(invalidState.terminalError?.errorCode || '', /enterprise_policy_payload_invalid/)
    recordGate(
      results,
      'invalid-200 terminal blocks runtime without adopting LKG',
      'PASS',
      'renderer received blocked terminal state with no effective policy snapshot'
    )

    const evidenceAfter = managedHomeEvidence(managedHermesHome)
    assertManagedHomeEvidenceUnchanged(evidenceBefore, evidenceAfter)
    recordGate(
      results,
      'invalid-200 preserves managed-home evidence bytes',
      'PASS',
      '.env, config.yaml, and enterprise-policy.json remained byte-identical for forensic recovery'
    )

    await waitForPortClosed(backendPort, 'Python backend')
    await waitForProcessExit(backendPid, 'Python backend')
    assert.equal(electron.child.exitCode, null, 'Electron exited instead of remaining in managed blocked state')
    recordGate(
      results,
      'invalid-200 terminal revokes Python backend',
      'PASS',
      `Python backend PID ${backendPid} stopped while Electron PID ${electronPid} remained alive`
    )
  } catch (error) {
    fatal = error
    if (gatewayProxy?.state?.requestJournal?.length) {
      assert.ok(gatewayProxy.state.requestJournal.length <= 200, 'sanitized request journal exceeded its in-memory bound')
      console.error(`SANITIZED gateway request journal (last 30): ${JSON.stringify(gatewayProxy.state.requestJournal.slice(-30))}`)
    }
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
      if (gatewayProxy) await gatewayProxy.close()
      if (backendPort) await waitForPortClosed(backendPort, 'Python backend')
      if (gatewayPort) await waitForPortClosed(gatewayPort, 'Gateway')
      if (gatewayProxyPort) await waitForPortClosed(gatewayProxyPort, 'Gateway fault proxy')
    } catch (error) {
      cleanupError = error
      fatal ||= error
    }

    if (runRoot) {
      try {
        const findings = await scanSensitiveArtifacts(runRoot)
        if (findings.length) {
          recordGate(results, 'desktop-token-only artifact scan', 'FAIL', `sensitive fixture value found in ${findings.join(', ')}`)
          fatal ||= new Error('Sensitive fixture value leaked to isolated text artifacts')
        } else {
          recordGate(
            results,
            'desktop-token-only artifact scan',
            'PASS',
            'no persisted dsk_ desktop token or fixture password found in isolated text artifacts'
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

  const complete = printResults(results)
  if (fatal || !complete) process.exitCode = 1
}

main().catch(error => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
