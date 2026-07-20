const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  CASES,
  FIXED_REFS,
  FIXED_SYNTHETIC_USER_ID,
  GATEWAY_EXPORTER_REF,
  GATEWAY_EXPORTER_TREE,
  MAX_OWNED_TEMP_PATH_LENGTH,
  assertionIds,
  createProcessRunner,
  createOwnedTempEnvironment,
  cleanupOwnedTempRoot,
  createRollbackContext,
  createTransport,
  createAssertions,
  eventOrderMatches,
  executeOrdinaryPhase,
  executeRollbackPhase,
  exitCodeForAssertions,
  gatewayAssertionsMatch,
  loadGatewayFixture,
  makeShortTempRoot,
  managedHomeSnapshot,
  parseArguments,
  ownedTempOwner,
  prepareManifestForPublish,
  rollbackTransitionMatches,
  runRollbackSequence,
  runCli,
  runtimeMatches,
  safeCode,
  scanOutputFiles,
  sourceStatesEqual,
  transportEventsMatch,
  validateRunnerIdentity,
  validateRoots,
  writeRollbackHome,
  writeManifestLast
} = require('./x1-enterprise-bootstrap-matrix.cjs')

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111'

function tempDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `x1-matrix-${name}-`))
}

function removeDirectory(root) {
  fs.rmSync(root, { force: true, recursive: true })
}

function newRollbackContext(name) {
  const root = tempDirectory(name)
  const context = createRollbackContext(path.join(root, 'managed-home'), TEST_USER_ID)
  context.testRoot = root
  return context
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function advanceSyntheticState(context, step, version = 2) {
  const before = clone(context.state)
  const files = ['.env', 'config.yaml', 'enterprise-policy.json'].map((file, index) => ({
    file,
    bytes: 10 + index,
    sha256: digest(Buffer.from(`${step.id}:${file}`, 'utf8'))
  }))
  const policy = {
    enterpriseUserBinding: 'fixed-synthetic',
    enterpriseUserIdSha256: digest(Buffer.from(TEST_USER_ID, 'utf8')),
    manifestId: 'x1-manifest',
    policyVersion: 'x1-policy-v1'
  }
  context.state = {
    version,
    writeCount: before.writeCount + 1,
    identityBinding: 'fixed-synthetic',
    files,
    policy,
    hash: digest(Buffer.from(JSON.stringify({ files, policy }), 'utf8'))
  }
  return { before, after: clone(context.state) }
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function treeFingerprint(root) {
  const entries = []
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(current, entry.name)
      const relative = path.relative(root, target).replaceAll('\\', '/')
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink()) {
        entries.push(`link:${relative}:${fs.readlinkSync(target)}`)
      } else if (stat.isDirectory()) {
        entries.push(`dir:${relative}`)
        pending.push(target)
      } else if (stat.isFile()) {
        entries.push(`file:${relative}:${digest(fs.readFileSync(target))}`)
      }
    }
  }
  return digest(Buffer.from(entries.sort().join('\n'), 'utf8'))
}

function createFakeGitRoot(root, name) {
  const target = path.join(root, name)
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, '.git'), `gitdir: fixed-${name}\n`)
  fs.writeFileSync(path.join(target, 'marker.txt'), `fixed-${name}\n`)
  return target
}

function matrixEvidenceCount(root) {
  if (!fs.existsSync(root)) return 0
  let count = 0
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(target)
      else if (entry.isFile() && entry.name === 'x1-enterprise-bootstrap-matrix.evidence.json') count += 1
    }
  }
  return count
}

async function runMatrixCli({ desktop, gateway, output }) {
  let stderr = ''
  let stdout = ''
  const exitCode = await runCli([
    '--desktop-source-root', desktop,
    '--gateway-source-root', gateway,
    '--output-directory', output
  ], {
    stderr: { write: value => { stderr += value } },
    stdout: { write: value => { stdout += value } }
  })
  return { exitCode, stderr, stdout }
}

test('matrix pins the four approved refs and all required compatibility cases', () => {
  assert.deepEqual(FIXED_REFS, {
    gatewayP1: 'f17a6618fa848bc44fdee4396cd5f4a36c655413',
    gatewayP2: 'e4c2160f3c7002e95cedea25f306ce8a9f2f0ab6',
    desktopP1: '39b5be1c7e7ccf89fde91540d3e7e61c60d07186',
    desktopP2: '1622148f80de3c71f22df2a485da09c65c201911'
  })
  assert.equal(GATEWAY_EXPORTER_REF, '06b02773f7e3ec35cdf3737467b4c7839c148f20')
  assert.equal(GATEWAY_EXPORTER_TREE, 'f8e0551e1f642cb2aad05021c0d4669794d74993')
  assert.equal(FIXED_SYNTHETIC_USER_ID, '11111111-2222-4333-8444-555555555555')
  assert.deepEqual(
    CASES.slice(0, 6).map(item => item.id),
    [
      'p1-gateway-p1-desktop',
      'p1-gateway-p2-desktop',
      'p2-compatible-p1-desktop',
      'p2-compatible-p2-desktop',
      'p2-required-p1-desktop',
      'p2-required-p2-desktop'
    ]
  )
  assert.deepEqual(CASES.filter(item => item.rollbackStep).map(item => item.rollbackStep), [
    'required',
    'p2-compatible',
    'desktop-p1',
    'gateway-p1'
  ])
})

