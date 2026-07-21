const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ELECTRON_VERSION = '40.10.2'
const REVIEWED_BUNDLE_BYTES = 13_481
const REVIEWED_BUNDLE_SHA256 = 'c23ec8e6111fa227ee1583bd5737713782d210c37a03ddac08b40303577dc48f'
const required = process.env.PB02_ELECTRON_HOST_SMOKE_REQUIRED === '1'
const retainRoot = process.env.PB02_ELECTRON_HOST_SMOKE_RETAIN_ROOT
const configuredRunId = process.env.PB02_ELECTRON_HOST_SMOKE_RUN_ID
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

function result(kind, fields) {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join(' ')
  const stream = kind === 'FAIL' ? process.stderr : process.stdout
  stream.write(`PB02_ELECTRON_HOST_SMOKE_RESULT=${kind}${suffix ? ` ${suffix}` : ''}\n`)
}

function unavailable(reason) {
  if (required) throw new Error(`required prerequisite unavailable: ${reason}`)
  result('SKIP', { reason })
}

function electronExecutable() {
  if (process.env.PB02_ELECTRON_BINARY) return path.resolve(process.env.PB02_ELECTRON_BINARY)
  const name = process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : 'electron'
  return path.resolve(__dirname, '..', '..', 'node_modules', 'electron', 'dist', name)
}

function verifyReviewedBundle(bundlePath) {
  const bytes = fs.readFileSync(bundlePath)
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== REVIEWED_BUNDLE_BYTES || digest !== REVIEWED_BUNDLE_SHA256) {
    throw new Error('Gateway BotAuthClient bundle does not match the reviewed PB-02 artifact')
  }
}

function exportDevelopmentCertificate(directory, passphrase) {
  const pfxPath = path.join(directory, 'probe.pfx')
  try {
    execFileSync('dotnet', ['dev-certs', 'https', '--check'], { stdio: 'ignore', windowsHide: true })
    execFileSync('dotnet', ['dev-certs', 'https', '--export-path', pfxPath, '--password', passphrase], {
      stdio: 'ignore',
      windowsHide: true
    })
  } catch {
    return null
  }
  return fs.existsSync(pfxPath) ? pfxPath : null
}

function childEnvironment(fields) {
  const allowed = [
    'APPDATA', 'ComSpec', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'PATH',
    'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'ProgramData', 'SystemRoot', 'TEMP',
    'TMP', 'USERPROFILE', 'WINDIR'
  ]
  const environment = {}
  for (const name of allowed) {
    if (process.env[name]) environment[name] = process.env[name]
  }
  return { ...environment, ...fields }
}

function createSandbox() {
  if (!retainRoot) {
    if (configuredRunId) throw new Error('run id is only valid with retained sandbox mode')
    return { retained: false, root: fs.mkdtempSync(path.join(os.tmpdir(), 'pb02-electron-host-smoke-')), runId: crypto.randomUUID() }
  }
  const runId = String(configuredRunId || '').toLowerCase()
  if (!required) throw new Error('retained sandbox mode requires PB02_ELECTRON_HOST_SMOKE_REQUIRED=1')
  if (!RUN_ID_PATTERN.test(runId) || runId !== configuredRunId) {
    throw new Error('retained sandbox mode requires a canonical lowercase PB02_ELECTRON_HOST_SMOKE_RUN_ID')
  }
  const root = path.resolve(retainRoot)
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..')
  const comparedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const comparedRepository = process.platform === 'win32' ? repositoryRoot.toLowerCase() : repositoryRoot
  if (comparedRoot === comparedRepository || comparedRoot.startsWith(`${comparedRepository}${path.sep}`)) {
    throw new Error('retained sandbox must be outside the repository')
  }
  if (fs.existsSync(root)) throw new Error('retained sandbox root must not already exist')
  fs.mkdirSync(root, { recursive: false })
  return { retained: true, root, runId }
}

