const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  loadOfflineRuntimePayload,
  packagedOfflineRuntimeUpgradeRequired,
  patchWindowsVenv,
  provisionOfflineRuntime
} = require('./offline-runtime.cjs')

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function createPayload(root, commit = 'a'.repeat(40)) {
  const files = {
    'runtime/pyproject.toml': '[project]\nname="hermes-agent"\n',
    'runtime/hermes_cli/main.py': 'print("ok")\n',
    'runtime/venv/Scripts/python.exe': 'venv-python',
    'runtime/venv/pyvenv.cfg': 'home = C:\\build\\python\nversion_info = 3.11.15\n',
    'python/python.exe': 'python',
    'git/cmd/git.exe': 'git',
    'git/bin/bash.exe': 'bash',
    'node/node.exe': 'node',
    'node/agent-browser.cmd': '@echo off\n'
  }
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  const criticalFiles = Object.fromEntries(
    Object.keys(files).map(relative => [relative, hash(path.join(root, relative))])
  )
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      commit,
      branch: 'main',
      version: '0.16.1',
      platform: 'win32',
      arch: 'x64',
      criticalFiles
    })
  )
}

test('offline payload validates platform, pinned commit, and critical hashes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-offline-payload-'))
  try {
    createPayload(root)
    const payload = loadOfflineRuntimePayload(root, {
      platform: 'win32',
      arch: 'x64',
      installStamp: { commit: 'a'.repeat(40) }
    })
    assert.equal(payload.manifest.version, '0.16.1')

    assert.throws(
      () => loadOfflineRuntimePayload(root, {
        platform: 'win32',
        arch: 'x64',
        installStamp: { commit: 'b'.repeat(40) }
      }),
      /does not match Desktop commit/
    )

    fs.writeFileSync(path.join(root, 'node', 'node.exe'), 'tampered')
    assert.throws(
      () => loadOfflineRuntimePayload(root, { platform: 'win32', arch: 'x64' }),
      /integrity check failed/
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('packaged enterprise runtime upgrades only when the release commit changed', () => {
  const oldCommit = 'a'.repeat(40)
  const newCommit = 'b'.repeat(40)
  const base = {
    isPackaged: true,
    enterpriseManaged: true,
    installStamp: { commit: newCommit },
    bootstrapMarker: { schemaVersion: 1, pinnedCommit: oldCommit }
  }

  assert.equal(packagedOfflineRuntimeUpgradeRequired(base), true)
  assert.equal(
    packagedOfflineRuntimeUpgradeRequired({
      ...base,
      bootstrapMarker: { schemaVersion: 1, pinnedCommit: newCommit.toUpperCase() }
    }),
    false
  )
  assert.equal(packagedOfflineRuntimeUpgradeRequired({ ...base, enterpriseManaged: false }), false)
  assert.equal(packagedOfflineRuntimeUpgradeRequired({ ...base, isPackaged: false }), false)
  assert.equal(packagedOfflineRuntimeUpgradeRequired({ ...base, installStamp: null }), false)
  assert.equal(packagedOfflineRuntimeUpgradeRequired({ ...base, bootstrapMarker: null }), false)
})

test('patchWindowsVenv replaces the build-machine Python home', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-offline-venv-'))
  try {
    fs.writeFileSync(path.join(root, 'pyvenv.cfg'), 'home = C:\\build\\python\nversion_info = 3.11.15\n')
    await patchWindowsVenv(root, 'C:\\Users\\target\\AppData\\Local\\hermes\\python')
    const config = fs.readFileSync(path.join(root, 'pyvenv.cfg'), 'utf8')
    assert.match(config, /^home = C:\\Users\\target\\AppData\\Local\\hermes\\python/m)
    assert.doesNotMatch(config, /C:\\build\\python/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('offline provisioning installs runtime and support tools without network access', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-offline-provision-'))
  const payloadRoot = path.join(sandbox, 'payload')
  const home = path.join(sandbox, 'home')
  const activeRoot = path.join(home, 'hermes-agent')
  try {
    createPayload(payloadRoot)
    const payload = loadOfflineRuntimePayload(payloadRoot, { platform: 'win32', arch: 'x64' })
    const events = []
    const result = await provisionOfflineRuntime({
      payload,
      hermesHome: home,
      activeRoot,
      platform: 'win32',
      emit: event => events.push(event)
    })

    assert.equal(result.receipt.commit, 'a'.repeat(40))
    assert.ok(fs.existsSync(path.join(activeRoot, 'venv', 'Scripts', 'python.exe')))
    assert.ok(fs.existsSync(path.join(home, 'python', 'python.exe')))
    assert.ok(fs.existsSync(path.join(home, 'git', 'bin', 'bash.exe')))
    assert.ok(fs.existsSync(path.join(home, 'node', 'agent-browser.cmd')))
    assert.match(fs.readFileSync(path.join(activeRoot, 'venv', 'pyvenv.cfg'), 'utf8'), /home\\python/)
    assert.ok(events.some(event => event.name === 'offline-copy' && event.state === 'succeeded'))
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('offline provisioning replaces an older runtime and preserves it as a backup', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-offline-upgrade-'))
  const payloadRoot = path.join(sandbox, 'payload')
  const home = path.join(sandbox, 'home')
  const activeRoot = path.join(home, 'hermes-agent')
  try {
    createPayload(payloadRoot, 'b'.repeat(40))
    fs.mkdirSync(activeRoot, { recursive: true })
    fs.writeFileSync(path.join(activeRoot, 'old-runtime.txt'), '0.16.1')
    fs.mkdirSync(path.join(home, 'python'), { recursive: true })
    fs.writeFileSync(path.join(home, 'python', 'old-python.txt'), 'old')

    const payload = loadOfflineRuntimePayload(payloadRoot, { platform: 'win32', arch: 'x64' })
    const result = await provisionOfflineRuntime({
      payload,
      hermesHome: home,
      activeRoot,
      platform: 'win32'
    })

    assert.equal(result.receipt.commit, 'b'.repeat(40))
    assert.ok(fs.existsSync(path.join(activeRoot, 'hermes_cli', 'main.py')))
    assert.equal(fs.existsSync(path.join(activeRoot, 'old-runtime.txt')), false)
    assert.ok(result.backupRoot)
    assert.equal(
      fs.readFileSync(path.join(result.backupRoot, 'hermes-agent', 'old-runtime.txt'), 'utf8'),
      '0.16.1'
    )
    assert.equal(
      fs.readFileSync(path.join(result.backupRoot, 'python', 'old-python.txt'), 'utf8'),
      'old'
    )
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