test('all assertions are pre-registered as NOT_RUN', () => {
  const assertions = createAssertions()
  assert.deepEqual(assertions.map(item => item.id), assertionIds())
  assert.ok(assertions.length > 7)
  assert.ok(assertions.every(item => item.status === 'NOT_RUN'))
})

test('CLI accepts exactly three explicit roots', () => {
  assert.deepEqual(
    parseArguments([
      '--desktop-source-root', 'desktop',
      '--gateway-source-root', 'gateway',
      '--output-directory', 'evidence'
    ]),
    {
      desktopSourceRoot: require('node:path').resolve('desktop'),
      gatewaySourceRoot: require('node:path').resolve('gateway'),
      outputDirectory: require('node:path').resolve('evidence')
    }
  )
  assert.equal(parseArguments(['--desktop-source-root', 'desktop']), null)
  assert.equal(parseArguments([
    '--desktop-source-root', 'desktop',
    '--gateway-source-root', 'gateway',
    '--gateway-source-root', 'duplicate'
  ]), null)
})

test('runtime outcome matching preserves explicit compatibility error codes', () => {
  const legacyRejected = CASES.find(item => item.id === 'p1-gateway-p2-desktop')
  assert.equal(runtimeMatches(legacyRejected, {
    succeeded: false,
    errorCode: 'enterprise_gateway_contract_too_old'
  }), true)
  assert.equal(runtimeMatches(legacyRejected, {
    succeeded: false,
    errorCode: 'desktop_runtime_failed'
  }), false)
})

test('arbitrary exception messages never enter stable evidence codes', () => {
  assert.equal(safeCode(new Error('C:\\private\\real-user\\secret')), 'matrix_operation_failed')
  assert.equal(safeCode({ code: 'gateway_evidence_invalid' }), 'gateway_evidence_invalid')
})

test('NOT_RUN and FAIL assertions always produce non-zero exits', async () => {
  assert.equal(exitCodeForAssertions(createAssertions()), 1)
  assert.equal(exitCodeForAssertions([{ id: 'x', status: 'FAIL' }]), 1)
  assert.equal(exitCodeForAssertions([{ id: 'x', status: 'PASS' }]), 0)
  assert.equal(exitCodeForAssertions([{ id: 'x', status: 'PASS' }], true), 130)
  let errorText = ''
  const code = await runCli([], {
    stderr: { write: value => { errorText += value } },
    stdout: { write: () => assert.fail('invalid CLI must not write PASS') }
  })
  assert.equal(code, 2)
  assert.equal(errorText, 'NOT_RUN x1_matrix_arguments_invalid\n')
})

test('success and failure event order is exact and fail closed', () => {
  const success = CASES.find(item => item.id === 'p2-compatible-p2-desktop')
  const p1Required = CASES.find(item => item.id === 'p2-required-p1-desktop')
  const p2Legacy = CASES.find(item => item.id === 'p1-gateway-p2-desktop')
  const event = kind => ({
    kind,
    ...({ bootstrap: { method: 'GET', auth: 'synthetic-bearer' },
      'model-profiles': { method: 'GET', auth: 'synthetic-bearer' },
      'runtime-manifest': { method: 'POST', auth: 'synthetic-bearer' } }[kind] || {})
  })
  const withEvents = eventOrder => ({ eventOrder, events: eventOrder.map(event) })
  assert.equal(eventOrderMatches(success, {
    ...withEvents(['bootstrap', 'model-profiles', 'runtime-manifest', 'identity-binding', 'home-writer'])
  }), true)
  assert.equal(eventOrderMatches(success,
    withEvents(['bootstrap', 'runtime-manifest', 'model-profiles', 'identity-binding', 'home-writer'])), false)
  assert.equal(eventOrderMatches(p1Required, withEvents(['bootstrap', 'model-profiles'])), true)
  assert.equal(eventOrderMatches(p1Required, withEvents(['bootstrap', 'model-profiles', 'home-writer'])), false)
  assert.equal(eventOrderMatches(p2Legacy, withEvents(['bootstrap'])), true)
  assert.equal(eventOrderMatches(p2Legacy, {
    eventOrder: ['bootstrap'],
    events: [{ kind: 'bootstrap', method: 'GET', auth: 'invalid' }]
  }), false)
})

test('synthetic transport requires the exact method, path and bearer without recording the token', async () => {
  const fixture = {
    bodyBytes: Buffer.from('{}', 'utf8'),
    evidence: { response: { headers: [], statusCode: 200 } }
  }
  const goodEvents = []
  const good = createTransport(fixture, goodEvents)
  const headers = { Authorization: 'Bearer dsk_x1_private_fixture' }
  assert.equal((await good('https://x1-fixture.invalid/api/desktop/bootstrap', { headers })).status, 200)
  assert.equal((await good('https://x1-fixture.invalid/api/desktop/model-profiles', { headers })).status, 200)
  assert.equal((await good('https://x1-fixture.invalid/api/desktop/runtime/manifests', {
    headers,
    method: 'POST'
  })).status, 200)
  assert.equal(transportEventsMatch(goodEvents), true)
  assert.ok(goodEvents.every(event => !JSON.stringify(event).includes('dsk_x1_private_fixture')))

  const invalidRequests = [
    ['missing bearer', '/api/desktop/bootstrap', { method: 'GET' }, 401, 'missing'],
    ['wrong bearer', '/api/desktop/bootstrap', { headers: { Authorization: 'Bearer wrong' } }, 401, 'invalid'],
    ['wrong bootstrap method', '/api/desktop/bootstrap', { headers, method: 'POST' }, 405, 'synthetic-bearer'],
    ['wrong profiles method', '/api/desktop/model-profiles', { headers, method: 'POST' }, 405, 'synthetic-bearer'],
    ['wrong manifest method', '/api/desktop/runtime/manifests', { headers, method: 'GET' }, 405, 'synthetic-bearer'],
    ['unexpected path', '/api/desktop/other', { headers, method: 'GET' }, 404, 'synthetic-bearer']
  ]
  for (const [, target, options, expectedStatus, expectedAuth] of invalidRequests) {
    const events = []
    const response = await createTransport(fixture, events)(`https://x1-fixture.invalid${target}`, options)
    assert.equal(response.status, expectedStatus)
    assert.equal(events[0].auth, expectedAuth)
    assert.equal(transportEventsMatch(events), false)
    assert.ok(events.every(event => !JSON.stringify(event).includes('dsk_x1_private_fixture')))
  }
})

