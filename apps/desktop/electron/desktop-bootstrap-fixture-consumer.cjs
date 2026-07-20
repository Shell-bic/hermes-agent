const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  DESKTOP_BOOTSTRAP_CONTRACT_HEADER,
  DESKTOP_BOOTSTRAP_CONTRACT_VERSION,
  createEnterpriseGatewayClient
} = require('./enterprise-gateway-client.cjs')
const { createEnterpriseRuntime } = require('./enterprise-runtime.cjs')

const BODY_FILE_NAME = 'desktop-bootstrap-v2.response.json'
const GATEWAY_MANIFEST_FILE_NAME = 'desktop-bootstrap-v2.evidence.json'
const CONSUMER_MANIFEST_FILE_NAME = 'desktop-bootstrap-v2.consumer.json'
const FIXTURE_SCHEMA_VERSION = 1
const CONSUMER_SCHEMA_VERSION = 1

class DesktopBootstrapFixtureConsumerError extends Error {
  constructor(code, cause) {
    super(code, cause ? { cause } : undefined)
    this.name = 'DesktopBootstrapFixtureConsumerError'
    this.code = code
  }
}

function failure(code, cause) {
  return new DesktopBootstrapFixtureConsumerError(code, cause)
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function exactObject(value, keys, code = 'fixture_manifest_schema_invalid') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure(code)
  }

  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw failure(code)
  }

  return value
}

function nonEmptyString(value, code = 'fixture_manifest_schema_invalid') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw failure(code)
  }
  return value
}

function validateStringArray(value) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    throw failure('fixture_manifest_schema_invalid')
  }
  return value
}

function validateGatewayManifest(value) {
  const manifest = exactObject(value, ['schemaVersion', 'status', 'producer', 'request', 'response', 'body'])
  const producer = exactObject(manifest.producer, ['kind', 'gatewayAssemblyVersion'])
  const request = exactObject(manifest.request, ['method', 'path', 'contractVersion'])
  const response = exactObject(manifest.response, ['statusCode', 'contractVersion', 'headers'])
  const headers = exactObject(response.headers, ['contentType', 'cacheControl', 'vary', 'contract'])
  const body = exactObject(manifest.body, ['file', 'bytes', 'sha256'])

  if (manifest.schemaVersion !== FIXTURE_SCHEMA_VERSION || manifest.status !== 'PASS') {
    throw failure('fixture_manifest_status_invalid')
  }
  if (producer.kind !== 'EnterpriseGatewayWebApplicationFactory') {
    throw failure('fixture_manifest_producer_invalid')
  }
  const gatewayAssemblyVersion = nonEmptyString(producer.gatewayAssemblyVersion, 'fixture_manifest_producer_invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(gatewayAssemblyVersion)) {
    throw failure('fixture_manifest_producer_invalid')
  }
  if (
    request.method !== 'GET' ||
    request.path !== '/api/desktop/bootstrap' ||
    request.contractVersion !== DESKTOP_BOOTSTRAP_CONTRACT_VERSION
  ) {
    throw failure('fixture_manifest_request_invalid')
  }
  if (response.statusCode !== 200 || response.contractVersion !== DESKTOP_BOOTSTRAP_CONTRACT_VERSION) {
    throw failure('fixture_manifest_response_invalid')
  }

  const contentType = nonEmptyString(headers.contentType, 'fixture_manifest_headers_invalid')
  if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw failure('fixture_manifest_headers_invalid')
  }
  const cacheControl = nonEmptyString(headers.cacheControl, 'fixture_manifest_headers_invalid')
  if (
    !cacheControl
      .split(',')
      .map(item => item.trim().toLowerCase())
      .includes('no-store')
  ) {
    throw failure('fixture_manifest_headers_invalid')
  }
  const vary = validateStringArray(headers.vary)
  if (!vary.some(item => item.toLowerCase() === DESKTOP_BOOTSTRAP_CONTRACT_HEADER.toLowerCase())) {
    throw failure('fixture_manifest_headers_invalid')
  }
  if (!Array.isArray(headers.contract)) {
    throw failure('fixture_manifest_schema_invalid')
  }
  if (headers.contract.length > 1) {
    throw failure('fixture_manifest_headers_invalid')
  }
  for (const entry of headers.contract) {
    const contractHeader = exactObject(entry, ['name', 'values'])
    nonEmptyString(contractHeader.name)
    validateStringArray(contractHeader.values)
    if (
      contractHeader.name.toLowerCase() !== DESKTOP_BOOTSTRAP_CONTRACT_HEADER.toLowerCase() ||
      contractHeader.values.length !== 1 ||
      contractHeader.values[0] !== String(DESKTOP_BOOTSTRAP_CONTRACT_VERSION)
    ) {
      throw failure('fixture_manifest_headers_invalid')
    }
  }

  if (
    body.file !== BODY_FILE_NAME ||
    !Number.isSafeInteger(body.bytes) ||
    body.bytes < 0 ||
    typeof body.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.sha256)
  ) {
    throw failure('fixture_manifest_body_invalid')
  }

  return manifest
}

