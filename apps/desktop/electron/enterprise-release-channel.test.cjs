const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const read = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8')

test('enterprise release channel is the only install and update source authority', () => {
  const bootstrap = read('apps/desktop/electron/bootstrap-runner.cjs')
  const installerPs1 = read('scripts/install.ps1')
  const installerSh = read('scripts/install.sh')
  const cliMain = read('hermes_cli/main.py')
  const banner = read('hermes_cli/banner.py')

  assert.match(bootstrap, /raw\.githubusercontent\.com\/Shell-bic\/hermes-agent/)
  assert.match(installerPs1, /\$RepoUrlHttps = "https:\/\/github\.com\/Shell-bic\/hermes-agent\.git"/)
  assert.match(installerPs1, /remote set-url origin \$RepoUrlHttps[\s\S]*remote remove upstream/)
  assert.match(installerSh, /REPO_URL_HTTPS="https:\/\/github\.com\/Shell-bic\/hermes-agent\.git"/)
  assert.match(installerSh, /remote set-url origin "\$REPO_URL_HTTPS"[\s\S]*remote remove upstream/)
  assert.match(cliMain, /OFFICIAL_REPO_URL = "https:\/\/github\.com\/Shell-bic\/hermes-agent\.git"/)
  assert.match(cliMain, /if is_enterprise_managed\(\):[\s\S]*managed by the enterprise release channel/)
  assert.match(banner, /_UPSTREAM_REPO_URL = "https:\/\/github\.com\/Shell-bic\/hermes-agent\.git"/)
  assert.match(banner, /if is_enterprise_managed\(\):\s*return None/)

  assert.doesNotMatch(bootstrap, /NousResearch\/hermes-agent/)
  assert.doesNotMatch(installerPs1, /NousResearch\/hermes-agent/)
  assert.doesNotMatch(installerSh, /NousResearch\/hermes-agent/)
})

test('enterprise desktop disables in-place updates but keeps stamped first-launch bootstrap', () => {
  const desktopMain = read('apps/desktop/electron/main.cjs')

  assert.match(
    desktopMain,
    /const ENTERPRISE_LOCAL_UPDATES_DISABLED =[\s\S]*ENTERPRISE_RUNTIME_OPTIONS\.enabled/
  )
  assert.match(
    desktopMain,
    /async function checkUpdates\(\) \{[\s\S]*enterprise-managed-update-disabled/
  )
  assert.match(
    desktopMain,
    /async function handOffWindowsBootstrapRecovery\(reason\) \{[\s\S]*ENTERPRISE_LOCAL_UPDATES_DISABLED/
  )
  assert.match(
    desktopMain,
    /if \(backend\.kind === 'bootstrap-needed'\) \{[\s\S]*runBootstrap/
  )
})

test('desktop package and Python runtime publish the same semantic version', () => {
  const desktopPackage = JSON.parse(read('apps/desktop/package.json'))
  const pyproject = read('pyproject.toml')
  const runtimeVersion = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1]

  assert.equal(desktopPackage.version, runtimeVersion)
})

test('enterprise Windows package embeds the one-click LAN Gateway and WeCom runtime defaults', () => {
  const desktopPackage = JSON.parse(read('apps/desktop/package.json'))
  const deploymentConfig = JSON.parse(read('apps/desktop/deployment/enterprise/enterprise-desktop.default.json'))
  const desktopMain = read('apps/desktop/electron/main.cjs')

  assert.ok(
    desktopPackage.build.extraResources.some(resource =>
      resource.from === 'deployment/enterprise/enterprise-desktop.default.json' &&
      resource.to === 'enterprise/enterprise-desktop.json'
    )
  )
  assert.deepEqual(deploymentConfig, {
    allowInsecureLanHttp: true,
    enabled: true,
    gatewayUrl: 'http://172.31.1.49:6500',
    schemaVersion: 1,
    weComGatewayRunnerExperiment: true
  })
  assert.match(desktopMain, /app\.isPackaged[\s\S]*resourcesPath, 'enterprise', 'enterprise-desktop\.json'/)
  assert.match(
    desktopMain,
    /ENTERPRISE_RUNTIME_OPTIONS\.weComGatewayRunnerExperiment === true[\s\S]*desktopHostedRuntime: ENTERPRISE_WECOM_GATEWAY_RUNNER_ENABLED[\s\S]*enabled: ENTERPRISE_WECOM_GATEWAY_RUNNER_ENABLED/
  )
})