test('rollback is one gated sequence over the same persistent state', async () => {
  const context = newRollbackContext('sequence')
  try {
    const initialState = clone(context.state)
    const steps = CASES.filter(item => item.rollbackStep)
    const identities = []
    const result = await runRollbackSequence({
      context,
      steps,
      executeStep: async (step, actualContext, previousAfter) => {
        identities.push(actualContext)
        assert.deepEqual(actualContext.state, previousAfter)
        const stateTransition = advanceSyntheticState(
          actualContext,
          step,
          step.rollbackStep === 'gateway-p1' ? 1 : 2
        )
        return { passed: true, runtime: { stateTransition } }
      }
    })
    assert.deepEqual(result.completed, ['required', 'p2-compatible', 'desktop-p1', 'gateway-p1'])
    assert.equal(new Set(identities).size, 1)
    assert.equal(result.finalState.writeCount, initialState.writeCount + 4)
    assert.equal(result.finalState.version, 1)
  } finally {
    removeDirectory(context.testRoot)
  }
})

test('missing rollback state and interrupted steps cannot pass or run later steps', async () => {
  await assert.rejects(
    runRollbackSequence({ context: { authStore: { readSession: () => ({}) } }, steps: [], executeStep: async () => ({}) }),
    error => error.code === 'rollback_shared_context_missing'
  )
  const context = newRollbackContext('interrupted')
  try {
    const called = []
    const result = await runRollbackSequence({
      context,
      steps: CASES.filter(item => item.rollbackStep),
      executeStep: async step => {
        called.push(step.rollbackStep)
        if (called.length === 2) throw new Error('injected interruption')
        return { passed: true, runtime: { stateTransition: advanceSyntheticState(context, step) } }
      }
    })
    assert.deepEqual(called, ['required', 'p2-compatible'])
    assert.deepEqual(result.completed, ['required'])
    assert.equal(result.stoppedAt, 'p2-compatible')
    assert.equal(result.errorCode, 'rollback_step_interrupted')
  } finally {
    removeDirectory(context.testRoot)
  }
})

test('a returned rollback failure stops after step two and freezes the final shared state', async () => {
  const context = newRollbackContext('returned-failure')
  const called = []
  let stateAtFailure = null
  const result = await runRollbackSequence({
    context,
    steps: CASES.filter(item => item.rollbackStep),
    executeStep: async step => {
      called.push(step.rollbackStep)
      const runtime = { stateTransition: advanceSyntheticState(context, step) }
      if (called.length === 2) {
        stateAtFailure = clone(context.state)
        return { passed: false, runtime }
      }
      return { passed: true, runtime }
    }
  })
  assert.deepEqual(called, ['required', 'p2-compatible'])
  assert.deepEqual(result.completed, ['required'])
  assert.equal(result.stoppedAt, 'p2-compatible')
  assert.equal(result.errorCode, 'rollback_step_failed')
  assert.deepEqual(context.state, stateAtFailure)
  assert.deepEqual(result.finalState, stateAtFailure)
  removeDirectory(context.testRoot)
})

test('the executeMatrix rollback phase leaves later assertions NOT_RUN after injected failure', async () => {
  const assertions = createAssertions()
  const context = newRollbackContext('phase-failure')
  const steps = CASES.filter(item => item.rollbackStep)
  const called = []
  const sequence = await executeRollbackPhase({
    assertions,
    context,
    steps,
    executeStep: async step => {
      called.push(step.rollbackStep)
      const runtime = { stateTransition: advanceSyntheticState(context, step) }
      if (step.rollbackStep === 'required') {
        for (const suffix of ['exporter-exit', 'raw-evidence-integrity', 'runtime-outcome', 'request-counts', 'contract-semantics', 'shared-state']) {
          assertions.find(item => item.id === `${step.id}.${suffix}`).status = 'PASS'
        }
        return { passed: true, runtime }
      }
      assertions.find(item => item.id === `${step.id}.runtime-outcome`).status = 'FAIL'
      return { passed: false, runtime }
    }
  })
  assert.deepEqual(called, ['required', 'p2-compatible'])
  assert.deepEqual(sequence.completed, ['required'])
  assert.equal(assertions.find(item => item.id === 'rollback.order').status, 'FAIL')
  assert.equal(exitCodeForAssertions(assertions), 1)
  for (const step of steps.slice(2)) {
    assert.ok(assertions
      .filter(item => item.id.startsWith(`${step.id}.`))
      .every(item => item.status === 'NOT_RUN'))
  }
  removeDirectory(context.testRoot)
})

