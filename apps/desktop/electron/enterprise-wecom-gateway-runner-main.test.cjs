const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const electronDir = __dirname
const main = fs.readFileSync(path.join(electronDir, 'main.cjs'), 'utf8')
const preload = fs.readFileSync(path.join(electronDir, 'preload.cjs'), 'utf8')
const runtimeHome = fs.readFileSync(path.join(electronDir, 'enterprise-runtime-home.cjs'), 'utf8')
const desktopPackage = JSON.parse(fs.readFileSync(path.join(electronDir, '..', 'package.json'), 'utf8'))
const {
  buildWeComDevLaunch,
  desktopRoot,
  hermesRoot
} = require('../scripts/dev-wecom.cjs')

test('WeCom development launcher pins the current checkout and local enterprise Gateway', () => {
  const npmExecPath = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  const launch = buildWeComDevLaunch({
    env: { npm_execpath: npmExecPath },
    platform: 'win32'
  })

  assert.equal(desktopPackage.scripts['dev:wecom'], 'node scripts/dev-wecom.cjs')
  assert.equal(launch.command, process.execPath)
  assert.deepEqual(launch.args, [npmExecPath, 'run', 'dev'])
  assert.equal(launch.cwd, desktopRoot)
  assert.equal(launch.env.HERMES_DESKTOP_HERMES_ROOT, hermesRoot)
  assert.equal(launch.env.HERMES_DESKTOP_ENTERPRISE_GATEWAY_URL, 'http://127.0.0.1:5000')
  assert.equal(launch.env.HERMES_DESKTOP_WECOM_GATEWAY_RUNNER_EXPERIMENT, '1')
  assert.equal(path.isAbsolute(launch.env.HERMES_DESKTOP_HERMES_ROOT), true)
  assert.equal(fs.existsSync(path.join(launch.env.HERMES_DESKTOP_HERMES_ROOT, 'hermes_cli', 'main.py')), true)
})

test('WeCom development launcher avoids direct npm.cmd spawn on Windows fallback', () => {
  const launch = buildWeComDevLaunch({
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    platform: 'win32'
  })

  assert.equal(launch.command, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(launch.args, ['/d', '/s', '/c', 'npm run dev'])
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
    /allowedMessagingChannels\.includes\('wecom-personal'\)[\s\S]*if \(enterpriseWeComGatewayRunnerExperiment\.isEnabled\(\)\) enterpriseWeComRelay\.stop\(\)[\s\S]*else enterpriseWeComRelay\.start\(\)[\s\S]*\} else \{[\s\S]*enterpriseWeComRelay\.stop\(\)/
  )
  assert.doesNotMatch(main, /wecomGatewayRunnerLaunch/)
})

