const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8')
const globalTypes = fs.readFileSync(path.join(__dirname, '../src/global.d.ts'), 'utf8')

test('renderer cannot select binding, actor, link or mapped Desktop user for identity operations', () => {
  assert.match(preload, /unlinkIdentity: \(\) => ipcRenderer\.invoke\('hermes:enterprise:wecom-bot-unlink-identity'\)/)
  assert.match(preload, /regenerateVerification: \(\) => ipcRenderer\.invoke\('hermes:enterprise:wecom-bot-regenerate-verification'\)/)
  const unlinkStart = main.indexOf("ipcMain.handle('hermes:enterprise:wecom-bot-unlink-identity'")
  const unlinkEnd = main.indexOf("ipcMain.handle('hermes:enterprise:wecom-bot-focus'", unlinkStart)
  assert.ok(unlinkStart > 0 && unlinkEnd > unlinkStart)
  assert.doesNotMatch(main.slice(unlinkStart, unlinkEnd), /event,\s*(binding|actor|link|user)/i)
})

test('public Bot state types omit Bot secret, Gateway tokens and raw channel user id', () => {
  const start = globalTypes.indexOf('export interface EnterpriseWeComBotIdentityClaim')
  const end = globalTypes.indexOf('export interface EnterpriseDesktopState', start)
  const publicBotTypes = globalTypes.slice(start, end)
  assert.doesNotMatch(publicBotTypes, /\bsecret\b|gatewayServiceToken|runtimeToken|channelUserId\s*:/i)
  assert.match(publicBotTypes, /channelUserIdHint/)
  assert.doesNotMatch(preload, /HERMES_ENTERPRISE_RUNTIME_CONTROL_TOKEN|X-Hermes-Enterprise-Runtime-Token/)
})