test('ordinary matrix stops at the first stable failure without masking it with rollback setup', async () => {
  const assertions = createAssertions()
  const steps = CASES.filter(item => !item.rollbackStep)
  const called = []
  const sequence = await executeOrdinaryPhase({
    steps,
    executeStep: async step => {
      called.push(step.id)
      const assertion = assertions.find(item => item.id === `${step.id}.exporter-exit`)
      assertion.status = 'FAIL'
      assertion.code = 'gateway_exporter_nonzero'
      return { failureCode: 'gateway_exporter_nonzero', passed: false }
    }
  })
  assert.deepEqual(called, [steps[0].id])
  assert.deepEqual(sequence, {
    completed: [],
    errorCode: 'gateway_exporter_nonzero',
    stoppedAt: steps[0].id
  })
  assert.deepEqual(
    assertions.find(item => item.id === `${steps[0].id}.exporter-exit`),
    { id: `${steps[0].id}.exporter-exit`, status: 'FAIL', code: 'gateway_exporter_nonzero' }
  )
  for (const step of steps.slice(1)) {
    assert.ok(assertions
      .filter(item => item.id.startsWith(`${step.id}.`))
      .every(item => item.status === 'NOT_RUN'))
  }
  for (const step of CASES.filter(item => item.rollbackStep)) {
    assert.ok(assertions
      .filter(item => item.id.startsWith(`${step.id}.`))
      .every(item => item.status === 'NOT_RUN'))
  }
  assert.equal(assertions.find(item => item.id === 'rollback.order').status, 'NOT_RUN')
  assert.equal(assertions.find(item => item.id === 'rollback.home-cleanup').status, 'NOT_RUN')
  assert.equal(exitCodeForAssertions(assertions), 1)
})

test('rollback home wrapper invokes the real writer and reports only safe file evidence', () => {
  const context = newRollbackContext('real-writer')
  const writer = require('../electron/enterprise-runtime-home.cjs').writeManagedRuntimeHome
  const payload = {
    bootstrap: {
      bootstrapContractVersion: 2,
      policyVersion: 'x1-policy-v1',
      user: { id: TEST_USER_ID, userName: 'x1-fixture-user' }
    },
    manifest: {
      allowedModels: ['x1-model'],
      defaultModel: 'x1-model',
      gatewayApiBaseUrl: 'https://x1-fixture.invalid/api',
      gatewayToken: 'gw_x1_private_fixture',
      manifestId: 'x1-manifest',
      policyVersion: 'x1-policy-v1'
    },
    modelProfiles: []
  }
  try {
    const result = writeRollbackHome({
      context,
      identityBinding: 'fixed-synthetic',
      payload,
      writer
    })
    assert.equal(result.stateTransition.after.writeCount, 1)
    assert.equal(result.stateTransition.after.files.length, 3)
    assert.equal(result.stateTransition.after.policy.enterpriseUserBinding, 'fixed-synthetic')
    assert.equal(result.stateTransition.after.policy.enterpriseUserIdSha256, digest(Buffer.from(TEST_USER_ID)))
    assert.equal(JSON.stringify(result.stateTransition).includes(TEST_USER_ID), false)
    assert.equal(JSON.stringify(result.stateTransition).includes('gw_x1_private_fixture'), false)
    assert.deepEqual(
      managedHomeSnapshot(context.managedHome, {
        expectedUserId: TEST_USER_ID,
        identityBinding: 'fixed-synthetic',
        version: 2,
        writeCount: 1
      }),
      result.stateTransition.after
    )
  } finally {
    removeDirectory(context.testRoot)
  }
})

test('rollback home rejects no-write and corrupt writers and restores the exact prior state', () => {
  const scenarios = [
    {
      name: 'no-write',
      writer: () => ({})
    },
    {
      name: 'corrupt-policy',
      writer: ({ fsImpl, hermesHome }) => {
        fsImpl.mkdirSync(hermesHome, { recursive: true })
        fsImpl.writeFileSync(path.join(hermesHome, '.env'), 'synthetic')
        fsImpl.writeFileSync(path.join(hermesHome, 'config.yaml'), 'managed: true\n')
        fsImpl.writeFileSync(path.join(hermesHome, 'enterprise-policy.json'), '{broken')
        return {}
      }
    },
    {
      name: 'mutate-then-fail',
      writer: ({ fsImpl, hermesHome }) => {
        fsImpl.mkdirSync(hermesHome, { recursive: true })
        fsImpl.writeFileSync(path.join(hermesHome, '.env'), 'must-be-rolled-back')
        throw Object.assign(new Error('injected'), { code: 'injected_writer_failure' })
      }
    }
  ]
  for (const scenario of scenarios) {
    const context = newRollbackContext(`writer-${scenario.name}`)
    const before = clone(context.state)
    try {
      assert.throws(() => writeRollbackHome({
        context,
        identityBinding: 'fixed-synthetic',
        payload: {
          bootstrap: { bootstrapContractVersion: 2 },
          manifest: {},
          modelProfiles: []
        },
        writer: scenario.writer
      }))
      assert.deepEqual(context.state, before)
      assert.equal(context.state.writeCount, 0)
      assert.equal(fs.existsSync(context.managedHome), false)
    } finally {
      removeDirectory(context.testRoot)
    }
  }
})

