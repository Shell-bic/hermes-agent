#!/usr/bin/env node

/**
 * Interactive Windows acceptance environment for U5 P1 Enterprise Skill Hub.
 *
 * This launcher owns only isolated test processes and state. It starts the
 * real Gateway, launches the real Desktop development app with a test-only
 * userData/HERMES_HOME, and exposes single-key controls for the policy,
 * conflict, revision, and unpublication acceptance cases.
 *
 * Usage:
 *   node scripts/manual-enterprise-skill-hub-acceptance.cjs --gateway-root <path>
 *   node scripts/manual-enterprise-skill-hub-acceptance.cjs --gateway-root <path> --doctor
 *   node scripts/manual-enterprise-skill-hub-acceptance.cjs --gateway-root <path> --control-smoke
 *
 * Optional:
 *   --python <path>       Python 3.11-3.13 with Hermes web dependencies
 *   --keep-state         Keep the isolated run directory after exit
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
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
const DEFAULT_DESKTOP_USER = 'view'
const DEFAULT_PASSWORD = 'ChangeMe!12345'

function parseArguments(argv) {
  const options = { controlSmoke: false, doctor: false, keepState: false, python: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--gateway-root') options.gatewayRoot = path.resolve(argv[++index] || '')
    else if (value === '--python') options.python = path.resolve(argv[++index] || '')
    else if (value === '--doctor') options.doctor = true
    else if (value === '--control-smoke') options.controlSmoke = true
    else if (value === '--keep-state') options.keepState = true
    else if (value === '--help' || value === '-h') options.help = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  return options
}

function usage() {
  console.log(
    'Usage: node scripts/manual-enterprise-skill-hub-acceptance.cjs ' +
      '--gateway-root <path> [--python <path>] [--doctor|--control-smoke] [--keep-state]'
  )
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
        'print("u5-python-ready")'
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
  return result.status === 0 && result.stdout.includes('u5-python-ready')
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

async function isPortAvailable(port) {
  return await new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
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

function startProcess(label, command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    windowsHide: options.windowsHide !== false
  })
  let tail = ''
  for (const stream of [child.stdout, child.stderr].filter(Boolean)) {
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      tail = (tail + chunk).slice(-16000)
      if (options.logPath) fs.appendFileSync(options.logPath, chunk, 'utf8')
      if (options.echo) process.stdout.write(`[${label}] ${chunk}`)
    })
  }
  child.once('error', error => {
    tail = (tail + `\n${error.stack || error.message}`).slice(-16000)
    console.error(`${label} process error: ${error.message}`)
  })
  return { child, label, tail: () => tail }
}

async function stopProcess(info, tree = false) {
  if (!info || info.child.exitCode != null) return
  const exited = new Promise(resolve => info.child.once('exit', resolve))
  if (tree && process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(info.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    info.child.kill()
  }
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 7000))])
  if (info.child.exitCode == null) info.child.kill('SIGKILL')
}

async function waitForGateway(info, baseUrl, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (info.child.exitCode != null) {
      throw new Error(`Gateway exited before readiness.\n${info.tail()}`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/desktop/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: DEFAULT_DESKTOP_USER, password: DEFAULT_PASSWORD })
      })
      if (response.ok) return
    } catch {
      // Retry while Kestrel and SQLite initialize.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for Gateway.\n${info.tail()}`)
}

function gatewayEnvironment({ artifactRoot, catalogRoot, databasePath, port }) {
  return {
    ASPNETCORE_ENVIRONMENT: 'Development',
    'ConnectionStrings__EnterpriseGateway': `Data Source=${databasePath}`,
    'Gateway__PublicBaseUrl': `http://127.0.0.1:${port}/v1`,
    'Kestrel__Endpoints__http__Url': `http://127.0.0.1:${port}`,
    'SkillHub__ArtifactRoot': artifactRoot,
    'SkillHub__CatalogRoot': catalogRoot,
    'SkillHub__Enabled': 'true'
  }
}

async function startGateway(context) {
  const info = startProcess('gateway', process.env.DOTNET || 'dotnet', [context.gatewayDll], {
    cwd: path.join(context.gatewayRoot, 'EnterpriseGateway.Api'),
    env: gatewayEnvironment(context),
    echo: process.env.U5_MANUAL_VERBOSE === '1',
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
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${response.status} ${payload?.detail || payload?.message || text}`)
  return payload
}

async function adminToken(baseUrl) {
  const payload = await jsonRequest(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    body: { username: 'admin', password: DEFAULT_PASSWORD }
  })
  return payload.token
}

async function desktopToken(baseUrl) {
  const payload = await jsonRequest(`${baseUrl}/api/desktop/auth/login`, {
    method: 'POST',
    body: { username: DEFAULT_DESKTOP_USER, password: DEFAULT_PASSWORD }
  })
  return payload.token
}

async function catalogPage(baseUrl) {
  const token = await desktopToken(baseUrl)
  return jsonRequest(`${baseUrl}/api/desktop/skill-hub/skills?page=1&pageSize=20`, { token })
}

async function setSkillPolicy(baseUrl, status) {
  const token = await adminToken(baseUrl)
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
        reason: status === 'blocked' ? 'U5 manual acceptance policy block' : 'U5 manual acceptance available'
      }]
    }
  })
}

async function findManagedHome(userDataRoot, timeoutMs = 20000) {
  const usersRoot = path.join(userDataRoot, 'enterprise', 'users')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(usersRoot)) {
      const entry = (await fs.promises.readdir(usersRoot, { withFileTypes: true })).find(item => item.isDirectory())
      if (entry) return path.join(usersRoot, entry.name, 'hermes-home')
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Managed HERMES_HOME is not available yet. Sign in to the Desktop first.')
}

async function toggleConflict(userDataRoot) {
  const home = await findManagedHome(userDataRoot)
  const conflictRoot = path.join(home, 'skills', 'manual-conflict')
  if (fs.existsSync(conflictRoot)) {
    await fs.promises.rm(conflictRoot, { recursive: true, force: true })
    return { created: false, path: conflictRoot }
  }
  await fs.promises.mkdir(conflictRoot, { recursive: true })
  await fs.promises.writeFile(
    path.join(conflictRoot, 'SKILL.md'),
    `---\nname: ${FIXTURE_NAME}\ndescription: Intentional U5 acceptance conflict.\n---\n\n# Conflict fixture\n`,
    'utf8'
  )
  return { created: true, path: conflictRoot }
}

function instructions(context) {
  return `# U5 P1 manual acceptance run

Run root: ${context.runRoot}
Gateway: ${context.gatewayBaseUrl}
Desktop userData: ${context.userDataRoot}

Test login:
- Username: ${DEFAULT_DESKTOP_USER}
- Password: ${DEFAULT_PASSWORD}

Desktop procedure:
1. Sign in, open Skills, then open Enterprise Discovery.
2. Search for "${FIXTURE_NAME}" and inspect its description, category, version, file count and policy state.
3. Before installing, press c in the launcher terminal; installation must fail with a name conflict and the conflict file must remain unchanged. Press c again to remove it.
4. Press b; refresh Enterprise Discovery and confirm the policy reason plus disabled/rejected install. Press a and refresh to restore availability.
5. Install the skill. Confirm installed state, then inspect:
   <managed HERMES_HOME>/skills/enterprise/${FIXTURE_NAME}/
   <managed HERMES_HOME>/skills/.hub/lock.json
6. Start a new chat/session and explicitly load ${FIXTURE_NAME} plus references/checklist.md.
7. Press n to publish revision 2; refresh and confirm "update not supported" without overwriting revision 1.
8. Press u to unpublish; refresh and confirm it disappears while the local installation remains. Press p to republish.
9. Return to the original local/public Hub tabs and confirm their existing discovery/management surfaces still work.
10. Inspect desktop.log, gateway.log and lock.json: no dsk_ token may appear. The launcher also scans these text artifacts on exit without printing any matched token.

Launcher controls:
- c: create/remove a local same-name conflict
- b: set U4 skill status to blocked
- a: set U4 skill status to available
- n: publish changed content as the next revision and restart Gateway
- u: remove the catalog item and restart Gateway
- p: restore the original catalog item and restart Gateway
- h: print controls
- q: quit and clean isolated processes/state (unless --keep-state)
`
}

function printControls() {
  console.log('\nControls: [c] conflict  [b] blocked  [a] available  [n] next revision  [u] unpublish  [p] republish  [h] help  [q] quit\n')
}

async function scanDesktopTokenArtifacts(runRoot) {
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
  const report = { checkedAt: new Date().toISOString(), findings, ok: findings.length === 0 }
  await fs.promises.writeFile(path.join(runRoot, 'TOKEN-SCAN.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log(report.ok
    ? 'PASS token artifact scan: no dsk_ value found in isolated text logs/config/lock files.'
    : `FAIL token artifact scan: token-shaped value found in ${findings.join(', ')}`)
  return report
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    usage()
    return
  }
  assert.ok(options.gatewayRoot, '--gateway-root is required')
  assert.ok(fs.existsSync(FIXTURE_ROOT), `Canonical fixture not found: ${FIXTURE_ROOT}`)
  assert.ok(fs.existsSync(path.join(DESKTOP_APP_ROOT, 'node_modules', 'electron')), 'Desktop dependencies are not installed')
  const dll = gatewayDll(options.gatewayRoot)
  assert.ok(dll, 'Built Gateway DLL was not found; run dotnet build first')
  const python = resolvePython(options.python)
  assert.ok(python, 'No usable Python with Hermes web and agent dependencies was found; pass --python <path>')
  assert.equal(await isPortAvailable(5174), true, 'Desktop Vite port 5174 is already in use')

  console.log(JSON.stringify({
    ok: true,
    desktopRoot: DESKTOP_ROOT,
    fixtureRoot: FIXTURE_ROOT,
    gatewayDll: dll,
    python,
    vitePortAvailable: true
  }, null, 2))
  if (options.doctor) return

  const runRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-u5-p1-manual-'))
  const context = {
    artifactRoot: path.join(runRoot, 'artifacts'),
    catalogRoot: path.join(runRoot, 'catalog'),
    databasePath: path.join(runRoot, 'enterprise-gateway.db'),
    gatewayBaseUrl: '',
    gatewayDll: dll,
    gatewayRoot: options.gatewayRoot,
    python,
    runRoot,
    userDataRoot: path.join(runRoot, 'desktop-user-data')
  }
  const port = await reservePort()
  context.port = port
  context.gatewayBaseUrl = `http://127.0.0.1:${port}`
  const catalogSkillRoot = path.join(context.catalogRoot, FIXTURE_NAME)
  await fs.promises.mkdir(context.catalogRoot, { recursive: true })
  await fs.promises.cp(FIXTURE_ROOT, catalogSkillRoot, { recursive: true })
  await fs.promises.writeFile(path.join(runRoot, 'MANUAL-ACCEPTANCE.md'), instructions(context), 'utf8')

  let gateway = null
  let desktop = null
  let stopping = false
  const restartGateway = async () => {
    await stopProcess(gateway)
    gateway = await startGateway(context)
  }
  const stopAll = async () => {
    if (stopping) return
    stopping = true
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false)
      } catch {
        // The terminal may already be detached because the Desktop closed.
      }
    }
    await stopProcess(desktop, true)
    await stopProcess(gateway)
    await scanDesktopTokenArtifacts(runRoot)
    if (options.keepState) console.log(`Kept isolated acceptance state: ${runRoot}`)
    else await fs.promises.rm(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }

  try {
    gateway = await startGateway(context)
    if (options.controlSmoke) {
      let page = await catalogPage(context.gatewayBaseUrl)
      assert.equal(page.total, 1)
      assert.equal(page.items[0].currentRevision, 1)

      await setSkillPolicy(context.gatewayBaseUrl, 'blocked')
      page = await catalogPage(context.gatewayBaseUrl)
      assert.equal(page.items[0].policyStatus, 'blocked')
      await setSkillPolicy(context.gatewayBaseUrl, 'available')
      page = await catalogPage(context.gatewayBaseUrl)
      assert.equal(page.items[0].policyStatus, 'available')

      await fs.promises.appendFile(path.join(catalogSkillRoot, 'SKILL.md'), '\nControl smoke revision 2.\n', 'utf8')
      await restartGateway()
      page = await catalogPage(context.gatewayBaseUrl)
      assert.equal(page.items[0].currentRevision, 2)

      await fs.promises.rm(catalogSkillRoot, { recursive: true, force: true })
      await restartGateway()
      page = await catalogPage(context.gatewayBaseUrl)
      assert.equal(page.total, 0)
      console.log(JSON.stringify({
        ok: true,
        acceptance: 'U5-P1-manual-controls-smoke',
        availableBlockedRoundTrip: true,
        nextRevision: 2,
        unpublish: true
      }, null, 2))
      return
    }
    const desktopCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm'
    const desktopArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run dev'] : ['run', 'dev']
    desktop = startProcess('desktop', desktopCommand, desktopArgs, {
      cwd: DESKTOP_APP_ROOT,
      env: {
        HERMES_DESKTOP_CWD: runRoot,
        HERMES_DESKTOP_HERMES_ROOT: DESKTOP_ROOT,
        HERMES_DESKTOP_PYTHON: python,
        HERMES_DESKTOP_USER_DATA_DIR: context.userDataRoot,
        HERMES_ENTERPRISE_DESKTOP: '1',
        HERMES_ENTERPRISE_GATEWAY_URL: context.gatewayBaseUrl,
        HERMES_HOME: path.join(runRoot, 'bootstrap-hermes-home')
      },
      echo: true,
      logPath: path.join(runRoot, 'desktop-launcher.log'),
      windowsHide: false
    })
    desktop.child.once('exit', () => {
      if (!stopping) stopAll().then(() => process.exit(0), error => {
        console.error(error)
        process.exit(1)
      })
    })

    console.log(`\nAcceptance instructions: ${path.join(runRoot, 'MANUAL-ACCEPTANCE.md')}`)
    console.log(`Gateway: ${context.gatewayBaseUrl}`)
    console.log(`Login: ${DEFAULT_DESKTOP_USER} / ${DEFAULT_PASSWORD}`)
    printControls()

    if (!process.stdin.isTTY) throw new Error('Interactive acceptance requires a TTY')
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    let commandInFlight = false
    process.stdin.on('data', async key => {
      if (commandInFlight || stopping) return
      commandInFlight = true
      try {
        if (key === 'q' || key === '\u0003') {
          await stopAll()
          process.exit(0)
        } else if (key === 'h') printControls()
        else if (key === 'b' || key === 'a') {
          const status = key === 'b' ? 'blocked' : 'available'
          await setSkillPolicy(context.gatewayBaseUrl, status)
          console.log(`U4 ${FIXTURE_NAME} status is now ${status}; refresh Enterprise Discovery.`)
        } else if (key === 'c') {
          const result = await toggleConflict(context.userDataRoot)
          console.log(`${result.created ? 'Created' : 'Removed'} same-name conflict: ${result.path}`)
        } else if (key === 'u') {
          await fs.promises.rm(catalogSkillRoot, { recursive: true, force: true })
          await restartGateway()
          console.log('Catalog item unpublished; refresh Enterprise Discovery and verify the local install remains.')
        } else if (key === 'p') {
          await fs.promises.rm(catalogSkillRoot, { recursive: true, force: true })
          await fs.promises.cp(FIXTURE_ROOT, catalogSkillRoot, { recursive: true })
          await restartGateway()
          console.log('Original catalog item republished; refresh Enterprise Discovery.')
        } else if (key === 'n') {
          await fs.promises.mkdir(catalogSkillRoot, { recursive: true })
          if (!fs.existsSync(path.join(catalogSkillRoot, 'SKILL.md'))) {
            await fs.promises.cp(FIXTURE_ROOT, catalogSkillRoot, { recursive: true })
          }
          await fs.promises.appendFile(
            path.join(catalogSkillRoot, 'SKILL.md'),
            `\nRevision acceptance marker ${new Date().toISOString()}\n`,
            'utf8'
          )
          await restartGateway()
          console.log('Published changed content as the next revision; refresh Enterprise Discovery.')
        }
      } catch (error) {
        console.error(`Control failed: ${error.message}`)
      } finally {
        commandInFlight = false
      }
    })
    await new Promise(() => {})
  } finally {
    await stopAll()
  }
}

main().catch(error => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
