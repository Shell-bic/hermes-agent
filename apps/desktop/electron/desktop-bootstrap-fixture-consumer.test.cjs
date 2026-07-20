const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  BODY_FILE_NAME,
  CONSUMER_MANIFEST_FILE_NAME,
  GATEWAY_MANIFEST_FILE_NAME,
  consumeDesktopBootstrapFixture,
  runCli,
  sha256
} = require('./desktop-bootstrap-fixture-consumer.cjs')

const SOURCE_FIXTURE = String(process.env.HERMES_DESKTOP_BOOTSTRAP_FIXTURE_DIR || '').trim()
const fixtureTest = SOURCE_FIXTURE ? test : test.skip

function temporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desktop-fixture-consumer-'))
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  return root
}

function fixtureCopy(t) {
  const root = temporaryDirectory(t)
  const fixture = path.join(root, 'fixture')
  const output = path.join(root, 'output')
  fs.cpSync(SOURCE_FIXTURE, fixture, { recursive: true })
  return { fixture, output }
}

function readManifest(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture, GATEWAY_MANIFEST_FILE_NAME), 'utf8'))
}

function writeManifest(fixture, manifest) {
  fs.writeFileSync(path.join(fixture, GATEWAY_MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`)
}

function rewriteBodyAndEvidence(fixture, bytes) {
  fs.writeFileSync(path.join(fixture, BODY_FILE_NAME), bytes)
  const manifest = readManifest(fixture)
  manifest.body.bytes = bytes.length
  manifest.body.sha256 = sha256(bytes)
  writeManifest(fixture, manifest)
}

async function rejectsWithCode(operation, expectedCode) {
  await assert.rejects(operation, error => {
    assert.equal(error?.code, expectedCode)
    return true
  })
}

async function cliFailsWithCode(fixture, output, expectedCode) {
  const stdout = []
  const stderr = []
  const exitCode = await runCli(['--fixture-directory', fixture, '--output-directory', output], {
    stdout: { write: value => stdout.push(value) },
    stderr: { write: value => stderr.push(value) }
  })

  assert.equal(exitCode, 1)
  assert.deepEqual(stdout, [])
  assert.deepEqual(stderr, [`FAIL ${expectedCode}\n`])
}

test('CLI returns NOT_RUN 2 for incomplete arguments without exposing a path', async () => {
  const stdout = []
  const stderr = []
  const exitCode = await runCli(['--fixture-directory', 'private-path'], {
    stdout: { write: value => stdout.push(value) },
    stderr: { write: value => stderr.push(value) }
  })

  assert.equal(exitCode, 2)
  assert.deepEqual(stdout, [])
  assert.deepEqual(stderr, ['NOT_RUN fixture_consumer_arguments_invalid\n'])
})

fixtureTest(
  'real Gateway fixture is consumed through GatewayClient and EnterpriseRuntime with raw SHA continuity',
  async t => {
    const { fixture, output } = fixtureCopy(t)
    const events = []
    const result = await consumeDesktopBootstrapFixture({
      fixtureDirectory: fixture,
      onEvent: event => events.push(event),
      outputDirectory: output
    })
    const gatewayManifest = readManifest(fixture)
    const gatewayManifestBytes = fs.readFileSync(path.join(fixture, GATEWAY_MANIFEST_FILE_NAME))
    const consumerText = fs.readFileSync(path.join(output, CONSUMER_MANIFEST_FILE_NAME), 'utf8')
    const consumer = JSON.parse(consumerText)
    const rawBody = fs.readFileSync(path.join(fixture, BODY_FILE_NAME))
    const bootstrap = JSON.parse(rawBody.toString('utf8'))

    assert.equal(result.fixtureBodySha256, sha256(rawBody))
    assert.equal(result.fixtureBodySha256, gatewayManifest.body.sha256)
    assert.equal(consumer.fixture.body.sha256, gatewayManifest.body.sha256)
    assert.equal(consumer.fixture.evidence.sha256, sha256(gatewayManifestBytes))
    assert.equal(consumer.fixture.producer.gatewayAssemblyVersion, gatewayManifest.producer.gatewayAssemblyVersion)
    assert.equal(consumer.request.contractHeader.value, '2')
    assert.equal(consumer.runtime.contractValidatedBeforeDownstream, true)
    assert.deepEqual(consumer.runtime.downstreamSequence, ['model-profiles', 'runtime-manifest', 'home-writer'])
    assert.equal(consumer.runtime.homeWriterCalls, 1)
    assert.deepEqual(
      events.map(event => event.kind),
      ['bootstrap', 'model-profiles', 'runtime-manifest', 'home-writer']
    )
    assert.doesNotMatch(consumerText, /dsk_[A-Za-z0-9._~-]+/)
    assert.equal(consumerText.includes(path.resolve(fixture)), false)
    assert.equal(consumerText.includes(path.resolve(output)), false)
    const userName = String(bootstrap?.user?.userName || bootstrap?.user?.username || '').trim()
    if (userName) assert.equal(consumerText.includes(userName), false)
  }
)

fixtureTest('CLI returns PASS 0 with only reproducible hashes and no private paths', async t => {
  const { fixture, output } = fixtureCopy(t)
  const stdout = []
  const stderr = []
  const exitCode = await runCli(['--output-directory', output, '--fixture-directory', fixture], {
    stdout: { write: value => stdout.push(value) },
    stderr: { write: value => stderr.push(value) }
  })

  assert.equal(exitCode, 0)
  assert.deepEqual(stderr, [])
  assert.match(
    stdout.join(''),
    /^PASS desktop-bootstrap-v2\.consumer\.json fixture_sha256=[a-f0-9]{64} consumer_sha256=[a-f0-9]{64}\n$/
  )
  assert.equal(stdout.join('').includes(path.resolve(fixture)), false)
  assert.equal(stdout.join('').includes(path.resolve(output)), false)
})

fixtureTest('SHA tamper fails closed before runtime and leaves no PASS report', async t => {
  const { fixture, output } = fixtureCopy(t)
  const manifest = readManifest(fixture)
  manifest.body.sha256 = '0'.repeat(64)
  writeManifest(fixture, manifest)

  await rejectsWithCode(
    () => consumeDesktopBootstrapFixture({ fixtureDirectory: fixture, outputDirectory: output }),
    'fixture_body_sha256_mismatch'
  )
  await cliFailsWithCode(fixture, output, 'fixture_body_sha256_mismatch')
  assert.equal(fs.existsSync(path.join(output, CONSUMER_MANIFEST_FILE_NAME)), false)
})

fixtureTest('a stale PASS is removed before a bad fixture is rejected', async t => {
  const { fixture, output } = fixtureCopy(t)
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, CONSUMER_MANIFEST_FILE_NAME), '{"status":"PASS"}\n')
  const manifest = readManifest(fixture)
  manifest.body.sha256 = '0'.repeat(64)
  writeManifest(fixture, manifest)

  await rejectsWithCode(
    () => consumeDesktopBootstrapFixture({ fixtureDirectory: fixture, outputDirectory: output }),
    'fixture_body_sha256_mismatch'
  )
  assert.equal(fs.existsSync(path.join(output, CONSUMER_MANIFEST_FILE_NAME)), false)
})

fixtureTest('an undeletable stale evidence path fails with one stable code before fixture consumption', async t => {
  const { fixture, output } = fixtureCopy(t)
  const stalePath = path.join(output, CONSUMER_MANIFEST_FILE_NAME)
  fs.mkdirSync(stalePath, { recursive: true })

  await rejectsWithCode(
    () => consumeDesktopBootstrapFixture({ fixtureDirectory: fixture, outputDirectory: output }),
    'fixture_stale_consumer_manifest_remove_failed'
  )
})

fixtureTest('missing Vary contract header fails strict evidence validation', async t => {
  const { fixture, output } = fixtureCopy(t)
  const manifest = readManifest(fixture)
  manifest.response.headers.vary = []
  writeManifest(fixture, manifest)

  await rejectsWithCode(
    () => consumeDesktopBootstrapFixture({ fixtureDirectory: fixture, outputDirectory: output }),
    'fixture_manifest_headers_invalid'
  )
  await cliFailsWithCode(fixture, output, 'fixture_manifest_headers_invalid')
})

fixtureTest('unknown or duplicate response contract headers fail strict evidence validation', async t => {
  for (const contract of [
    [{ name: 'X-Unknown-Contract', values: ['2'] }],
    [
      { name: 'X-Hermes-Desktop-Bootstrap-Contract', values: ['2'] },
      { name: 'X-Hermes-Desktop-Bootstrap-Contract', values: ['2'] }
    ]
  ]) {
    const { fixture, output } = fixtureCopy(t)
    const manifest = readManifest(fixture)
    manifest.response.headers.contract = contract
    writeManifest(fixture, manifest)
    await cliFailsWithCode(fixture, output, 'fixture_manifest_headers_invalid')
  }
})

fixtureTest('body v1 reaches real Desktop contract validation before profiles manifest or home writing', async t => {
  const { fixture, output } = fixtureCopy(t)
  const bootstrap = JSON.parse(fs.readFileSync(path.join(fixture, BODY_FILE_NAME), 'utf8'))
  bootstrap.bootstrapContractVersion = 1
  rewriteBodyAndEvidence(fixture, Buffer.from(JSON.stringify(bootstrap), 'utf8'))
  const events = []

  await rejectsWithCode(
    () =>
      consumeDesktopBootstrapFixture({
        fixtureDirectory: fixture,
        onEvent: event => events.push(event),
        outputDirectory: output
      }),
    'fixture_runtime_bootstrap_rejected'
  )
  assert.deepEqual(
    events.map(event => event.kind),
    ['bootstrap']
  )
  await cliFailsWithCode(fixture, output, 'fixture_runtime_bootstrap_rejected')
})

fixtureTest('damaged raw body is not repaired or reserialized before real Desktop validation', async t => {
  const { fixture, output } = fixtureCopy(t)
  rewriteBodyAndEvidence(fixture, Buffer.from('{"bootstrapContractVersion":', 'utf8'))
  const events = []

  await rejectsWithCode(
    () =>
      consumeDesktopBootstrapFixture({
        fixtureDirectory: fixture,
        onEvent: event => events.push(event),
        outputDirectory: output
      }),
    'fixture_runtime_bootstrap_rejected'
  )
  assert.deepEqual(
    events.map(event => event.kind),
    ['bootstrap']
  )
  await cliFailsWithCode(fixture, output, 'fixture_runtime_bootstrap_rejected')
})

fixtureTest('unknown manifest fields are rejected by the frozen evidence schema', async t => {
  const { fixture, output } = fixtureCopy(t)
  const manifest = readManifest(fixture)
  manifest.unexpected = true
  writeManifest(fixture, manifest)

  await rejectsWithCode(
    () => consumeDesktopBootstrapFixture({ fixtureDirectory: fixture, outputDirectory: output }),
    'fixture_manifest_schema_invalid'
  )
  await cliFailsWithCode(fixture, output, 'fixture_manifest_schema_invalid')
})

fixtureTest('CLI returns FAIL 1 with a stable code and no token username or absolute path', async t => {
  const { fixture, output } = fixtureCopy(t)
  const manifest = readManifest(fixture)
  manifest.response.statusCode = 401
  writeManifest(fixture, manifest)
  const stdout = []
  const stderr = []

  const exitCode = await runCli(['--fixture-directory', fixture, '--output-directory', output], {
    stdout: { write: value => stdout.push(value) },
    stderr: { write: value => stderr.push(value) }
  })

  assert.equal(exitCode, 1)
  assert.deepEqual(stdout, [])
  assert.deepEqual(stderr, ['FAIL fixture_manifest_response_invalid\n'])
  assert.equal(stderr.join('').includes(path.resolve(fixture)), false)
})