test('runner identity is bound to this script and the Desktop source HEAD', () => {
  const scriptPath = path.join(__dirname, 'x1-enterprise-bootstrap-matrix.cjs')
  const head = 'a'.repeat(40)
  const source = { desktop: { before: { head } } }
  const identity = { scriptSha256: digest(fs.readFileSync(scriptPath)), sourceHead: head }
  assert.equal(validateRunnerIdentity(identity, source), true)
  assert.equal(validateRunnerIdentity({ ...identity, scriptSha256: 'b'.repeat(64) }, source), false)
  assert.equal(validateRunnerIdentity({ ...identity, sourceHead: 'c'.repeat(40) }, source), false)
})

test('output/source overlap is rejected in both directions', () => {
  const root = tempDirectory('overlap')
  try {
    const desktop = path.join(root, 'desktop')
    const gateway = path.join(root, 'gateway')
    fs.mkdirSync(desktop)
    fs.mkdirSync(gateway)
    fs.writeFileSync(path.join(desktop, '.git'), '')
    fs.writeFileSync(path.join(gateway, '.git'), '')
    assert.throws(
      () => validateRoots({ desktopSourceRoot: desktop, gatewaySourceRoot: gateway, outputDirectory: root }),
      error => error.code === 'matrix_output_overlaps_source'
    )
    assert.throws(
      () => validateRoots({ desktopSourceRoot: desktop, gatewaySourceRoot: gateway, outputDirectory: path.join(desktop, 'out') }),
      error => error.code === 'matrix_output_overlaps_source'
    )
    assert.doesNotThrow(() => validateRoots({
      desktopSourceRoot: desktop,
      gatewaySourceRoot: gateway,
      outputDirectory: path.join(root, '..', 'isolated-output')
    }))
  } finally {
    removeDirectory(root)
  }
})

test('executeMatrix rejects direct output overlap before any source or evidence write', async () => {
  const root = tempDirectory('execute-direct-overlap')
  try {
    const desktop = createFakeGitRoot(root, 'desktop')
    const gateway = createFakeGitRoot(root, 'gateway')
    const beforeDesktop = treeFingerprint(desktop)
    const beforeGateway = treeFingerprint(gateway)
    const output = path.join(desktop, 'escaped-output')
    const result = await runMatrixCli({ desktop, gateway, output })
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /^FAIL matrix_output_overlaps_source\n$/)
    assert.equal(result.stdout, '')
    assert.equal(fs.existsSync(output), false)
    assert.equal(treeFingerprint(desktop), beforeDesktop)
    assert.equal(treeFingerprint(gateway), beforeGateway)
    assert.equal(matrixEvidenceCount(root), 0)
  } finally {
    removeDirectory(root)
  }
})

test('executeMatrix rejects an output ancestor before any source or evidence write', async () => {
  const root = tempDirectory('execute-output-ancestor')
  try {
    const desktop = createFakeGitRoot(root, 'desktop')
    const gateway = createFakeGitRoot(root, 'gateway')
    const beforeDesktop = treeFingerprint(desktop)
    const beforeGateway = treeFingerprint(gateway)
    const beforeRoot = treeFingerprint(root)
    const result = await runMatrixCli({ desktop, gateway, output: root })
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /^FAIL matrix_output_overlaps_source\n$/)
    assert.equal(result.stdout, '')
    assert.equal(treeFingerprint(desktop), beforeDesktop)
    assert.equal(treeFingerprint(gateway), beforeGateway)
    assert.equal(treeFingerprint(root), beforeRoot)
    assert.equal(matrixEvidenceCount(root), 0)
  } finally {
    removeDirectory(root)
  }
})

test('executeMatrix rejects a junction or symlink output escape with zero source changes', async () => {
  const root = tempDirectory('execute-reparse')
  let link = null
  try {
    const desktop = createFakeGitRoot(root, 'desktop')
    const gateway = createFakeGitRoot(root, 'gateway')
    link = path.join(root, 'output-link')
    fs.symlinkSync(desktop, link, process.platform === 'win32' ? 'junction' : 'dir')
    const beforeDesktop = treeFingerprint(desktop)
    const beforeGateway = treeFingerprint(gateway)
    const output = path.join(link, 'escaped-output')
    const result = await runMatrixCli({ desktop, gateway, output })
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /^FAIL matrix_path_reparse_forbidden\n$/)
    assert.equal(result.stdout, '')
    assert.equal(fs.existsSync(path.join(desktop, 'escaped-output')), false)
    assert.equal(treeFingerprint(desktop), beforeDesktop)
    assert.equal(treeFingerprint(gateway), beforeGateway)
    assert.equal(matrixEvidenceCount(root), 0)
  } finally {
    if (link && fs.existsSync(link)) fs.unlinkSync(link)
    removeDirectory(root)
  }
})

test('source unchanged comparison includes HEAD, dirty state, status and diff hashes', () => {
  const state = {
    head: 'a'.repeat(40),
    dirty: true,
    statusSha256: 'b'.repeat(64),
    trackedDiffSha256: 'c'.repeat(64)
  }
  assert.equal(sourceStatesEqual(state, { ...state }), true)
  assert.equal(sourceStatesEqual(state, { ...state, dirty: false }), false)
  assert.equal(sourceStatesEqual(state, { ...state, statusSha256: 'd'.repeat(64) }), false)
})

