const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\r\n/g, '\n')
}

test('managed boot failures are rewrapped against the current lifecycle epoch', () => {
  const main = source('main.cjs')
  const start = main.indexOf('async function startHermes()')
  const end = main.indexOf('\nfunction wireCommonWindowHandlers', start)
  const body = main.slice(start, end)

  assert.match(body, /createEnterprisePublicError\(error,\s*\{[\s\S]*?lifecycle:\s*enterpriseLifecycle\.getSnapshot\(\),[\s\S]*?useCurrentEpoch:\s*true/)
  assert.equal(body.includes('beginEnterpriseRecovery('), false)
  assert.match(main, /bootProgressState\s*=\s*\{[\s\S]*?enterpriseManaged:\s*ENTERPRISE_RUNTIME_OPTIONS\.enabled/)
  assert.match(main, /function resetBootProgressForReconnect\(\)\s*\{[\s\S]*?enterpriseError:\s*null/)
  assert.equal((main.match(/phase:\s*'backend\.ready',[\s\S]{0,180}?enterpriseError:\s*null/g) || []).length, 2)
})

test('trusted managed recovery IPC uses dedicated single-flight actions and public envelopes', () => {
  const main = source('main.cjs')
  const start = main.indexOf('const enterpriseManagedRecoveryActions =')
  const end = main.indexOf("ipcMain.handle('hermes:enterprise:login-methods'", start)
  const body = main.slice(start, end)

  assert.match(body, /hasSession:\s*\(\)\s*=>\s*enterpriseRuntime\.hasStoredSession\(\)/)
  assert.match(body, /startBackend:\s*\(\)\s*=>\s*startHermes\(\)/)
  assert.match(body, /enterprisePublicFailure\(createEnterprisePublicError\(error,\s*\{[\s\S]*?useCurrentEpoch:\s*true/)
  assert.match(body, /'hermes:enterprise:recover-policy'[\s\S]*?mainWindowOnly:\s*true[\s\S]*?enterpriseManagedRecoveryActions\.refreshPolicy\(\)/)
  assert.match(body, /'hermes:enterprise:retry-stop'[\s\S]*?mainWindowOnly:\s*true[\s\S]*?enterpriseManagedRecoveryActions\.retryStop\(\)/)
})

test('preload unwraps both managed recovery results and exposes no updater coupling', () => {
  const preload = source('preload.cjs')
  const overlay = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'boot-failure-overlay.tsx'),
    'utf8'
  )

  assert.match(preload, /recoverPolicy:\s*\(\)\s*=>\s*invokeEnterpriseRecovery\('hermes:enterprise:recover-policy'\)/)
  assert.match(preload, /retryStop:\s*\(\)\s*=>\s*invokeEnterpriseRecovery\('hermes:enterprise:retry-stop'\)/)
  assert.match(preload, /invokeEnterpriseRecovery\s*=\s*channel\s*=>\s*ipcRenderer\.invoke\(channel\)\.then\(unwrapEnterprisePublicResult\)/)
  assert.equal(overlay.includes('updates.check'), false)
  assert.equal(overlay.includes('checkDesktopUpdate'), false)
})
