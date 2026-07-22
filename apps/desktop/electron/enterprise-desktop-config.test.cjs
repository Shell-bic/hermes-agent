const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  loadEnterpriseDesktopConfig,
  readEnterpriseDesktopConfig,
  resolveEnterpriseDesktopConfigPaths
} = require('./enterprise-desktop-config.cjs')

function reader(files) {
  return filePath => {
    if (!Object.prototype.hasOwnProperty.call(files, filePath)) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    return files[filePath]
  }
}

test('enterprise desktop config loads the first machine or portable configuration', () => {
  const config = loadEnterpriseDesktopConfig(['machine.json', 'portable.json'], {
    readFileSync: reader({
      'machine.json': JSON.stringify({ schemaVersion: 1, enabled: true, gatewayUrl: 'https://gateway.example.com' }),
      'portable.json': JSON.stringify({ schemaVersion: 1, enabled: true, gatewayUrl: 'https://ignored.example.com' })
    })
  })

  assert.deepEqual(config, { enabled: true, gatewayUrl: 'https://gateway.example.com' })
})

test('enterprise desktop config allows local HTTP for workstation rehearsal', () => {
  const config = readEnterpriseDesktopConfig('desktop.json', {
    readFileSync: reader({
      'desktop.json': JSON.stringify({ schemaVersion: 1, gatewayUrl: 'http://127.0.0.1:5100' })
    })
  })

  assert.deepEqual(config, { enabled: true, gatewayUrl: 'http://127.0.0.1:5100' })
})

test('enterprise desktop config allows private IP HTTP only behind the explicit deployment gate', () => {
  const config = readEnterpriseDesktopConfig('desktop.json', {
    readFileSync: reader({
      'desktop.json': JSON.stringify({
        allowInsecureLanHttp: true,
        schemaVersion: 1,
        gatewayUrl: 'http://172.31.1.49:6500'
      })
    })
  })

  assert.deepEqual(config, {
    allowInsecureLanHttp: true,
    enabled: true,
    gatewayUrl: 'http://172.31.1.49:6500'
  })
  assert.throws(
    () => readEnterpriseDesktopConfig('desktop.json', {
      readFileSync: reader({
        'desktop.json': JSON.stringify({
          allowInsecureLanHttp: true,
          gatewayUrl: 'http://8.8.8.8:6500'
        })
      })
    }),
    /must use https/
  )
})

test('enterprise desktop config requires an explicit GatewayRunner opt-in from the selected config', () => {
  const disabled = readEnterpriseDesktopConfig('desktop.json', {
    readFileSync: reader({
      'desktop.json': JSON.stringify({ schemaVersion: 1, gatewayUrl: 'https://gateway.example.com' })
    })
  })
  const enabled = readEnterpriseDesktopConfig('desktop.json', {
    readFileSync: reader({
      'desktop.json': JSON.stringify({
        schemaVersion: 1,
        gatewayUrl: 'https://gateway.example.com',
        weComGatewayRunnerExperiment: true
      })
    })
  })

  assert.equal(disabled.weComGatewayRunnerExperiment, undefined)
  assert.equal(enabled.weComGatewayRunnerExperiment, true)
  assert.throws(
    () => readEnterpriseDesktopConfig('desktop.json', {
      readFileSync: reader({
        'desktop.json': JSON.stringify({
          gatewayUrl: 'https://gateway.example.com',
          weComGatewayRunnerExperiment: 'yes'
        })
      })
    }),
    /weComGatewayRunnerExperiment must be a boolean/
  )
})

test('enterprise desktop config normalizes the configured HTTPS origin', () => {
  const config = readEnterpriseDesktopConfig('desktop.json', {
    readFileSync: reader({
      'desktop.json': JSON.stringify({ schemaVersion: 1, gatewayUrl: '  https://gateway.example.com:8443/  ' })
    })
  })

  assert.deepEqual(config, { enabled: true, gatewayUrl: 'https://gateway.example.com:8443' })
})