test('sensitive output scan rejects tokens, usernames and absolute roots', () => {
  const root = tempDirectory('scan')
  try {
    const file = path.join(root, 'evidence.json')
    fs.writeFileSync(file, '{"token":"dsk_private_value_123"}')
    assert.equal(scanOutputFiles(root, []).passed, false)
    fs.writeFileSync(file, '{"path":"C:\\\\private\\\\real-user"}')
    assert.equal(scanOutputFiles(root, ['C:\\private\\real-user']).passed, false)
    fs.writeFileSync(file, '{"status":"PASS","user":"fixed-synthetic"}')
    assert.equal(scanOutputFiles(root, ['C:\\private\\real-user']).passed, true)
  } finally {
    removeDirectory(root)
  }
})

test('gateway evidence corruption fails closed before Desktop consumption', () => {
  const root = tempDirectory('corrupt')
  try {
    const item = CASES.find(candidate => candidate.id === 'p1-gateway-p1-desktop')
    const body = Buffer.from('{}', 'utf8')
    fs.writeFileSync(path.join(root, 'x1-desktop-bootstrap.response.json'), body)
    const evidence = {
      schemaVersion: 1,
      status: 'PASS',
      sut: {
        ref: FIXED_REFS.gatewayP1,
        resolvedCommit: FIXED_REFS.gatewayP1,
        tree: '1'.repeat(40),
        archiveSha256: '2'.repeat(64)
      },
      invocation: { mode: 'compatible', requestProfile: 'p1' },
      transport: { kind: 'TestServer', ports: [] },
      request: { method: 'GET', path: '/api/desktop/bootstrap', headers: [] },
      response: { statusCode: 200, headers: [] },
      body: {
        file: 'x1-desktop-bootstrap.response.json',
        bytes: body.length,
        sha256: digest(body),
        contractClassification: 'legacy'
      },
      assertions: [
        { name: 'response.status', expected: '200', actual: '200', status: 'PASS' },
        {
          name: 'response.content-type',
          expected: 'application/json',
          actual: 'application/json',
          status: 'PASS'
        },
        {
          name: 'body.fixture-identity',
          expected: 'fixed-synthetic',
          actual: 'fixed-synthetic',
          status: 'PASS'
        },
        { name: 'body.contract-version', expected: 'legacy', actual: 'legacy', status: 'PASS' },
        { name: 'body.sha256', expected: digest(body), actual: digest(body), status: 'PASS' }
      ],
      command: { exitCode: 0 },
      sourceIntegrity: {
        headBefore: '3'.repeat(40),
        headAfter: '3'.repeat(40),
        statusSha256Before: '4'.repeat(64),
        statusSha256After: '4'.repeat(64),
        diffSha256Before: '5'.repeat(64),
        diffSha256After: '5'.repeat(64),
        unchanged: true
      }
    }
    fs.writeFileSync(path.join(root, 'x1-desktop-bootstrap.evidence.json'), JSON.stringify(evidence))
    assert.doesNotThrow(() => loadGatewayFixture(root, item))
    evidence.body.sha256 = digest(Buffer.from('tampered', 'utf8'))
    fs.writeFileSync(path.join(root, 'x1-desktop-bootstrap.evidence.json'), JSON.stringify(evidence))
    assert.throws(
      () => loadGatewayFixture(root, item),
      error => error.code === 'gateway_evidence_invalid'
    )
  } finally {
    removeDirectory(root)
  }
})

test('problem evidence accepts only an opaque trace placeholder', () => {
  const bodySha = 'a'.repeat(64)
  const assertions = [
    { name: 'response.status', expected: '426', actual: '426', status: 'PASS' },
    {
      name: 'response.content-type',
      expected: 'application/problem+json',
      actual: 'application/problem+json',
      status: 'PASS'
    },
    { name: 'body.problem-code', expected: 'upgrade-required', actual: 'upgrade-required', status: 'PASS' },
    { name: 'body.problem-contract', expected: 'frozen-v2', actual: 'frozen-v2', status: 'PASS' },
    { name: 'body.problem-trace', expected: 'opaque-nonempty', actual: 'opaque-nonempty', status: 'PASS' },
    { name: 'response.cache-control', expected: 'no-store', actual: 'no-store', status: 'PASS' },
    {
      name: 'response.vary',
      expected: 'X-Hermes-Desktop-Bootstrap-Contract',
      actual: 'X-Hermes-Desktop-Bootstrap-Contract',
      status: 'PASS'
    },
    { name: 'body.sha256', expected: bodySha, actual: bodySha, status: 'PASS' }
  ]
  assert.equal(gatewayAssertionsMatch(assertions, 'problem', 426, bodySha), true)
  assertions[4] = { ...assertions[4], actual: '00-real-trace-must-not-be-copied' }
  assert.equal(gatewayAssertionsMatch(assertions, 'problem', 426, bodySha), false)
})

test('matrix manifest is atomically written last without a temporary file', async () => {
  const root = tempDirectory('manifest-last')
  try {
    const bodyPath = path.join(root, 'body.json')
    fs.writeFileSync(bodyPath, '{}')
    await new Promise(resolve => setTimeout(resolve, 20))
    const written = writeManifestLast(root, { schemaVersion: 1, status: 'PASS' })
    const manifestPath = path.join(root, written.file)
    assert.equal(fs.existsSync(manifestPath), true)
    assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false)
    assert.ok(fs.statSync(manifestPath).mtimeMs >= fs.statSync(bodyPath).mtimeMs)
    assert.equal(written.sha256, digest(fs.readFileSync(manifestPath)))
  } finally {
    removeDirectory(root)
  }
})

