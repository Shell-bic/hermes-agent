'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  ENTERPRISE_MANAGED_PTY_ERROR,
  isEnterpriseManaged,
  requirePtyAllowed
} = require('./pty-policy.cjs')

const FAKE_SECRET = 'gw_test_secret_boundary_1234567890'

test('enterprise managed PTY policy recognizes only explicit truthy values', () => {
  for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
    assert.equal(isEnterpriseManaged({ HERMES_ENTERPRISE_MANAGED: value }), true)
  }

  for (const value of [undefined, '', '0', 'false', 'off', 'managed']) {
    assert.equal(isEnterpriseManaged({ HERMES_ENTERPRISE_MANAGED: value }), false)
  }
})

test('enterprise managed PTY policy rejects before env copy, spawn, or raw data wiring', () => {
  let copiedEnv = false
  let spawned = false
  let rawDataHandlerRegistered = false

  const startTerminal = env => {
    requirePtyAllowed(env)
    copiedEnv = true
    spawned = true
    rawDataHandlerRegistered = true
  }

  const env = {
    HERMES_ENTERPRISE_MANAGED: '1',
    COMPANY_GATEWAY_TOKEN: FAKE_SECRET
  }

  assert.throws(
    () => startTerminal(env),
    error => {
      assert.equal(error.code, 'enterprise-managed-pty-disabled')
      assert.equal(error.message, ENTERPRISE_MANAGED_PTY_ERROR)
      assert.equal(error.message.includes(FAKE_SECRET), false)
      return true
    }
  )
  assert.equal(copiedEnv, false)
  assert.equal(spawned, false)
  assert.equal(rawDataHandlerRegistered, false)
})

test('non-managed PTY policy preserves the terminal start path', () => {
  let started = false

  requirePtyAllowed({ HERMES_ENTERPRISE_MANAGED: '0' })
  started = true

  assert.equal(started, true)
})

test('desktop terminal handler applies policy before env copy, spawn, and raw data callbacks', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
  const handlerStart = source.indexOf("ipcMain.handle('hermes:terminal:start'")
  const handlerEnd = source.indexOf("ipcMain.handle('hermes:terminal:write'", handlerStart)
  const handler = source.slice(handlerStart, handlerEnd)

  const policyIndex = handler.indexOf('requirePtyAllowed(process.env)')
  const envIndex = handler.indexOf('terminalShellEnv()')
  const spawnIndex = handler.indexOf('nodePty.spawn(')
  const rawDataIndex = handler.indexOf('ptyProcess.onData(')

  assert.notEqual(handlerStart, -1)
  assert.notEqual(handlerEnd, -1)
  assert.ok(policyIndex >= 0 && policyIndex < envIndex)
  assert.ok(policyIndex < spawnIndex)
  assert.ok(policyIndex < rawDataIndex)
})