test('enterprise desktop config rejects insecure non-loopback HTTP and ambiguous URLs', () => {
  for (const [gatewayUrl, message] of [
    ['http://10.0.0.5:5100', /must use https/],
    ['https://user:password@gateway.example.com', /must not contain credentials/],
    ['https://gateway.example.com?tenant=one', /must not contain a query or fragment/],
    ['https://gateway.example.com#login', /must not contain a query or fragment/],
    ['https://gateway.example.com/wecom', /must be an origin without a path/]
  ]) {
    assert.throws(
      () =>
        readEnterpriseDesktopConfig('desktop.json', {
          readFileSync: reader({ 'desktop.json': JSON.stringify({ schemaVersion: 1, gatewayUrl }) })
        }),
      message,
      gatewayUrl
    )
  }
})

test('enterprise desktop config path order keeps the bundled default last', () => {
  assert.deepEqual(
    resolveEnterpriseDesktopConfigPaths({
      bundledConfigPath: 'D:\\Hermes\\resources\\enterprise\\enterprise-desktop.json',
      executablePath: 'D:\\Hermes\\Hermes.exe',
      programData: 'C:\\ProgramData',
      userDataPath: 'C:\\Users\\Ada\\AppData\\Roaming\\Hermes'
    }),
    [
      'C:\\ProgramData\\Hermes\\enterprise-desktop.json',
      'D:\\Hermes\\enterprise-desktop.json',
      'C:\\Users\\Ada\\AppData\\Roaming\\Hermes\\enterprise\\enterprise-desktop.json',
      'D:\\Hermes\\resources\\enterprise\\enterprise-desktop.json'
    ]
  )
})

test('enterprise desktop config falls back to a bundled deployment default', () => {
  const config = loadEnterpriseDesktopConfig(
    ['machine.json', 'portable.json', 'user.json', 'bundled.json'],
    {
      readFileSync: reader({
        'bundled.json': JSON.stringify({
          allowInsecureLanHttp: true,
          enabled: true,
          gatewayUrl: 'http://172.31.1.49:6500',
          schemaVersion: 1,
          weComGatewayRunnerExperiment: true
        })
      })
    }
  )

  assert.deepEqual(config, {
    allowInsecureLanHttp: true,
    enabled: true,
    gatewayUrl: 'http://172.31.1.49:6500',
    weComGatewayRunnerExperiment: true
  })
})

test('packaged enterprise deployment default enables one-click Desktop-hosted WeCom runtime', () => {
  const configPath = path.resolve(__dirname, '..', 'deployment', 'enterprise', 'enterprise-desktop.default.json')

  assert.deepEqual(readEnterpriseDesktopConfig(configPath, { readFileSync: fs.readFileSync }), {
    allowInsecureLanHttp: true,
    enabled: true,
    gatewayUrl: 'http://172.31.1.49:6500',
    weComGatewayRunnerExperiment: true
  })
})

test('enterprise desktop config paths omit unavailable machine config on non-Windows hosts', () => {
  assert.deepEqual(
    resolveEnterpriseDesktopConfigPaths({
      executablePath: '/opt/hermes/Hermes',
      pathApi: path.posix,
      userDataPath: '/home/ada/.config/Hermes'
    }),
    ['/opt/hermes/enterprise-desktop.json', '/home/ada/.config/Hermes/enterprise/enterprise-desktop.json']
  )
  assert.deepEqual(resolveEnterpriseDesktopConfigPaths(), [])
})

test('enterprise desktop config rejects credential fields', () => {
  assert.throws(
    () =>
      readEnterpriseDesktopConfig('desktop.json', {
        readFileSync: reader({
          'desktop.json': JSON.stringify({ gatewayUrl: 'https://gateway.example.com', corpSecret: 'must-not-be-here' })
        })
      }),
    /unsupported fields: corpSecret.*credentials belong on the auth service/
  )
})

test('enterprise desktop config rejects invalid JSON and incomplete enabled config', () => {
  assert.throws(
    () => readEnterpriseDesktopConfig('desktop.json', { readFileSync: reader({ 'desktop.json': '{' }) }),
    /not valid JSON/
  )
  assert.throws(
    () =>
      readEnterpriseDesktopConfig('desktop.json', {
        readFileSync: reader({ 'desktop.json': JSON.stringify({ schemaVersion: 1, enabled: true }) })
      }),
    /does not provide gatewayUrl/
  )
  assert.throws(
    () => readEnterpriseDesktopConfig('desktop.json', {
      readFileSync: reader({
        'desktop.json': JSON.stringify({
          allowInsecureLanHttp: 'yes',
          gatewayUrl: 'https://gateway.example.com'
        })
      })
    }),
    /allowInsecureLanHttp must be a boolean/
  )
})