function writeProducerMarker(root, runId, producerPid) {
  if (!Number.isSafeInteger(producerPid) || producerPid <= 0) throw new Error('Electron producer PID was unavailable')
  const marker = {
    schemaVersion: 'wecom-bot-pilot-producer-marker.v1',
    runId,
    category: 'electron_auth_profile',
    producer: 'electron-auth-probe',
    producerPid,
    quiescent: true,
    finishedAt: new Date().toISOString()
  }
  fs.writeFileSync(path.join(root, '.wecom-pb02-producer.json'), `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  })
}

function main() {
  const binary = electronExecutable()
  if (!fs.existsSync(binary)) {
    unavailable('electron_binary_missing')
    return
  }

  const electronPackage = path.resolve(__dirname, '..', '..', 'node_modules', 'electron', 'package.json')
  if (!fs.existsSync(electronPackage) || JSON.parse(fs.readFileSync(electronPackage, 'utf8')).version !== ELECTRON_VERSION) {
    throw new Error(`Electron dependency must be exactly ${ELECTRON_VERSION}`)
  }

  const configuredBundle = process.env.PB02_GATEWAY_BUNDLE
  if (!configuredBundle) {
    unavailable('gateway_bundle_not_configured')
    return
  }
  const bundlePath = path.resolve(configuredBundle)
  if (!fs.existsSync(bundlePath)) {
    unavailable('gateway_bundle_missing')
    return
  }
  verifyReviewedBundle(bundlePath)

  const sandbox = createSandbox()
  const temporaryDirectory = sandbox.root
  const certificatePassphrase = crypto.randomBytes(24).toString('base64url')
  let completed = false
  try {
    const pfxPath = exportDevelopmentCertificate(temporaryDirectory, certificatePassphrase)
    if (!pfxPath) {
      unavailable('existing_https_development_certificate_unavailable')
      return
    }

    const isolatedDirectories = ['profile', 'session-data', 'logs', 'crash-dumps', 'cache']
    for (const name of isolatedDirectories) fs.mkdirSync(path.join(temporaryDirectory, name), { recursive: false })

    const environment = childEnvironment({
      PB02_ELECTRON_PROBE_BUNDLE: bundlePath,
      PB02_ELECTRON_PROBE_PFX: pfxPath,
      PB02_ELECTRON_PROBE_PFX_PASSPHRASE: certificatePassphrase,
      PB02_ELECTRON_PROBE_PROFILE: path.join(temporaryDirectory, 'profile'),
      PB02_ELECTRON_PROBE_SESSION_DATA: path.join(temporaryDirectory, 'session-data'),
      PB02_ELECTRON_PROBE_LOGS: path.join(temporaryDirectory, 'logs'),
      PB02_ELECTRON_PROBE_CRASH_DUMPS: path.join(temporaryDirectory, 'crash-dumps'),
      PB02_ELECTRON_PROBE_CACHE: path.join(temporaryDirectory, 'cache'),
      PB02_ELECTRON_PROBE_RUN_ID: sandbox.runId
    })

    const child = spawnSync(binary, [
      '--enable-unsafe-swiftshader',
      '--in-process-gpu',
      '--use-angle=swiftshader-webgl',
      path.join(__dirname, 'electron-main.cjs')
    ], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      env: environment,
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
      windowsHide: true
    })
    if (child.error) {
      const detail = String(child.stderr || child.stdout || 'no child diagnostics').trim()
      throw new Error(`${child.error.message}: ${detail.slice(0, 4_000)}`)
    }
    if (child.status !== 0) {
      const detail = String(child.stderr || child.stdout || 'Electron probe exited without diagnostics').trim()
      throw new Error(detail.slice(0, 8_000))
    }
    const match = String(child.stdout).match(/PB02_ELECTRON_CHILD_RESULT=PASS scenarios=(\d+) electron=([^\s]+)/u)
    if (!match) {
      const detail = String(child.stderr || child.stdout || 'no child diagnostics').trim()
      throw new Error(`Electron probe did not return a valid success record: ${detail.slice(0, 2_000)}`)
    }
    if (sandbox.retained) writeProducerMarker(temporaryDirectory, sandbox.runId, child.pid)
    completed = true
    result('PASS', {
      label: 'synthetic-electron-probe',
      scenarios: match[1],
      electron: match[2],
      retained: sandbox.retained,
      runId: sandbox.runId
    })
  } finally {
    if (!sandbox.retained) {
      fs.rmSync(temporaryDirectory, { force: true, recursive: true })
      if (fs.existsSync(temporaryDirectory)) throw new Error('temporary Electron profile cleanup failed')
    }
    if (!completed && process.exitCode) process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  result('FAIL', { reason: error?.message || 'unknown error' })
  process.exitCode = 1
}
