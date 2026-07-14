const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const electronDir = __dirname
const desktopDir = path.resolve(__dirname, '..')

function source(relativePath) {
  return fs.readFileSync(path.join(desktopDir, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

test('preload exposes only sanitized enterprise login operations', () => {
  const preload = source('electron/preload.cjs')
  const start = preload.indexOf('  enterprise: {')
  const end = preload.indexOf('  redactSensitiveText:', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const enterpriseApi = preload.slice(start, end)

  for (const operation of [
    'loginMethods',
    'loginState',
    'selectLoginMethod',
    'refreshWeCom',
    'cancelWeCom',
    'setWeComBounds',
    'onLoginState'
  ]) {
    assert.match(enterpriseApi, new RegExp(`\\b${operation}\\b`))
  }
  for (const forbidden of ['transactionId', 'authorizationUrl', 'verifier', 'assertion', 'desktopToken', 'dsk_']) {
    assert.doesNotMatch(enterpriseApi, new RegExp(forbidden, 'i'))
  }
})

test('every enterprise IPC handler validates a trusted main-frame sender', () => {
  const main = source('electron/main.cjs')
  assert.match(main, /senderFrame !== sender\.mainFrame/)
  assert.match(main, /isTrustedEnterpriseRendererUrl\(senderFrame\.url \|\| sender\.getURL\(\)\)/)
  assert.match(main, /BrowserWindow\.fromWebContents\(sender\)/)
  assert.match(main, /enterpriseSkillHubIpc\(event, operation\)[\s\S]*isTrustedDesktopRendererUrl\(event\?\.senderFrame\?\.url\)/)

  const handlers = [...main.matchAll(/ipcMain\.handle\('hermes:enterprise:([^']+)'/g)]
  assert.ok(handlers.length > 0)
  for (let index = 0; index < handlers.length; index += 1) {
    const handlerStart = handlers[index].index
    const handlerEnd = handlers[index + 1]?.index || main.indexOf("ipcMain.handle('hermes:connection'", handlerStart)
    const body = main.slice(handlerStart, handlerEnd)
    const channel = handlers[index][1]
    if (channel.startsWith('skill-hub:')) {
      assert.match(body, /enterpriseSkillHubIpc\(event/, `missing Skill Hub sender validation for ${channel}`)
    } else {
      assert.match(body, /assertTrustedEnterpriseSender\(event/, `missing sender validation for ${channel}`)
    }
  }
})

test('QR IPC is main-window-only and app/window shutdown uses guarded controller cleanup', () => {
  const main = source('electron/main.cjs')
  for (const channel of [
    'login-methods',
    'login-state',
    'login-method-select',
    'wecom-refresh',
    'wecom-cancel',
    'wecom-bounds'
  ]) {
    const start = main.indexOf(`ipcMain.handle('hermes:enterprise:${channel}'`)
    const end = main.indexOf("ipcMain.handle('hermes:", start + 30)
    assert.notEqual(start, -1)
    assert.match(main.slice(start, end), /mainWindowOnly: true/)
  }
  assert.match(main, /mainWindow\.on\('closed',[\s\S]*enterpriseWeComController\.dispose\(\{ permanent: !IS_MAC \}\)/)
  assert.match(main, /app\.on\('before-quit', event =>[\s\S]*event\.preventDefault\(\)/)
  assert.match(main, /enterpriseQuitCleanupPromise[\s\S]*dispose\(\{ permanent: true \}\)[\s\S]*enterpriseQuitReady = true[\s\S]*app\.quit\(\)/)
  const logoutStart = main.indexOf("ipcMain.handle('hermes:enterprise:logout'")
  const logoutEnd = main.indexOf("ipcMain.handle('hermes:connection'", logoutStart)
  assert.match(main.slice(logoutStart, logoutEnd), /enterpriseWeComController\.cancel\(\{ force: true/)
  assert.doesNotMatch(main.slice(logoutStart, logoutEnd), /enterpriseWeComController\.dispose/)
})

test('password IPC cannot race an in-flight QR redeem', () => {
  const main = source('electron/main.cjs')
  const start = main.indexOf("ipcMain.handle('hermes:enterprise:login'")
  const end = main.indexOf("ipcMain.handle('hermes:enterprise:selectModel'", start)
  const handler = main.slice(start, end)
  assert.match(handler, /await enterpriseWeComController\.selectMethod\('password'\)/)
  assert.match(handler, /loginState\.selectedMethod !== 'password'/)
  assert.match(handler, /loginState\.status !== 'password-ready'/)
  assert.match(handler, /enterprise-login-busy/)
  assert.match(handler, /enterpriseRuntime\.login\(payload \|\| \{\}\)/)
})

test('QR refresh IPC retries method discovery before starting a new transaction', () => {
  const main = source('electron/main.cjs')
  const start = main.indexOf("ipcMain.handle('hermes:enterprise:wecom-refresh'")
  const end = main.indexOf("ipcMain.handle('hermes:enterprise:wecom-cancel'", start)
  const handler = main.slice(start, end)
  assert.match(handler, /enterpriseWeComController\.retry\(\)/)
  assert.doesNotMatch(handler, /enterpriseWeComController\.start\(\)/)
})

test('renderer types store and UI do not contain transaction or token material', () => {
  const rendererSources = [
    source('src/global.d.ts'),
    source('src/store/enterprise.ts'),
    source('src/components/enterprise-login-overlay.tsx')
  ].join('\n')

  for (const forbidden of ['transactionId', 'authorizationUrl', 'verifier', 'assertion', 'desktopToken', 'dsk_']) {
    assert.doesNotMatch(rendererSources, new RegExp(forbidden, 'i'))
  }
})

test('QR controller and view remain main-process modules', () => {
  assert.equal(fs.existsSync(path.join(electronDir, 'enterprise-wecom-controller.cjs')), true)
  assert.equal(fs.existsSync(path.join(electronDir, 'enterprise-wecom-view.cjs')), true)
  const preload = source('electron/preload.cjs')
  assert.doesNotMatch(preload, /enterprise-wecom-controller|enterprise-wecom-view/)
})
