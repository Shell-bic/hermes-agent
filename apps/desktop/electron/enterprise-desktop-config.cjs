const fs = require('node:fs')
const path = require('node:path')

const { normalizeEnterpriseGatewayBaseUrl } = require('./enterprise-gateway-client.cjs')

const ENTERPRISE_DESKTOP_CONFIG_SCHEMA_VERSION = 1
const ENTERPRISE_DESKTOP_CONFIG_KEYS = new Set([
  'allowInsecureLanHttp',
  'enabled',
  'gatewayUrl',
  'schemaVersion',
  'weComGatewayRunnerExperiment'
])

function normalizeEnterpriseDesktopGatewayUrl(
  rawUrl,
  configPath = 'enterprise desktop config',
  { allowInsecureLanHttp = false } = {}
) {
  const value = String(rawUrl || '').trim()
  const normalized = normalizeEnterpriseGatewayBaseUrl(value, { allowInsecureLanHttp })
  const parsed = new URL(value)

  if (parsed.username || parsed.password) {
    throw new Error(`Enterprise desktop config ${configPath} gatewayUrl must not contain credentials.`)
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`Enterprise desktop config ${configPath} gatewayUrl must not contain a query or fragment.`)
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    throw new Error(`Enterprise desktop config ${configPath} gatewayUrl must be an origin without a path.`)
  }

  return normalized
}

function resolveEnterpriseDesktopConfigPaths({ executablePath, pathApi = path, programData, userDataPath } = {}) {
  const paths = []

  if (programData) {
    paths.push(pathApi.join(programData, 'Hermes', 'enterprise-desktop.json'))
  }
  if (executablePath) {
    paths.push(pathApi.join(pathApi.dirname(executablePath), 'enterprise-desktop.json'))
  }
  if (userDataPath) {
    paths.push(pathApi.join(userDataPath, 'enterprise', 'enterprise-desktop.json'))
  }

  return paths
}

function readEnterpriseDesktopConfig(configPath, { readFileSync = fs.readFileSync } = {}) {
  if (!configPath) {
    return null
  }

  let raw
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw new Error(`Unable to read enterprise desktop config ${configPath}: ${error.message}`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Enterprise desktop config ${configPath} is not valid JSON: ${error.message}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Enterprise desktop config ${configPath} must contain a JSON object.`)
  }

  const unknownKeys = Object.keys(parsed).filter(key => !ENTERPRISE_DESKTOP_CONFIG_KEYS.has(key))
  if (unknownKeys.length > 0) {
    throw new Error(
      `Enterprise desktop config ${configPath} contains unsupported fields: ${unknownKeys.join(', ')}. ` +
        'Only schemaVersion, enabled, gatewayUrl, allowInsecureLanHttp, and the internal experiment gate are allowed; ' +
        'enterprise credentials belong on the auth service.'
    )
  }

  const schemaVersion = parsed.schemaVersion ?? ENTERPRISE_DESKTOP_CONFIG_SCHEMA_VERSION
  if (schemaVersion !== ENTERPRISE_DESKTOP_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `Enterprise desktop config ${configPath} schemaVersion ${schemaVersion} is not supported; expected ` +
        `${ENTERPRISE_DESKTOP_CONFIG_SCHEMA_VERSION}.`
    )
  }

  if (parsed.enabled !== undefined && typeof parsed.enabled !== 'boolean') {
    throw new Error(`Enterprise desktop config ${configPath} field enabled must be a boolean.`)
  }
  if (parsed.gatewayUrl !== undefined && typeof parsed.gatewayUrl !== 'string') {
    throw new Error(`Enterprise desktop config ${configPath} field gatewayUrl must be a string.`)
  }
  if (parsed.allowInsecureLanHttp !== undefined && typeof parsed.allowInsecureLanHttp !== 'boolean') {
    throw new Error(`Enterprise desktop config ${configPath} field allowInsecureLanHttp must be a boolean.`)
  }
  if (parsed.weComGatewayRunnerExperiment !== undefined && typeof parsed.weComGatewayRunnerExperiment !== 'boolean') {
    throw new Error(
      `Enterprise desktop config ${configPath} field weComGatewayRunnerExperiment must be a boolean.`
    )
  }

  const rawGatewayUrl = String(parsed.gatewayUrl || '').trim()
  const allowInsecureLanHttp = parsed.allowInsecureLanHttp === true
  const gatewayUrl = rawGatewayUrl
    ? normalizeEnterpriseDesktopGatewayUrl(rawGatewayUrl, configPath, { allowInsecureLanHttp })
    : ''
  const enabled = parsed.enabled === true || gatewayUrl.length > 0
  if (enabled && !gatewayUrl) {
    throw new Error(`Enterprise desktop config ${configPath} enables enterprise mode but does not provide gatewayUrl.`)
  }

  return {
    enabled,
    gatewayUrl,
    ...(allowInsecureLanHttp ? { allowInsecureLanHttp: true } : {}),
    ...(parsed.weComGatewayRunnerExperiment === true ? { weComGatewayRunnerExperiment: true } : {})
  }
}

function loadEnterpriseDesktopConfig(configPaths, options) {
  return findEnterpriseDesktopConfig(configPaths, options).config
}

function findEnterpriseDesktopConfig(configPaths, options) {
  for (const configPath of configPaths || []) {
    const config = readEnterpriseDesktopConfig(configPath, options)
    if (config) {
      return { config, configPath }
    }
  }

  return { config: { enabled: false, gatewayUrl: '' }, configPath: null }
}

module.exports = {
  ENTERPRISE_DESKTOP_CONFIG_SCHEMA_VERSION,
  findEnterpriseDesktopConfig,
  loadEnterpriseDesktopConfig,
  normalizeEnterpriseDesktopGatewayUrl,
  resolveEnterpriseDesktopConfigPaths,
  readEnterpriseDesktopConfig
}
