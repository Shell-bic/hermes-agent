'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const OFFLINE_RUNTIME_SCHEMA_VERSION = 1
const COMMIT_RE = /^[0-9a-f]{40}$/i

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function directoryExists(filePath) {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function requiredPayloadPaths(root, platform) {
  const common = [
    ['runtime', 'pyproject.toml'],
    ['runtime', 'hermes_cli', 'main.py'],
    ['manifest.json']
  ]
  if (platform === 'win32') {
    common.push(
      ['python', 'python.exe'],
      ['runtime', 'venv', 'Scripts', 'python.exe'],
      ['git', 'cmd', 'git.exe'],
      ['git', 'bin', 'bash.exe'],
      ['node', 'node.exe'],
      ['node', 'agent-browser.cmd']
    )
  }
  return common.map(parts => path.join(root, ...parts))
}

function loadOfflineRuntimePayload(payloadRoot, options = {}) {
  if (!payloadRoot || !directoryExists(payloadRoot)) return null

  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const installStamp = options.installStamp || null
  const manifestPath = path.join(payloadRoot, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Offline runtime manifest is unreadable: ${error.message}`)
  }

  if (manifest.schemaVersion !== OFFLINE_RUNTIME_SCHEMA_VERSION) {
    throw new Error(
      `Offline runtime schema ${manifest.schemaVersion} is unsupported; expected ${OFFLINE_RUNTIME_SCHEMA_VERSION}.`
    )
  }
  if (!COMMIT_RE.test(String(manifest.commit || ''))) {
    throw new Error('Offline runtime manifest does not contain a full Git commit.')
  }
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error(
      `Offline runtime targets ${manifest.platform}/${manifest.arch}, not ${platform}/${arch}.`
    )
  }
  if (installStamp?.commit && manifest.commit.toLowerCase() !== String(installStamp.commit).toLowerCase()) {
    throw new Error(
      `Offline runtime commit ${manifest.commit} does not match Desktop commit ${installStamp.commit}.`
    )
  }

  for (const requiredPath of requiredPayloadPaths(payloadRoot, platform)) {
    if (!fileExists(requiredPath)) {
      throw new Error(`Offline runtime payload is incomplete: ${requiredPath}`)
    }
  }

  const criticalFiles = manifest.criticalFiles
  if (!criticalFiles || typeof criticalFiles !== 'object' || Array.isArray(criticalFiles)) {
    throw new Error('Offline runtime manifest does not contain critical file hashes.')
  }
  for (const [relativePath, expectedHash] of Object.entries(criticalFiles)) {
    if (!/^[0-9a-f]{64}$/i.test(String(expectedHash || ''))) {
      throw new Error(`Offline runtime hash is invalid for ${relativePath}.`)
    }
    const normalized = path.normalize(relativePath)
    if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`Offline runtime manifest contains an unsafe path: ${relativePath}`)
    }
    const fullPath = path.join(payloadRoot, normalized)
    if (!fileExists(fullPath) || sha256File(fullPath) !== expectedHash.toLowerCase()) {
      throw new Error(`Offline runtime integrity check failed: ${relativePath}`)
    }
  }

  return { root: payloadRoot, manifest }
}

async function patchWindowsVenv(venvRoot, pythonHome) {
  const configPath = path.join(venvRoot, 'pyvenv.cfg')
  const current = await fsp.readFile(configPath, 'utf8')
  const lines = current.split(/\r?\n/).filter(Boolean)
  let replaced = false
  const updated = lines.map(line => {
    if (!/^home\s*=/i.test(line)) return line
    replaced = true
    return `home = ${pythonHome}`
  })
  if (!replaced) updated.unshift(`home = ${pythonHome}`)
  await fsp.writeFile(configPath, `${updated.join('\r\n')}\r\n`, 'utf8')
}

async function moveIntoPlace(stagedPath, targetPath, backupRoot, emit) {
  let backupPath = null
  if (directoryExists(targetPath)) {
    await fsp.mkdir(backupRoot, { recursive: true })
    backupPath = path.join(backupRoot, path.basename(targetPath))
    await fsp.rename(targetPath, backupPath)
    emit?.({ type: 'log', line: `[offline] preserved previous ${targetPath} at ${backupPath}` })
  }
  try {
    await fsp.rename(stagedPath, targetPath)
  } catch (error) {
    if (backupPath && !directoryExists(targetPath)) {
      await fsp.rename(backupPath, targetPath).catch(() => {})
    }
    throw error
  }
}

async function provisionOfflineRuntime(options) {
  const {
    payload,
    hermesHome,
    activeRoot,
    platform = process.platform,
    emit = () => {}
  } = options

  if (!payload?.root || !payload?.manifest) throw new Error('Offline runtime payload was not resolved.')
  if (platform !== 'win32') throw new Error(`Offline runtime provisioning is not implemented for ${platform}.`)

  const stamp = `${Date.now()}-${process.pid}`
  const stagingRoot = path.join(hermesHome, `.offline-runtime-staging-${stamp}`)
  const backupRoot = path.join(hermesHome, 'offline-runtime-backups', stamp)
  const stagedRuntime = path.join(stagingRoot, 'hermes-agent')
  const stagedPython = path.join(stagingRoot, 'python')
  const stagedGit = path.join(stagingRoot, 'git')
  const stagedNode = path.join(stagingRoot, 'node')

  await fsp.mkdir(stagingRoot, { recursive: true })
  try {
    emit({ type: 'stage', name: 'offline-copy', state: 'running' })
    await fsp.cp(path.join(payload.root, 'runtime'), stagedRuntime, { recursive: true, force: true })
    await fsp.cp(path.join(payload.root, 'python'), stagedPython, { recursive: true, force: true })
    await fsp.cp(path.join(payload.root, 'git'), stagedGit, { recursive: true, force: true })
    await fsp.cp(path.join(payload.root, 'node'), stagedNode, { recursive: true, force: true })

    const pythonTarget = path.join(hermesHome, 'python')
    await patchWindowsVenv(path.join(stagedRuntime, 'venv'), pythonTarget)

    const receipt = {
      schemaVersion: OFFLINE_RUNTIME_SCHEMA_VERSION,
      commit: payload.manifest.commit,
      version: payload.manifest.version,
      provisionedAt: new Date().toISOString(),
      source: 'packaged-offline-runtime'
    }
    await fsp.writeFile(
      path.join(stagedRuntime, '.hermes-offline-runtime.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      'utf8'
    )

    await moveIntoPlace(stagedPython, pythonTarget, backupRoot, emit)
    await moveIntoPlace(stagedGit, path.join(hermesHome, 'git'), backupRoot, emit)
    await moveIntoPlace(stagedNode, path.join(hermesHome, 'node'), backupRoot, emit)
    await moveIntoPlace(stagedRuntime, activeRoot, backupRoot, emit)
    emit({ type: 'stage', name: 'offline-copy', state: 'succeeded' })
    return { receipt, backupRoot: directoryExists(backupRoot) ? backupRoot : null }
  } catch (error) {
    emit({ type: 'stage', name: 'offline-copy', state: 'failed', error: error.message })
    throw error
  } finally {
    await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }
}

module.exports = {
  OFFLINE_RUNTIME_SCHEMA_VERSION,
  loadOfflineRuntimePayload,
  patchWindowsVenv,
  provisionOfflineRuntime,
  requiredPayloadPaths
}