test('enterprise release separates the production GatewayRunner from the dev-only pinned runtime', () => {
  assert.match(
    main,
    /const ENTERPRISE_WECOM_GATEWAY_RUNNER_ENABLED =[\s\S]*ENTERPRISE_RUNTIME_OPTIONS\.weComGatewayRunnerExperiment === true \|\|[\s\S]*HERMES_DESKTOP_WECOM_GATEWAY_RUNNER_EXPERIMENT === '1'/
  )
  assert.match(
    main,
    /const ENTERPRISE_WECOM_PINNED_RUNTIME =\s*process\.env\.HERMES_DESKTOP_WECOM_GATEWAY_RUNNER_EXPERIMENT === '1'/
  )
  assert.match(
    main,
    /const ENTERPRISE_LOCAL_UPDATES_DISABLED =[\s\S]*ENTERPRISE_RUNTIME_OPTIONS\.enabled \|\| ENTERPRISE_WECOM_PINNED_RUNTIME/
  )
  assert.match(
    main,
    /async function checkUpdates\(\) \{[\s\S]*if \(ENTERPRISE_LOCAL_UPDATES_DISABLED\)[\s\S]*enterprise-managed-update-disabled/
  )
  assert.match(
    main,
    /async function applyUpdates\(opts = \{\}\) \{[\s\S]*if \(ENTERPRISE_LOCAL_UPDATES_DISABLED\)[\s\S]*enterprise-managed-update-disabled/
  )
  assert.match(
    main,
    /if \(backend\.kind === 'bootstrap-needed'\) \{[\s\S]*if \(ENTERPRISE_WECOM_PINNED_RUNTIME\)[\s\S]*enterprise-experiment-runtime-unavailable[\s\S]*handOffWindowsBootstrapRecovery/
  )
  assert.match(
    main,
    /async function handOffWindowsBootstrapRecovery\(reason\) \{[\s\S]*if \(ENTERPRISE_LOCAL_UPDATES_DISABLED\) return false/
  )
  assert.match(
    main,
    /desktopHostedRuntime: ENTERPRISE_WECOM_GATEWAY_RUNNER_ENABLED[\s\S]*enabled: ENTERPRISE_WECOM_GATEWAY_RUNNER_ENABLED/
  )
  assert.match(main, /const venvRoot = resolvePythonVenvRoot\(root\)[\s\S]*pythonPathEntries: \[root\],[\s\S]*venvRoot/)
  assert.match(
    main,
    /function findPythonForRoot\(root\) \{[\s\S]*getVenvPython\(VENV_ROOT\)[\s\S]*return managedVenvPython/
  )
  const pinnedFailClosed = main.indexOf('WeCom experiment could not resolve its pinned source runtime')
  const installedCliFallback = main.indexOf('// 3. Bootstrap-complete ACTIVE_HERMES_ROOT')
  assert.ok(pinnedFailClosed > 0)
  assert.ok(pinnedFailClosed < installedCliFallback)
})

test('managed lifecycle defers safeStorage decryption until Electron is ready', () => {
  assert.match(
    main,
    /enterpriseLifecycle = createEnterpriseManagedLifecycle\(\{[\s\S]*hasSession: !enterpriseRuntime\.isEnabled\(\) \|\| enterpriseAuthStore\.hasPersistedSession\(\)/
  )
  const lifecycleInitialization = main.indexOf('enterpriseLifecycle = createEnterpriseManagedLifecycle({')
  const electronReady = main.indexOf('app.whenReady().then(() => {')
  assert.ok(lifecycleInitialization > 0)
  assert.ok(lifecycleInitialization < electronReady)
})

test('renderer cold-start status stays non-blocking and receives authoritative recovery state', () => {
  assert.match(
    main,
    /async function refreshEnterprisePublicStateAndEnforceLifecycle\(\) \{[\s\S]*if \(enterprisePublicStateRefreshPromise\)[\s\S]*return enterprisePublicStateRefreshPromise[\s\S]*enterprisePublicStateRefreshPromise = refresh/
  )
  assert.match(main, /mainWindow\.webContents\.send\('hermes:enterprise:state', state\)/)
  assert.match(
    main,
    /ipcMain\.handle\('hermes:enterprise:status',[\s\S]*state === 'recovering' && !state\.authenticated[\s\S]*status: 'loading'[\s\S]*return state/
  )
  const statusStart = main.indexOf("ipcMain.handle('hermes:enterprise:status'")
  const statusEnd = main.indexOf("ipcMain.handle('hermes:enterprise:lifecycle-status'", statusStart)
  assert.doesNotMatch(main.slice(statusStart, statusEnd), /refreshEnterprisePublicStateAndEnforceLifecycle/)
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
    /enterpriseQuitCleanupPromise = Promise\.all\(\[[\s\S]*enterpriseWeComBotController\.dispose\(\)[\s\S]*enterpriseWeComRelay\.stop\(\)[\s\S]*\.then\(\(\) => stopBackendsForQuit\(\)\)/
  )
  assert.match(main, /async function stopBackendsForQuit\(\) \{[\s\S]*enterpriseBackendOwnership\.stopOwnedProcesses\(\)[\s\S]*enterpriseLifecycle\.revoke\(/)
})

test('completed binding hot-attaches without restarting the primary backend', () => {
  const controllerStart = main.indexOf('const enterpriseWeComBotController')
  const controllerEnd = main.indexOf('const enterpriseWeComGatewayRunnerExperiment', controllerStart)
  const controller = main.slice(controllerStart, controllerEnd)
  assert.match(controller, /onBindingCompleted: binding => \{[\s\S]*enterpriseWeComGatewayRunnerExperiment\.attach\(binding\)/)
  assert.doesNotMatch(controller, /teardownPrimaryBackendAndWait|startHermes/)
  assert.match(main, /enterpriseBackendOwnership\.bindChild\(ticket, child, \{[\s\S]*clearCurrent:[\s\S]*onExit:/)
  assert.match(main, /async function teardownPrimaryBackendAndWait\(\) \{[\s\S]*enterpriseBackendOwnership\.cancelStart\(ticket\)[\s\S]*enterpriseBackendOwnership\.stopOwners\(/)
  assert.doesNotMatch(main, /intentionallyStoppedHermesProcesses/)
  assert.match(main, /enterpriseWeComBotController\.applyRuntimeState\(runtimeState\)/)
})