function readRegularFile(filePath, missingCode) {
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch (error) {
    throw failure(missingCode, error)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw failure(missingCode)
  }
  try {
    return fs.readFileSync(filePath)
  } catch (error) {
    throw failure(missingCode, error)
  }
}

function readFixture(fixtureDirectory) {
  const root = path.resolve(nonEmptyString(fixtureDirectory, 'fixture_directory_required'))
  const manifestBytes = readRegularFile(path.join(root, GATEWAY_MANIFEST_FILE_NAME), 'fixture_manifest_unavailable')
  let parsedManifest
  try {
    parsedManifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch (error) {
    throw failure('fixture_manifest_json_invalid', error)
  }
  const manifest = validateGatewayManifest(parsedManifest)
  const bodyBytes = readRegularFile(path.join(root, manifest.body.file), 'fixture_body_unavailable')
  const bodySha256 = sha256(bodyBytes)

  if (bodyBytes.length !== manifest.body.bytes) {
    throw failure('fixture_body_bytes_mismatch')
  }
  if (!crypto.timingSafeEqual(Buffer.from(bodySha256, 'ascii'), Buffer.from(manifest.body.sha256, 'ascii'))) {
    throw failure('fixture_body_sha256_mismatch')
  }

  return {
    bodyBytes,
    bodySha256,
    manifest,
    manifestSha256: sha256(manifestBytes)
  }
}

function jsonResponse(value, { method = 'GET', status = 200 } = {}) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    status: method === 'HEAD' ? 204 : status
  })
}

function responseHeadersFromManifest(manifest) {
  const headers = new Headers({
    'Cache-Control': manifest.response.headers.cacheControl,
    'Content-Type': manifest.response.headers.contentType,
    Vary: manifest.response.headers.vary.join(', ')
  })
  for (const entry of manifest.response.headers.contract) {
    headers.set(entry.name, entry.values.join(', '))
  }
  return headers
}

function createFixtureTransport(fixture, recordEvent) {
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl)
    const method = String(options.method || 'GET').toUpperCase()

    if (url.pathname === '/api/desktop/bootstrap') {
      const requestHeaders = new Headers(options.headers || {})
      const contractHeader = requestHeaders.get(DESKTOP_BOOTSTRAP_CONTRACT_HEADER)
      recordEvent({ contractHeader, kind: 'bootstrap', method })
      return new Response(Uint8Array.from(fixture.bodyBytes), {
        headers: responseHeadersFromManifest(fixture.manifest),
        status: fixture.manifest.response.statusCode
      })
    }
    if (url.pathname === '/api/desktop/model-profiles') {
      recordEvent({ kind: 'model-profiles', method })
      return jsonResponse({ modelProfiles: [] }, { method })
    }
    if (url.pathname === '/api/desktop/runtime/manifests') {
      recordEvent({ kind: 'runtime-manifest', method })
      return jsonResponse({}, { method })
    }

    recordEvent({ kind: 'unexpected', method })
    return jsonResponse({ code: 'not-found' }, { status: 404 })
  }
}

function safeDelete(filePath) {
  try {
    fs.rmSync(filePath, { force: true })
  } catch {
    // A failed cleanup must not replace the stable consumer outcome.
  }
}

function deleteStaleConsumerManifest(filePath) {
  try {
    fs.rmSync(filePath, { force: true })
  } catch (error) {
    throw failure('fixture_stale_consumer_manifest_remove_failed', error)
  }
  if (fs.existsSync(filePath)) {
    throw failure('fixture_stale_consumer_manifest_remove_failed')
  }
}

function writeConsumerManifest(outputDirectory, report) {
  const root = path.resolve(nonEmptyString(outputDirectory, 'fixture_output_directory_required'))
  fs.mkdirSync(root, { recursive: true })
  const finalPath = path.join(root, CONSUMER_MANIFEST_FILE_NAME)
  const temporaryPath = path.join(root, `.${CONSUMER_MANIFEST_FILE_NAME}.${crypto.randomUUID()}.tmp`)
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
  try {
    fs.writeFileSync(temporaryPath, bytes, { flag: 'wx' })
    fs.renameSync(temporaryPath, finalPath)
  } catch (error) {
    safeDelete(temporaryPath)
    throw failure('fixture_consumer_manifest_write_failed', error)
  }
  return { path: finalPath, sha256: sha256(bytes) }
}

