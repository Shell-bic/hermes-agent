const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { verifyMirror } = require('./verify-wecom-personal-bot-contract-mirror.cjs')

const DESKTOP_ROOT = path.resolve(__dirname, '..')
const CONTRACT_MIRROR = path.resolve(DESKTOP_ROOT, '../../contracts/wecom-personal-bot/v1')
const SCRIPT_PATH = path.join(__dirname, 'verify-wecom-personal-bot-contract-mirror.cjs')

test('package exposes the cross-repository verifier and requires an explicit Gateway root', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'))
  assert.equal(
    packageJson.scripts['verify:wecom-personal-bot-contract-mirror'],
    'node scripts/verify-wecom-personal-bot-contract-mirror.cjs'
  )

  const missingArgument = childProcess.spawnSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8' })
  assert.notEqual(missingArgument.status, 0)
  assert.match(missingArgument.stderr, /gateway-repository-root/)
})

test('cross-repository verifier accepts identical bytes and rejects drift without a real Gateway checkout', () => {
  const gatewayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-contract-authority-'))
  const authority = path.join(gatewayRoot, 'contracts', 'wecom-personal-bot', 'v1')
  fs.mkdirSync(path.dirname(authority), { recursive: true })
  fs.cpSync(CONTRACT_MIRROR, authority, { recursive: true })

  assert.ok(verifyMirror(gatewayRoot) > 0)
  fs.appendFileSync(path.join(authority, 'contract.json'), '\n')
  assert.throws(() => verifyMirror(gatewayRoot), /Contract bytes differ/)
})
