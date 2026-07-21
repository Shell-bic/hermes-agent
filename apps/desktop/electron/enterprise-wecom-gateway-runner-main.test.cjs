const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const electronDir = __dirname
const main = fs.readFileSync(path.join(electronDir, 'main.cjs'), 'utf8')
const preload = fs.readFileSync(path.join(electronDir, 'preload.cjs'), 'utf8')
const runtimeHome = fs.readFileSync(path.join(electronDir, 'enterprise-runtime-home.cjs'), 'utf8')
const desktopPackage = JSON.parse(fs.readFileSync(path.join(electronDir, '..', 'package.json'), 'utf8'))

test('WeCom development launcher enables managed mode against the local enterprise Gateway', () => {
  const script = desktopPackage.scripts['dev:wecom']

  assert.match(script, /HERMES_DESKTOP_ENTERPRISE_GATEWAY_URL=http:\/\/127\.0\.0\.1:5000/)
  assert.match(script, /HERMES_DESKTOP_WECOM_GATEWAY_RUNNER_EXPERIMENT=1/)
})

test('main injects only an independent runtime-control token and hot-attaches after backend readiness', () => {
  assert.match(main, /HERMES_ENTERPRISE_RUNTIME_CONTROL_TOKEN: enterpriseWeComRuntimeControlToken/)
  assert.match(
    main,
    /if \(enterpriseWeComGatewayRunnerExperiment\.isEnabled\(\)\) \{[\s\S]*childEnv\.HERMES_DESKTOP_WECOM_GATEWAY_RUNNER = '1'/
  )
  assert.match(main, /spawn\([\s\S]*delete childEnv\.HERMES_ENTERPRISE_RUNTIME_CONTROL_TOKEN/)
  assert.match(main, /enterpriseWeComRuntimeConnection = \{ baseUrl \}[\s\S]*enterpriseWeComGatewayRunnerExperiment\.attach\(\)/)
  assert.doesNotMatch(main, /prepareBackendEnv\(\)|Object\.assign\(childEnv, wecomGatewayRunnerLaunch\.env\)/)
  assert.doesNotMatch(main, /WECOM_BOT_ID:|WECOM_SECRET:/)

  assert.doesNotMatch(preload, /runtime-config|runtime-control|WECOM_BOT_ID|WECOM_SECRET|GatewayRunner/i)
  assert.doesNotMatch(runtimeHome, /WECOM_BOT_ID|WECOM_SECRET/)
})

test('old relay runs only when the experiment is disabled, including the no-binding experiment path', () => {
  assert.match(
    main,
    /if \(enterpriseWeComGatewayRunnerExperiment\.isEnabled\(\)\) \{[\s\S]*enterpriseWeComRelay\.stop\(\)[\s\S]*\} else \{[\s\S]*enterpriseWeComRelay\.start\(\)/
  )
  assert.doesNotMatch(main, /wecomGatewayRunnerLaunch/)
})

test('branch experiment pins its explicit runtime and disables original main updater recovery', () => {
  assert.match(
    main,
    /const ENTERPRISE_WECOM_PINNED_RUNTIME =[\s\S]*ENTERPRISE_RUNTIME_OPTIONS\.weComGatewayRunnerExperiment === true \|\|[\s\S]*HERMES_DESKTOP_WECOM_GATEWAY_RUNNER_EXPERIMENT === '1'/
  )
  assert.match(
    main,
    /async function checkUpdates\(\) \{[\s\S]*if \(ENTERPRISE_WECOM_PINNED_RUNTIME\)[\s\S]*enterprise-experiment-pinned-runtime/
  )
  assert.match(
    main,
    /async function applyUpdates\(opts = \{\}\) \{[\s\S]*if \(ENTERPRISE_WECOM_PINNED_RUNTIME\)[\s\S]*enterprise-experiment-update-disabled/
  )
  assert.match(
    main,
    /if \(backend\.kind === 'bootstrap-needed'\) \{[\s\S]*if \(ENTERPRISE_WECOM_PINNED_RUNTIME\)[\s\S]*enterprise-experiment-runtime-unavailable[\s\S]*handOffWindowsBootstrapRecovery/
  )
  assert.match(main, /const venvRoot = resolvePythonVenvRoot\(root\)[\s\S]*pythonPathEntries: \[root\],[\s\S]*venvRoot/)
})

test('quit logout account switch and invalid session stop the backend, while Bot unbind only detaches the adapter', () => {
  const revokeStart = main.indexOf("ipcMain.handle('hermes:enterprise:wecom-bot-revoke'")
  const revokeEnd = main.indexOf("ipcMain.handle('hermes:enterprise:wecom-bot-regenerate-verification'", revokeStart)
  assert.match(main.slice(revokeStart, revokeEnd), /enterpriseWeComBotController\.revokeBot\(\)/)
  assert.doesNotMatch(main.slice(revokeStart, revokeEnd), /teardownPrimaryBackendAndWait\(\)/)

  const loginStart = main.indexOf("ipcMain.handle('hermes:enterprise:login'")
  const loginEnd = main.indexOf("ipcMain.handle('hermes:enterprise:selectModel'", loginStart)
  const login = main.slice(loginStart, loginEnd)
  assert.ok(login.indexOf('teardownPrimaryBackendAndWait()') < login.indexOf('enterpriseRuntime.login('))

  const logoutStart = main.indexOf("ipcMain.handle('hermes:enterprise:logout'")
  const logoutEnd = main.indexOf("ipcMain.handle('hermes:enterprise:skill-hub:list'", logoutStart)
  assert.match(main.slice(logoutStart, logoutEnd), /teardownPrimaryBackendAndWait\(\)/)

  assert.match(
    main,
    /refreshEnterprisePublicStateAndEnforceLifecycle[\s\S]*!enterpriseRuntime\.hasStoredSession\(\)[\s\S]*teardownPrimaryBackendAndWait\(\)/
  )
  assert.match(
    main,
    /enterpriseQuitCleanupPromise = Promise\.all\(\[[\s\S]*teardownPrimaryBackendAndWait\(\)/
  )
})

test('completed binding hot-attaches without restarting the primary backend', () => {
  const controllerStart = main.indexOf('const enterpriseWeComBotController')
  const controllerEnd = main.indexOf('const enterpriseWeComGatewayRunnerExperiment', controllerStart)
  const controller = main.slice(controllerStart, controllerEnd)
  assert.match(controller, /onBindingCompleted: binding => \{[\s\S]*enterpriseWeComGatewayRunnerExperiment\.attach\(binding\)/)
  assert.doesNotMatch(controller, /teardownPrimaryBackendAndWait|startHermes/)
  assert.match(main, /intentionallyStoppedHermesProcesses\.add\(hermesProcess\)/)
  assert.match(main, /if \(!intentionalStop\) sendBackendExit\(\{ code, signal \}\)/)
  assert.match(main, /enterpriseWeComBotController\.applyRuntimeState\(runtimeState\)/)
})