test('cancellation terminates a spawned process tree within a bounded wait', { timeout: 15000 }, async () => {
  const records = []
  const runner = createProcessRunner(records, { cleanupTimeoutMs: 6000 })
  const childScript = [
    "const { spawn } = require('node:child_process')",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    'console.log(grandchild.pid)',
    'setInterval(() => {}, 1000)'
  ].join(';')
  const running = runner.run('cancel-tree', process.execPath, ['-e', childScript])
  await new Promise(resolve => setTimeout(resolve, 300))
  const cleaned = await runner.cancel()
  const result = await running
  const grandchildPid = Number(result.stdout.toString('utf8').trim())
  assert.equal(cleaned, true)
  assert.equal(runner.active.size, 0)
  assert.equal(records[0].cleanupStatus, 'exited')
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)
  assert.throws(() => process.kill(grandchildPid, 0))

  const auditRunner = createProcessRunner(records)
  const audit = await auditRunner.run('post-cancel-read-only-audit', process.execPath, [
    '-e',
    "process.stdout.write('audit-ok')"
  ])
  assert.equal(audit.exitCode, 0)
  assert.equal(audit.stdout.toString('utf8'), 'audit-ok')
  assert.equal(records[1].cleanupStatus, 'exited')
})

for (const scenario of [
  { id: 'exit-zero', cancel: false, terminal: 'process.exit(0)' },
  { id: 'exit-exception', cancel: false, terminal: "throw new Error('synthetic child failure')" },
  { id: 'cancel', cancel: true, terminal: 'setInterval(() => {}, 1000)' }
]) {
  test(`owned TEMP/TMP cleanup is production-equivalent for ${scenario.id}`, { timeout: 15000 }, async () => {
    const tempRoot = tempDirectory(`owned-${scenario.id}`)
    const records = []
    const runner = createProcessRunner(records, { cleanupTimeoutMs: 6000 })
    const owned = createOwnedTempEnvironment(tempRoot, `exporter-${scenario.id}`)
    try {
      assert.equal(path.relative(tempRoot, owned.ownedRoot).startsWith('..'), false)
      const grandchildScript = scenario.cancel
        ? [
            "const fs=require('node:fs')",
            "const path=require('node:path')",
            "fs.mkdirSync(path.join(process.env.TMP,'grandchild'),{recursive:true})",
            "fs.writeFileSync(path.join(process.env.TMP,'grandchild','tmp.txt'),'tmp')",
            'setInterval(() => {}, 1000)'
          ].join(';')
        : [
            "const fs=require('node:fs')",
            "const path=require('node:path')",
            "fs.mkdirSync(path.join(process.env.TMP,'grandchild'),{recursive:true})",
            "fs.writeFileSync(path.join(process.env.TMP,'grandchild','tmp.txt'),'tmp')"
          ].join(';')
      const childScript = [
        "const fs = require('node:fs')",
        "const path = require('node:path')",
        "const { spawn } = require('node:child_process')",
        "fs.mkdirSync(path.join(process.env.TEMP, 'child'), { recursive: true })",
        "fs.writeFileSync(path.join(process.env.TEMP, 'child', 'temp.txt'), 'temp')",
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { env: process.env, stdio: 'ignore' })`,
        'console.log(grandchild.pid)',
        scenario.cancel ? scenario.terminal : `grandchild.once('close', () => { ${scenario.terminal} })`
      ].join(';')
      const running = runner.run(`owned-${scenario.id}`, process.execPath, ['-e', childScript], {
        env: owned.environment
      })
      for (let index = 0; index < 40 && !fs.existsSync(path.join(owned.ownedRoot, 'grandchild', 'tmp.txt')); index += 1) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(fs.existsSync(path.join(owned.ownedRoot, 'child', 'temp.txt')), true)
      assert.equal(fs.existsSync(path.join(owned.ownedRoot, 'grandchild', 'tmp.txt')), true)
      const childPid = records[0].pid
      if (scenario.cancel) assert.equal(await runner.cancel(), true)
      const result = await running
      const grandchildPid = Number(result.stdout.toString('utf8').trim())
      if (scenario.id === 'exit-zero') assert.equal(result.exitCode, 0)
      else assert.notEqual(result.exitCode, 0)
      const cleanup = await cleanupOwnedTempRoot({ runner, tempRoot })
      assert.deepEqual(cleanup, { filesystemClean: true, passed: true, processesClean: true })
      assert.equal(runner.active.size, 0)
      assert.equal(records[0].cleanupStatus, 'exited')
      assert.throws(() => process.kill(childPid, 0))
      assert.throws(() => process.kill(grandchildPid, 0))
      assert.equal(fs.existsSync(owned.ownedRoot), false)
      assert.equal(fs.existsSync(tempRoot), false)
    } finally {
      fs.rmSync(tempRoot, { force: true, recursive: true })
    }
  })
}

test('owned TEMP owner cannot escape the production temp root', () => {
  const tempRoot = tempDirectory('owned-escape')
  try {
    assert.throws(
      () => createOwnedTempEnvironment(tempRoot, '../escape'),
      error => error.code === 'matrix_temp_owner_invalid'
    )
  } finally {
    removeDirectory(tempRoot)
  }
})

test('child-temp junction is rejected without changing its external target', () => {
  const tempRoot = tempDirectory('child-junction-root')
  const external = tempDirectory('child-junction-external')
  const childRoot = path.join(tempRoot, 'child-temp')
  try {
    fs.writeFileSync(path.join(external, 'marker.txt'), 'external-must-not-change')
    const before = treeFingerprint(external)
    fs.symlinkSync(external, childRoot, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(
      () => createOwnedTempEnvironment(tempRoot, 'e00-abcdef'),
      error => error.code === 'matrix_path_reparse_forbidden'
    )
    assert.equal(treeFingerprint(external), before)
    assert.equal(fs.readFileSync(path.join(external, 'marker.txt'), 'utf8'), 'external-must-not-change')
    assert.equal(fs.lstatSync(childRoot).isSymbolicLink(), true)
  } finally {
    if (fs.existsSync(childRoot)) fs.unlinkSync(childRoot)
    removeDirectory(tempRoot)
    removeDirectory(external)
  }
})

test('owner junction and pre-existing owner fail closed with zero target changes', () => {
  const tempRoot = tempDirectory('owner-preexisting-root')
  const external = tempDirectory('owner-preexisting-external')
  const childRoot = path.join(tempRoot, 'child-temp')
  const ownerName = 'e00-abcdef'
  const ownerRoot = path.join(childRoot, ownerName)
  try {
    fs.mkdirSync(childRoot)
    fs.writeFileSync(path.join(external, 'marker.txt'), 'external-must-not-change')
    const before = treeFingerprint(external)
    fs.symlinkSync(external, ownerRoot, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(
      () => createOwnedTempEnvironment(tempRoot, ownerName),
      error => error.code === 'matrix_temp_owner_preexisting'
    )
    assert.equal(treeFingerprint(external), before)
    assert.equal(fs.lstatSync(ownerRoot).isSymbolicLink(), true)
    fs.unlinkSync(ownerRoot)

    fs.mkdirSync(ownerRoot)
    fs.writeFileSync(path.join(ownerRoot, 'preexisting.txt'), 'do-not-touch')
    const ownerBefore = treeFingerprint(ownerRoot)
    assert.throws(
      () => createOwnedTempEnvironment(tempRoot, ownerName),
      error => error.code === 'matrix_temp_owner_preexisting'
    )
    assert.equal(treeFingerprint(ownerRoot), ownerBefore)
    assert.equal(fs.readFileSync(path.join(ownerRoot, 'preexisting.txt'), 'utf8'), 'do-not-touch')
    assert.equal(treeFingerprint(external), before)
  } finally {
    if (fs.existsSync(ownerRoot) && fs.lstatSync(ownerRoot).isSymbolicLink()) fs.unlinkSync(ownerRoot)
    removeDirectory(tempRoot)
    removeDirectory(external)
  }
})

test('failed owner creation removes only child-temp created by that invocation', () => {
  if (process.platform !== 'win32') return
  const tempRoot = tempDirectory('owner-cleanup')
  const childRoot = path.join(tempRoot, 'child-temp')
  try {
    assert.throws(
      () => createOwnedTempEnvironment(tempRoot, 'a'.repeat(128)),
      error => error.code === 'matrix_temp_path_too_long'
    )
    assert.equal(fs.existsSync(childRoot), false)
    assert.equal(fs.existsSync(tempRoot), true)
  } finally {
    removeDirectory(tempRoot)
  }
})

test('production temp roots and every case owner are short, unique and run-scoped', () => {
  const roots = Array.from({ length: 32 }, () => makeShortTempRoot())
  assert.equal(new Set(roots.map(root => path.basename(root))).size, roots.length)
  assert.ok(roots.every(root => /^x1m-[a-f0-9]{12}$/.test(path.basename(root))))

  const owners = CASES.map((item, index) => ownedTempOwner(item, index))
  assert.equal(new Set(owners).size, CASES.length)
  assert.ok(owners.every(owner => /^e\d{2}-[a-f0-9]{6}$/.test(owner)))

  const tempRoot = roots[0]
  try {
    fs.mkdirSync(tempRoot)
    const ownedRoots = owners.map(owner => createOwnedTempEnvironment(tempRoot, owner).ownedRoot)
    assert.equal(new Set(ownedRoots.map(value => value.toLowerCase())).size, CASES.length)
    if (process.platform === 'win32') {
      assert.ok(ownedRoots.every(value => value.length <= MAX_OWNED_TEMP_PATH_LENGTH))
    }
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true })
  }
})

test('final manifest bytes are scanned before publish and reject path or username injection', () => {
  const clean = { schemaVersion: 1, status: 'PASS', source: { head: 'a'.repeat(40) } }
  const bytes = prepareManifestForPublish(clean, ['C:\\private\\real-user', 'real-user'])
  assert.deepEqual(bytes, Buffer.from(`${JSON.stringify(clean, null, 2)}\n`, 'utf8'))
  assert.throws(
    () => prepareManifestForPublish({ ...clean, injected: 'C:\\private\\real-user\\secret' }, ['C:\\private\\real-user']),
    error => error.code === 'matrix_manifest_sensitive_value_detected'
  )
  assert.throws(
    () => prepareManifestForPublish({ ...clean, actor: 'real-user' }, ['real-user']),
    error => error.code === 'matrix_manifest_sensitive_value_detected'
  )
  assert.throws(
    () => prepareManifestForPublish({ ...clean, token: 'dsk_private_value_123' }, []),
    error => error.code === 'matrix_manifest_sensitive_value_detected'
  )
})
