#!/usr/bin/env node

/**
 * Real-process U5 P1 acceptance harness.
 *
 * Starts an isolated Enterprise Gateway and Hermes dashboard backend, then
 * drives the production Electron Skill Hub transport module through catalog
 * discovery, verified download, local installation, process restart, original
 * Hermes skill discovery, and gateway unpublication.
 *
 * Usage:
 *   node scripts/e2e-enterprise-skill-hub.cjs --gateway-root <path>
 *
 * Optional environment:
 *   PYTHON=<python executable>
 *   DOTNET=<dotnet executable>
 *   U5_E2E_KEEP_TEMP=1
 *   U5_E2E_VERBOSE=1
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const { createEnterpriseGatewayClient } = require('../apps/desktop/electron/enterprise-gateway-client.cjs')
const { createEnterpriseSkillHub } = require('../apps/desktop/electron/enterprise-skill-hub.cjs')
const { writeManagedRuntimeHome } = require('../apps/desktop/electron/enterprise-runtime-home.cjs')
const { extractModelProfilesResponse } = require('../apps/desktop/electron/enterprise-runtime.cjs')

const DESKTOP_ROOT = path.resolve(__dirname, '..')
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

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--gateway-root') {
      options.gatewayRoot = path.resolve(argv[++index] || '')
    } else if (value === '--help' || value === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${value}`)
    }
  }
  return options
}

function usage() {
  console.log('Usage: node scripts/e2e-enterprise-skill-hub.cjs --gateway-root <path>')
}

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = address.port
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  return port
}

function lineBuffer(label, stream) {
  let pending = ''
  const lines = []
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    pending += chunk
    const parts = pending.split(/\r?\n/)
    pending = parts.pop() || ''
    for (const line of parts) {
      if (!line) continue
      lines.push(line)
      if (lines.length > 160) lines.shift()
      if (process.env.U5_E2E_VERBOSE === '1') console.log(`[${label}] ${line}`)
    }
  })
  return () => [...lines, ...(pending ? [pending] : [])].join('\n')
}

function startProcess(label, command, args, { cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const stdout = lineBuffer(label, child.stdout)
  const stderr = lineBuffer(label, child.stderr)
  child.once('error', error => {
    error.message = `${label} failed to start: ${error.message}`
  })
  return { child, label, stderr, stdout }
}

async function stopProcess(processInfo) {
  if (!processInfo || processInfo.child.exitCode != null) return
  const { child } = processInfo
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill()
  await Promise.race([
    exited,
    new Promise(resolve => setTimeout(resolve, 5000))
  ])
  if (child.exitCode == null) {
    child.kill('SIGKILL')
    await Promise.race([
      exited,
      new Promise(resolve => setTimeout(resolve, 5000))
    ])
  }
}

function processFailure(processInfo) {
  return [
    `${processInfo.label} exited before becoming ready (code=${processInfo.child.exitCode}, signal=${processInfo.child.signalCode}).`,
    processInfo.stdout(),
    processInfo.stderr()
  ].filter(Boolean).join('\n')
}

async function waitUntilReady(processInfo, probe, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode != null) throw new Error(processFailure(processInfo))
    try {
      if (await probe()) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(
    `Timed out waiting for ${processInfo.label}: ${lastError?.message || 'no successful readiness response'}\n` +
    `${processInfo.stdout()}\n${processInfo.stderr()}`
  )
}

async function startGateway({ gatewayRoot, stateRoot, catalogRoot, artifactRoot, port }) {
  const project = path.join(gatewayRoot, 'EnterpriseGateway.Api', 'EnterpriseGateway.Api.csproj')
  assert.ok(fs.existsSync(project), `Gateway project not found: ${project}`)
  const buildRoot = path.join(gatewayRoot, 'EnterpriseGateway.Api', 'bin', 'Debug')
  const targetFrameworks = fs.existsSync(buildRoot)
    ? fs.readdirSync(buildRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    : []
  const gatewayDll = targetFrameworks
    .map(target => path.join(buildRoot, target, 'EnterpriseGateway.Api.dll'))
    .find(candidate => fs.existsSync(candidate))
  assert.ok(gatewayDll, `Built Gateway DLL not found below ${buildRoot}; run dotnet build first.`)
  const processInfo = startProcess(
    'gateway',
    process.env.DOTNET || 'dotnet',
    [gatewayDll],
    {
      cwd: path.dirname(project),
      env: {
        ASPNETCORE_ENVIRONMENT: 'Development',
        'ConnectionStrings__EnterpriseGateway': `Data Source=${path.join(stateRoot, 'enterprise-gateway.db')}`,
        'Kestrel__Endpoints__http__Url': `http://127.0.0.1:${port}`,
        'SkillHub__ArtifactRoot': artifactRoot,
        'SkillHub__CatalogRoot': catalogRoot,
        'SkillHub__Enabled': 'true'
      }
    }
  )
  const baseUrl = `http://127.0.0.1:${port}`
  await waitUntilReady(processInfo, async () => {
    const response = await fetch(`${baseUrl}/api/desktop/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'view', password: 'ChangeMe!12345' })
    })
    return response.ok
  })
  return { ...processInfo, baseUrl }
}

async function startBackend({ home, port, sessionToken }) {
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const processInfo = startProcess(
    'desktop-backend',
    python,
    [
      '-c',
      `from hermes_cli.web_server import start_server; start_server(host='127.0.0.1', port=${port}, open_browser=False)`
    ],
    {
      cwd: DESKTOP_ROOT,
      env: {
        HERMES_DASHBOARD_SESSION_TOKEN: sessionToken,
        HERMES_DESKTOP: '1',
        HERMES_ENTERPRISE_MANAGED: '1',
        HERMES_ENTERPRISE_TOOL_POLICY_FILE: path.join(home, 'enterprise-policy.json'),
        HERMES_HOME: home,
        PYTHONIOENCODING: 'utf-8'
      }
    }
  )
  const baseUrl = `http://127.0.0.1:${port}`
  await waitUntilReady(processInfo, async () => {
    const response = await fetch(`${baseUrl}/api/skills/enterprise/installed`, {
      headers: { 'X-Hermes-Session-Token': sessionToken }
    })
    return response.ok
  })
  return { ...processInfo, baseUrl, sessionToken }
}

function createHub(gatewayBaseUrl, backend, desktopToken) {
  const client = createEnterpriseGatewayClient({ baseUrl: gatewayBaseUrl })
  const authStore = { readSession: () => ({ desktopToken }) }
  return createEnterpriseSkillHub({
    authStore,
    client,
    localConnection: async () => ({ baseUrl: backend.baseUrl, token: backend.sessionToken })
  })
}

async function login(gatewayBaseUrl) {
  const client = createEnterpriseGatewayClient({ baseUrl: gatewayBaseUrl })
  const session = await client.login({ username: 'view', password: 'ChangeMe!12345' })
  assert.match(session.desktopToken, /^dsk_/, 'Gateway must issue a desktop-only dsk_ token')
  return session.desktopToken
}

async function writeRealManagedRuntimeHome(gatewayBaseUrl, home, desktopToken) {
  const client = createEnterpriseGatewayClient({ baseUrl: gatewayBaseUrl })
  const [bootstrap, modelProfilesPayload] = await Promise.all([
    client.bootstrap(desktopToken),
    client.modelProfiles(desktopToken)
  ])
  const modelProfiles = extractModelProfilesResponse(modelProfilesPayload)
  const manifest = await client.runtimeManifest(desktopToken, {})
  const launch = writeManagedRuntimeHome({ bootstrap, hermesHome: home, manifest, modelProfiles })
  const policy = JSON.parse(await fs.promises.readFile(launch.policyPath, 'utf8'))
  const roleCapabilities = (Array.isArray(policy.role) ? policy.role : [policy.role])
    .filter(Boolean)
    .flatMap(role => Array.isArray(role.capabilities) ? role.capabilities : [])

  assert.equal(policy.capabilities?.['skills.manage'], undefined, 'model capabilities must not fake a role grant')
  assert.ok(roleCapabilities.includes('skills.manage'), 'Gateway role grant must survive Desktop policy serialization')
  assert.equal(policy.toolPolicySnapshot?.skills?.find(item => item.key === FIXTURE_NAME)?.status, 'available')
  return launch
}

function verifyOriginalHermesLoader(home) {
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const script = [
    'from tools.skills_tool import skills_list, skill_view',
    `listing = skills_list()`,
    `assert ${JSON.stringify(FIXTURE_NAME)} in listing, listing`,
    `main = skill_view(${JSON.stringify(FIXTURE_NAME)})`,
    `assert ${JSON.stringify('Review employee expenses against company policy.')} in main, main`,
    `linked = skill_view(${JSON.stringify(FIXTURE_NAME)}, ${JSON.stringify('references/checklist.md')})`,
    `assert ${JSON.stringify('checklist')} in linked.lower(), linked`,
    `print('original-loader-visible:${FIXTURE_NAME}')`
  ].join('; ')
  const result = spawnSync(python, ['-c', script], {
    cwd: DESKTOP_ROOT,
    encoding: 'utf8',
    env: { ...process.env, HERMES_HOME: home, PYTHONIOENCODING: 'utf-8' },
    windowsHide: true
  })
  if (result.status !== 0) {
    throw new Error(`Original Hermes loader verification failed.\n${result.stdout}\n${result.stderr}`)
  }
  assert.match(result.stdout, /original-loader-visible:expense-review/)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    usage()
    return
  }
  assert.ok(options.gatewayRoot, '--gateway-root is required')
  assert.ok(fs.existsSync(FIXTURE_ROOT), `Canonical fixture not found: ${FIXTURE_ROOT}`)

  const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-u5-p1-e2e-'))
  const catalogRoot = path.join(stateRoot, 'catalog')
  const artifactRoot = path.join(stateRoot, 'artifacts')
  const home = path.join(stateRoot, 'hermes-home')
  const sessionToken = `local_${crypto.randomBytes(24).toString('hex')}`
  const gatewayPort = await reservePort()
  const backendPort = await reservePort()
  let gateway = null
  let backend = null

  try {
    await fs.promises.mkdir(catalogRoot, { recursive: true })
    await fs.promises.cp(FIXTURE_ROOT, path.join(catalogRoot, FIXTURE_NAME), { recursive: true })

    gateway = await startGateway({ gatewayRoot: options.gatewayRoot, stateRoot, catalogRoot, artifactRoot, port: gatewayPort })
    const desktopToken = await login(gateway.baseUrl)
    await writeRealManagedRuntimeHome(gateway.baseUrl, home, desktopToken)
    backend = await startBackend({ home, port: backendPort, sessionToken })
    let hub = createHub(gateway.baseUrl, backend, desktopToken)

    const catalog = await hub.list({ page: 1, pageSize: 20 })
    assert.equal(catalog.total, 1)
    assert.equal(catalog.items[0].key, FIXTURE_NAME)
    assert.equal(catalog.items[0].installState, 'not-installed')
    const revision = catalog.items[0].currentRevision
    console.log('PASS discovery: real Gateway catalog and local Backend state were combined')

    await assert.rejects(
      hub.install({ key: FIXTURE_NAME, revision: revision + 1 }),
      error => error?.code === 'package_revision_changed' && error?.status === 409
    )
    const installed = await hub.install({ key: FIXTURE_NAME, revision })
    assert.equal(installed.installed.key, FIXTURE_NAME)
    assert.equal(installed.item.installState, 'installed')
    const idempotent = await hub.install({ key: FIXTURE_NAME, revision })
    assert.deepEqual(idempotent.installed, installed.installed)
    console.log('PASS install: production Electron transport streamed, verified, and installed the package idempotently')

    const target = path.join(home, 'skills', 'enterprise', FIXTURE_NAME)
    const lockPath = path.join(home, 'skills', '.hub', 'lock.json')
    assert.ok(fs.existsSync(path.join(target, 'SKILL.md')))
    assert.ok(fs.existsSync(path.join(target, 'references', 'checklist.md')))
    const lock = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'))
    assert.equal(lock.installed[FIXTURE_NAME].source, 'enterprise')
    assert.equal(lock.installed[FIXTURE_NAME].metadata.enterprise_revision, revision)
    verifyOriginalHermesLoader(home)
    console.log('PASS compatibility: standard Hermes lock plus skills_list/skill_view can see the installed skill and linked file')

    await stopProcess(backend)
    backend = null
    await stopProcess(gateway)
    gateway = null

    gateway = await startGateway({ gatewayRoot: options.gatewayRoot, stateRoot, catalogRoot, artifactRoot, port: gatewayPort })
    const restartedDesktopToken = await login(gateway.baseUrl)
    await writeRealManagedRuntimeHome(gateway.baseUrl, home, restartedDesktopToken)
    backend = await startBackend({ home, port: backendPort, sessionToken })
    hub = createHub(gateway.baseUrl, backend, restartedDesktopToken)
    const afterRestart = await hub.detail(FIXTURE_NAME)
    assert.equal(afterRestart.installState, 'installed')
    assert.equal(afterRestart.installedRevision, revision)
    console.log('PASS restart: Gateway publication and local installation survived independent process restarts')

    await stopProcess(gateway)
    gateway = null
    await fs.promises.rm(path.join(catalogRoot, FIXTURE_NAME), { recursive: true, force: true })
    gateway = await startGateway({ gatewayRoot: options.gatewayRoot, stateRoot, catalogRoot, artifactRoot, port: gatewayPort })
    hub = createHub(gateway.baseUrl, backend, await login(gateway.baseUrl))
    const unpublishedCatalog = await hub.list({ page: 1, pageSize: 20 })
    assert.equal(unpublishedCatalog.total, 0)
    const retainedInstall = await hub.getInstalled()
    assert.equal(retainedInstall.length, 1)
    assert.equal(retainedInstall[0].key, FIXTURE_NAME)
    console.log('PASS unpublish: discovery hid the removed catalog item without deleting the local installation')

    console.log(JSON.stringify({
      ok: true,
      acceptance: 'U5-P1-cross-process',
      gatewayRestarted: true,
      backendRestarted: true,
      installedPath: target,
      lockPath,
      originalLoaderVisible: true,
      unpublishRetainsInstall: true
    }, null, 2))
  } finally {
    await stopProcess(backend)
    await stopProcess(gateway)
    if (process.env.U5_E2E_KEEP_TEMP === '1') {
      console.log(`Kept U5 E2E state: ${stateRoot}`)
    } else {
      await fs.promises.rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
    }
  }
}

main().catch(error => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