async function consumeDesktopBootstrapFixture({ fixtureDirectory, onEvent, outputDirectory } = {}) {
  const outputRoot = path.resolve(nonEmptyString(outputDirectory, 'fixture_output_directory_required'))
  const outputPath = path.join(outputRoot, CONSUMER_MANIFEST_FILE_NAME)
  deleteStaleConsumerManifest(outputPath)

  const fixture = readFixture(fixtureDirectory)
  const events = []
  const recordEvent = event => {
    const snapshot = Object.freeze({ ...event })
    events.push(snapshot)
    if (typeof onEvent === 'function') onEvent(snapshot)
  }
  let homeWriterCalls = 0
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://fixture.invalid',
    fetchImpl: createFixtureTransport(fixture, recordEvent)
  })
  const runtime = createEnterpriseRuntime({
    authStore: {
      readSession: () => ({ desktopToken: 'dsk_fixture_consumer' })
    },
    client,
    enabled: true,
    managedHermesHome: 'fixture-managed-home',
    homeWriter: () => {
      homeWriterCalls += 1
      recordEvent({ kind: 'home-writer' })
      return {
        env: {},
        hermesHome: 'fixture-managed-home',
        publicState: { authenticated: true, enabled: true, status: 'authenticated' }
      }
    }
  })

  try {
    await runtime.prepareLaunch()
  } catch {
    if (events.length === 1 && events[0].kind === 'bootstrap' && homeWriterCalls === 0) {
      throw failure('fixture_runtime_bootstrap_rejected')
    }
    throw failure('fixture_runtime_consumption_failed')
  }

  const eventKinds = events.map(event => event.kind)
  const bootstrapEvent = events.find(event => event.kind === 'bootstrap')
  if (
    bootstrapEvent?.method !== 'GET' ||
    bootstrapEvent?.contractHeader !== String(DESKTOP_BOOTSTRAP_CONTRACT_VERSION) ||
    eventKinds.join('\0') !== ['bootstrap', 'model-profiles', 'runtime-manifest', 'home-writer'].join('\0') ||
    homeWriterCalls !== 1
  ) {
    throw failure('fixture_runtime_sequence_invalid')
  }

  const report = Object.freeze({
    schemaVersion: CONSUMER_SCHEMA_VERSION,
    status: 'PASS',
    consumer: {
      kind: 'HermesDesktopEnterpriseRuntime',
      bootstrapContractVersion: DESKTOP_BOOTSTRAP_CONTRACT_VERSION
    },
    fixture: {
      evidence: {
        file: GATEWAY_MANIFEST_FILE_NAME,
        schemaVersion: fixture.manifest.schemaVersion,
        sha256: fixture.manifestSha256
      },
      producer: {
        gatewayAssemblyVersion: fixture.manifest.producer.gatewayAssemblyVersion,
        kind: fixture.manifest.producer.kind
      },
      body: {
        file: BODY_FILE_NAME,
        bytes: fixture.bodyBytes.length,
        sha256: fixture.bodySha256
      }
    },
    request: {
      method: bootstrapEvent.method,
      path: '/api/desktop/bootstrap',
      contractHeader: {
        name: DESKTOP_BOOTSTRAP_CONTRACT_HEADER,
        value: bootstrapEvent.contractHeader
      }
    },
    runtime: {
      contractValidatedBeforeDownstream: true,
      downstreamSequence: ['model-profiles', 'runtime-manifest', 'home-writer'],
      homeWriterCalls
    }
  })
  const written = writeConsumerManifest(outputRoot, report)

  return {
    consumerManifestPath: written.path,
    consumerManifestSha256: written.sha256,
    fixtureBodySha256: fixture.bodySha256,
    report
  }
}

function parseCliArguments(args) {
  if (!Array.isArray(args) || args.length !== 4) return null
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (
      !['--fixture-directory', '--output-directory'].includes(key) ||
      values.has(key) ||
      !String(value || '').trim()
    ) {
      return null
    }
    values.set(key, value)
  }
  if (!values.has('--fixture-directory') || !values.has('--output-directory')) return null
  return {
    fixtureDirectory: values.get('--fixture-directory'),
    outputDirectory: values.get('--output-directory')
  }
}

async function runCli(args, { stderr = process.stderr, stdout = process.stdout } = {}) {
  const options = parseCliArguments(args)
  if (!options) {
    stderr.write('NOT_RUN fixture_consumer_arguments_invalid\n')
    return 2
  }

  try {
    const result = await consumeDesktopBootstrapFixture(options)
    stdout.write(
      `PASS ${CONSUMER_MANIFEST_FILE_NAME} fixture_sha256=${result.fixtureBodySha256} consumer_sha256=${result.consumerManifestSha256}\n`
    )
    return 0
  } catch (error) {
    const code = error instanceof DesktopBootstrapFixtureConsumerError ? error.code : 'fixture_consumer_failed'
    stderr.write(`FAIL ${code}\n`)
    return 1
  }
}

module.exports = {
  BODY_FILE_NAME,
  CONSUMER_MANIFEST_FILE_NAME,
  DesktopBootstrapFixtureConsumerError,
  GATEWAY_MANIFEST_FILE_NAME,
  consumeDesktopBootstrapFixture,
  parseCliArguments,
  readFixture,
  runCli,
  sha256,
  validateGatewayManifest
}
