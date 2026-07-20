#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const FIXED_REFS = Object.freeze({
  gatewayP1: 'f17a6618fa848bc44fdee4396cd5f4a36c655413',
  gatewayP2: 'e4c2160f3c7002e95cedea25f306ce8a9f2f0ab6',
  desktopP1: '39b5be1c7e7ccf89fde91540d3e7e61c60d07186',
  desktopP2: '1622148f80de3c71f22df2a485da09c65c201911'
})

const CONTRACT_HEADER = 'X-Hermes-Desktop-Bootstrap-Contract'
const BODY_FILE = 'x1-desktop-bootstrap.response.json'
const GATEWAY_EVIDENCE_FILE = 'x1-desktop-bootstrap.evidence.json'
const MATRIX_MANIFEST_FILE = 'x1-enterprise-bootstrap-matrix.evidence.json'
const MATRIX_SCHEMA_VERSION = 1
const MAX_OWNED_TEMP_PATH_LENGTH = 120
const SYNTHETIC_DESKTOP_TOKEN = 'dsk_x1_private_fixture'
const SYNTHETIC_GATEWAY_TOKEN = 'gw_x1_private_fixture'
const FIXED_SYNTHETIC_USER_ID = '11111111-2222-4333-8444-555555555555'
const GATEWAY_EXPORTER_REF = '609c509952be368c914a5e64e23cf5e48831f530'

const CASES = Object.freeze([
  {
    id: 'p1-gateway-p1-desktop',
    gatewayRef: 'gatewayP1',
    desktopRef: 'desktopP1',
    mode: 'compatible',
    requestProfile: 'p1',
    expected: { errorCode: null, home: 1, manifest: 1, profiles: 1, statusCode: 200 }
  },
  {
    id: 'p1-gateway-p2-desktop',
    gatewayRef: 'gatewayP1',
    desktopRef: 'desktopP2',
    mode: 'compatible',
    requestProfile: 'p2',
    expected: {
      errorCode: 'enterprise_gateway_contract_too_old',
      home: 0,
      manifest: 0,
      profiles: 0,
      statusCode: 200
    }
  },
  {
    id: 'p2-compatible-p1-desktop',
    gatewayRef: 'gatewayP2',
    desktopRef: 'desktopP1',
    mode: 'compatible',
    requestProfile: 'p1',
    expected: { errorCode: null, home: 1, manifest: 1, profiles: 1, statusCode: 200 }
  },
  {
    id: 'p2-compatible-p2-desktop',
    gatewayRef: 'gatewayP2',
    desktopRef: 'desktopP2',
    mode: 'compatible',
    requestProfile: 'p2',
    expected: { errorCode: null, home: 1, manifest: 1, profiles: 1, statusCode: 200 }
  },
  {
    id: 'p2-required-p1-desktop',
    gatewayRef: 'gatewayP2',
    desktopRef: 'desktopP1',
    mode: 'required',
    requestProfile: 'p1',
    expected: {
      errorCode: 'desktop_bootstrap_contract_upgrade_required',
      home: 0,
      manifest: 0,
      profiles: 1,
      statusCode: 426
    }
  },
  {
    id: 'p2-required-p2-desktop',
    gatewayRef: 'gatewayP2',
    desktopRef: 'desktopP2',
    mode: 'required',
    requestProfile: 'p2',
    expected: { errorCode: null, home: 1, manifest: 1, profiles: 1, statusCode: 200 }
  },
  {
    id: 'rollback-required',
    gatewayRef: 'gatewayP2',
    desktopRef: 'desktopP2',
    mode: 'required',
    requestProfile: 'p2',
    rollbackStep: 'required',
    expected: { errorCode: null, home: 1, manifest: 1, profiles: 1, statusCode: 200 }
  },
  {
    id: 'rollback-p2-compatible',
    gatewayRef: 'gatewayP2',
    desktopRef: 'desktopP2',
    mode: 'compatible',
    requestProfile: 'p2',
    rollbackStep: 'p2-compatible',
    expected: { errorCode: null, home: 1, manifest: 1, profiles: 1, statusCode: 200 }
  },
  {
    id: 'rollback-desktop-p1',
    gatewayRef: 'gatewayP2',
    desktopRef: 'desktopP1',
    mode: 'compatible',
    requestProfile: 'p1',
    rollbackStep: 'desktop-p1',
    expected: { errorCode: null, home: 1, manifest: 1, profiles: 1, statusCode: 200 }
  },
  {
    id: 'rollback-gateway-p1',
    gatewayRef: 'gatewayP1',
    desktopRef: 'desktopP1',
    mode: 'compatible',
    requestProfile: 'p1',
    rollbackStep: 'gateway-p1',
    expected: { errorCode: null, home: 1, manifest: 1, profiles: 1, statusCode: 200 }
  }
])

class MatrixError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function parseArguments(args) {
  if (!Array.isArray(args) || args.length !== 6) return null
  const values = new Map()
  const allowed = new Set(['--desktop-source-root', '--gateway-source-root', '--output-directory'])
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = String(args[index + 1] || '').trim()
    if (!allowed.has(key) || values.has(key) || !value) return null
    values.set(key, value)
  }
  if (values.size !== allowed.size) return null
  return {
    desktopSourceRoot: path.resolve(values.get('--desktop-source-root')),
    gatewaySourceRoot: path.resolve(values.get('--gateway-source-root')),
    outputDirectory: path.resolve(values.get('--output-directory'))
  }
}

function assertionIds() {
  const ids = [
    'preflight.fixed-refs',
    'preflight.archive-only',
    'preflight.gateway-exporter',
    'preflight.source-unchanged',
    'rollback.order',
    'rollback.home-cleanup',
    'commands.all-exited',
    'cleanup.temp-removed',
    'evidence.no-sensitive-values',
    'evidence.runner-identity'
  ]
  for (const item of CASES) {
    ids.push(
      `${item.id}.exporter-exit`,
      `${item.id}.raw-evidence-integrity`,
      `${item.id}.runtime-outcome`,
      `${item.id}.request-counts`,
      `${item.id}.contract-semantics`
    )
    if (item.rollbackStep) ids.push(`${item.id}.shared-state`)
  }
  return ids
}

function createAssertions() {
  return assertionIds().map(id => ({ id, status: 'NOT_RUN' }))
}

function exitCodeForAssertions(assertions, cancelled = false) {
  if (cancelled) return 130
  return assertions.every(item => item.status === 'PASS') ? 0 : 1
}

function setAssertion(assertions, id, status, code = null) {
  const assertion = assertions.find(item => item.id === id)
  if (!assertion) throw new MatrixError('matrix_assertion_not_registered')
  assertion.status = status
  if (code) assertion.code = code
  else delete assertion.code
}

function safeCode(error, fallback = 'matrix_operation_failed') {
  const candidate = String(error?.code || error?.message || fallback)
  return /^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(candidate) ? candidate : fallback
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function gatewayAssertionsMatch(assertions, classification, statusCode, bodySha256) {
  if (!Array.isArray(assertions)) return false
  const mediaType = classification === 'problem' ? 'application/problem+json' : 'application/json'
  const expected = [
    ['response.status', String(statusCode), String(statusCode)],
    ['response.content-type', mediaType, mediaType]
  ]
  if (classification === 'legacy' || classification === 'v2') {
    expected.push(['body.fixture-identity', 'fixed-synthetic', 'fixed-synthetic'])
    expected.push(['body.contract-version', classification === 'v2' ? '2' : 'legacy', classification === 'v2' ? '2' : 'legacy'])
  } else if (classification === 'problem') {
    expected.push(['body.problem-code', 'upgrade-required', 'upgrade-required'])
    expected.push(['body.problem-contract', 'frozen-v2', 'frozen-v2'])
    // The original trace identifier remains only in the archived raw body.
    // Evidence must expose the frozen placeholder, never the identifier.
    expected.push(['body.problem-trace', 'opaque-nonempty', 'opaque-nonempty'])
  } else {
    return false
  }
  if (classification !== 'legacy') {
    expected.push(['response.cache-control', 'no-store', 'no-store'])
    expected.push(['response.vary', CONTRACT_HEADER, CONTRACT_HEADER])
  }
  expected.push(['body.sha256', bodySha256, bodySha256])
  if (assertions.length !== expected.length) return false
  return assertions.every((item, index) => (
    exactKeys(item, ['name', 'expected', 'actual', 'status']) &&
    item.name === expected[index][0] &&
    item.expected === expected[index][1] &&
    item.actual === expected[index][2] &&
    item.status === 'PASS'
  ))
}

function loadGatewayFixture(caseOutput, expected, independentArchive = null) {
  const bodyPath = path.join(caseOutput, BODY_FILE)
  const evidencePath = path.join(caseOutput, GATEWAY_EVIDENCE_FILE)
  const bodyBytes = fs.readFileSync(bodyPath)
  const evidenceBytes = fs.readFileSync(evidencePath)
  const evidence = JSON.parse(evidenceBytes.toString('utf8'))
  if (
    !exactKeys(evidence, [
      'schemaVersion', 'status', 'sut', 'invocation', 'transport', 'request',
      'response', 'body', 'assertions', 'command', 'sourceIntegrity'
    ]) ||
    !exactKeys(evidence.sut, ['ref', 'resolvedCommit', 'tree', 'archiveSha256']) ||
    !exactKeys(evidence.invocation, ['mode', 'requestProfile']) ||
    !exactKeys(evidence.transport, ['kind', 'ports']) ||
    !exactKeys(evidence.request, ['method', 'path', 'headers']) ||
    !exactKeys(evidence.response, ['statusCode', 'headers']) ||
    !exactKeys(evidence.body, ['file', 'bytes', 'sha256', 'contractClassification']) ||
    !exactKeys(evidence.command, ['exitCode']) ||
    !exactKeys(evidence.sourceIntegrity, [
      'headBefore', 'headAfter', 'statusSha256Before', 'statusSha256After',
      'diffSha256Before', 'diffSha256After', 'unchanged'
    ]) ||
    evidence.schemaVersion !== 1 ||
    evidence.status !== 'PASS' ||
    evidence.sut?.ref !== FIXED_REFS[expected.gatewayRef] ||
    evidence.sut?.resolvedCommit !== FIXED_REFS[expected.gatewayRef] ||
    !/^[a-f0-9]{40}$/.test(String(evidence.sut?.tree || '')) ||
    !/^[a-f0-9]{64}$/.test(String(evidence.sut?.archiveSha256 || '')) ||
    (independentArchive && evidence.sut.tree !== independentArchive.tree) ||
    (independentArchive && evidence.sut.archiveSha256 !== independentArchive.archiveSha256) ||
    evidence.invocation?.mode !== expected.mode ||
    evidence.invocation?.requestProfile !== expected.requestProfile ||
    evidence.transport?.kind !== 'TestServer' ||
    !Array.isArray(evidence.transport?.ports) ||
    evidence.transport.ports.length !== 0 ||
    evidence.request?.method !== 'GET' ||
    evidence.request?.path !== '/api/desktop/bootstrap' ||
    !Array.isArray(evidence.request?.headers) ||
    evidence.request.headers.some(entry => !exactKeys(entry, ['name', 'values']) || !Array.isArray(entry.values)) ||
    evidence.response?.statusCode !== expected.expected.statusCode ||
    !Array.isArray(evidence.response?.headers) ||
    evidence.response.headers.some(entry => !exactKeys(entry, ['name', 'values']) || !Array.isArray(entry.values)) ||
    evidence.body?.file !== BODY_FILE ||
    evidence.body?.bytes !== bodyBytes.length ||
    evidence.body?.sha256 !== sha256(bodyBytes) ||
    evidence.command?.exitCode !== 0 ||
    evidence.sourceIntegrity?.unchanged !== true ||
    evidence.sourceIntegrity?.headBefore !== evidence.sourceIntegrity?.headAfter ||
    evidence.sourceIntegrity?.statusSha256Before !== evidence.sourceIntegrity?.statusSha256After ||
    evidence.sourceIntegrity?.diffSha256Before !== evidence.sourceIntegrity?.diffSha256After ||
    !/^[a-f0-9]{40}$/.test(String(evidence.sourceIntegrity?.headBefore || '')) ||
    !/^[a-f0-9]{64}$/.test(String(evidence.sourceIntegrity?.statusSha256Before || '')) ||
    !/^[a-f0-9]{64}$/.test(String(evidence.sourceIntegrity?.diffSha256Before || '')) ||
    !gatewayAssertionsMatch(
      evidence.assertions,
      evidence.body?.contractClassification,
      evidence.response?.statusCode,
      sha256(bodyBytes)
    )
  ) {
    throw new MatrixError('gateway_evidence_invalid')
  }
  return {
    bodyBytes,
    bodySha256: sha256(bodyBytes),
    evidence,
    evidenceSha256: sha256(evidenceBytes)
  }
}

function responseHeaders(evidence) {
  const headers = new Headers()
  for (const entry of evidence.response?.headers || []) {
    if (typeof entry?.name !== 'string' || !Array.isArray(entry.values)) {
      throw new MatrixError('gateway_response_headers_invalid')
    }
    headers.set(entry.name, entry.values.join(', '))
  }
  return headers
}

function fixtureUserIdentity(fixture) {
  let body
  try {
    body = JSON.parse(fixture.bodyBytes.toString('utf8'))
  } catch {
    throw new MatrixError('gateway_fixture_identity_invalid')
  }
  const id = String(body?.user?.id || '').trim().toLowerCase()
  const userName = String(body?.user?.userName || '').trim()
  if (id !== FIXED_SYNTHETIC_USER_ID ||
      userName !== 'x1-fixture-user') {
    throw new MatrixError('gateway_fixture_identity_invalid')
  }
  return { id, userName }
}

function jsonResponse(value, { method = 'GET', status = 200 } = {}) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    status: method === 'HEAD' ? 204 : status
  })
}

function createTransport(fixture, events) {
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl)
    const method = String(options.method || 'GET').toUpperCase()
    const authorization = new Headers(options.headers || {}).get('Authorization')
    const auth = authorization === `Bearer ${SYNTHETIC_DESKTOP_TOKEN}`
      ? 'synthetic-bearer'
      : authorization
        ? 'invalid'
        : 'missing'
    const rejectInvalidRequest = expectedMethod => {
      if (auth !== 'synthetic-bearer') {
        return jsonResponse({ code: 'x1_synthetic_auth_invalid' }, { method, status: 401 })
      }
      if (method !== expectedMethod) {
        return jsonResponse({ code: 'x1_synthetic_method_invalid' }, { method, status: 405 })
      }
      return null
    }
    if (url.pathname === '/api/desktop/bootstrap') {
      const contractHeader = new Headers(options.headers || {}).get(CONTRACT_HEADER)
      events.push({ auth, contractHeader, kind: 'bootstrap', method })
      const rejected = rejectInvalidRequest('GET')
      if (rejected) return rejected
      return new Response(Uint8Array.from(fixture.bodyBytes), {
        headers: responseHeaders(fixture.evidence),
        status: fixture.evidence.response.statusCode
      })
    }
    if (url.pathname === '/api/desktop/model-profiles') {
      events.push({ auth, kind: 'model-profiles', method })
      const rejected = rejectInvalidRequest('GET')
      if (rejected) return rejected
      return jsonResponse({ modelProfiles: [] }, { method })
    }
    if (url.pathname === '/api/desktop/runtime/manifests') {
      events.push({ auth, kind: 'runtime-manifest', method })
      const rejected = rejectInvalidRequest('POST')
      if (rejected) return rejected
      return jsonResponse({
        allowedModels: ['x1-model'],
        defaultModel: 'x1-model',
        gatewayApiBaseUrl: 'https://x1-fixture.invalid/api',
        gatewayToken: SYNTHETIC_GATEWAY_TOKEN,
        generatedAt: '2026-07-20T00:00:00.000Z',
        manifestId: 'x1-manifest',
        policyHash: sha256('x1-policy'),
        policyVersion: 'x1-policy-v1',
        sessionId: 'x1-session'
      }, { method })
    }
    events.push({ auth, kind: 'unexpected', method })
    return jsonResponse({ code: 'not-found' }, { status: 404 })
  }
}

function countEvents(events, kind) {
  return events.filter(event => event.kind === kind).length
}

const MANAGED_HOME_FILES = Object.freeze(['.env', 'config.yaml', 'enterprise-policy.json'])

function safeStateSnapshot(state) {
  if (!state || !Number.isInteger(state.version) || !Number.isInteger(state.writeCount) ||
      !/^[a-f0-9]{64}$/.test(String(state.hash || '')) ||
      !['unbound', 'fixed-synthetic'].includes(state.identityBinding) ||
      !Array.isArray(state.files) ||
      state.files.some(file => !exactKeys(file, ['file', 'bytes', 'sha256']) ||
        !MANAGED_HOME_FILES.includes(file.file) || !Number.isInteger(file.bytes) ||
        !/^[a-f0-9]{64}$/.test(String(file.sha256 || ''))) ||
      !exactKeys(state.policy, ['enterpriseUserBinding', 'enterpriseUserIdSha256', 'manifestId', 'policyVersion']) ||
      !['unbound', 'fixed-synthetic'].includes(state.policy.enterpriseUserBinding) ||
      (state.policy.enterpriseUserIdSha256 !== null &&
        !/^[a-f0-9]{64}$/.test(String(state.policy.enterpriseUserIdSha256)))) {
    throw new MatrixError('rollback_shared_state_invalid')
  }
  return {
    version: state.version,
    hash: state.hash,
    writeCount: state.writeCount,
    identityBinding: state.identityBinding,
    files: state.files.map(file => ({ ...file })),
    policy: { ...state.policy }
  }
}

function managedHomeSnapshot(hermesHome, {
  expectedUserId = null,
  identityBinding = 'unbound',
  version = 0,
  writeCount = 0
} = {}) {
  const files = []
  for (const file of MANAGED_HOME_FILES) {
    const target = path.join(hermesHome, file)
    if (!fs.existsSync(target)) continue
    const bytes = fs.readFileSync(target)
    files.push({ file, bytes: bytes.length, sha256: sha256(bytes) })
  }
  let policy = {
    enterpriseUserBinding: 'unbound',
    enterpriseUserIdSha256: null,
    manifestId: null,
    policyVersion: null
  }
  const policyPath = path.join(hermesHome, 'enterprise-policy.json')
  if (fs.existsSync(policyPath)) {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'))
    } catch {
      throw new MatrixError('rollback_managed_home_policy_invalid')
    }
    const enterpriseUserId = String(parsed?.enterpriseUserId || parsed?.user?.id || '').trim().toLowerCase()
    if (!expectedUserId || enterpriseUserId !== expectedUserId.toLowerCase()) {
      throw new MatrixError('rollback_managed_home_identity_invalid')
    }
    policy = {
      enterpriseUserBinding: 'fixed-synthetic',
      enterpriseUserIdSha256: sha256(enterpriseUserId),
      manifestId: parsed?.manifestId || null,
      policyVersion: parsed?.policyVersion || null
    }
    if (policy.manifestId !== 'x1-manifest' || policy.policyVersion !== 'x1-policy-v1') {
      throw new MatrixError('rollback_managed_home_policy_invalid')
    }
  }
  const state = {
    version,
    hash: sha256(JSON.stringify({ files, policy })),
    writeCount,
    identityBinding,
    files,
    policy
  }
  return safeStateSnapshot(state)
}

function captureManagedHome(hermesHome) {
  const files = new Map()
  if (fs.existsSync(hermesHome)) {
    for (const file of MANAGED_HOME_FILES) {
      const target = path.join(hermesHome, file)
      if (fs.existsSync(target)) files.set(file, fs.readFileSync(target))
    }
  }
  return files
}

function restoreManagedHome(hermesHome, files) {
  fs.rmSync(hermesHome, { force: true, recursive: true })
  if (files.size === 0) return
  fs.mkdirSync(hermesHome, { recursive: true })
  for (const [file, bytes] of files) fs.writeFileSync(path.join(hermesHome, file), bytes)
}

function writeRollbackHome({ context, identityBinding, payload, writer }) {
  validateRollbackContext(context)
  if (typeof writer !== 'function') throw new MatrixError('rollback_writer_missing')
  const before = safeStateSnapshot(context.state)
  const backup = captureManagedHome(context.managedHome)
  let fileWriteCount = 0
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === 'writeFileSync') {
        return (...args) => {
          fileWriteCount += 1
          return target.writeFileSync(...args)
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  try {
    const launch = writer({ ...payload, fsImpl, hermesHome: context.managedHome })
    if (fileWriteCount !== MANAGED_HOME_FILES.length) throw new MatrixError('rollback_writer_write_count_invalid')
    const after = managedHomeSnapshot(context.managedHome, {
      expectedUserId: context.expectedUserId,
      identityBinding,
      version: payload.bootstrap?.bootstrapContractVersion ?? 1,
      writeCount: before.writeCount + 1
    })
    if (after.files.length !== MANAGED_HOME_FILES.length) throw new MatrixError('rollback_managed_home_incomplete')
    context.state = after
    return { launch, stateTransition: { before, after: safeStateSnapshot(after) } }
  } catch (error) {
    restoreManagedHome(context.managedHome, backup)
    context.state = before
    const restored = managedHomeSnapshot(context.managedHome, {
      ...before,
      expectedUserId: context.expectedUserId
    })
    if (JSON.stringify(restored) !== JSON.stringify(before)) {
      throw new MatrixError('rollback_failed_step_mutated_home')
    }
    throw error
  }
}

function createRollbackContext(managedHome, expectedUserId) {
  if (!managedHome || !expectedUserId) throw new MatrixError('rollback_shared_context_missing')
  const initial = managedHomeSnapshot(managedHome, { expectedUserId })
  return {
    authStore: {
      clear: () => {},
      readSession: () => ({ desktopToken: SYNTHETIC_DESKTOP_TOKEN })
    },
    managedHome,
    expectedUserId,
    state: initial
  }
}

function validateRollbackContext(context) {
  if (!context || typeof context.authStore?.readSession !== 'function' ||
      typeof context.managedHome !== 'string' || !context.managedHome ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
        .test(String(context.expectedUserId || ''))) {
    throw new MatrixError('rollback_shared_context_missing')
  }
  safeStateSnapshot(context.state)
  return context
}

async function consumeWithArchivedDesktop({ archiveRoot, fixture, item, rollbackContext = null }) {
  const electronRoot = path.join(archiveRoot, 'apps', 'desktop', 'electron')
  const gatewayModule = require(path.join(electronRoot, 'enterprise-gateway-client.cjs'))
  const runtimeModule = require(path.join(electronRoot, 'enterprise-runtime.cjs'))
  const homeModule = rollbackContext
    ? require(path.join(electronRoot, 'enterprise-runtime-home.cjs'))
    : null
  const events = []
  let homeBootstrapContractVersion = null
  const context = rollbackContext ? validateRollbackContext(rollbackContext) : null
  const stateBefore = context ? safeStateSnapshot(context.state) : null
  let pendingIdentityBinding = context?.state.identityBinding || 'unbound'
  const authStore = context?.authStore || {
    clear: () => {},
    readSession: () => ({ desktopToken: SYNTHETIC_DESKTOP_TOKEN })
  }
  const client = gatewayModule.createEnterpriseGatewayClient({
    baseUrl: 'https://x1-fixture.invalid',
    fetchImpl: createTransport(fixture, events)
  })
  const runtime = runtimeModule.createEnterpriseRuntime({
    authStore,
    client,
    enabled: true,
    managedHermesHome: rollbackContext ? context.managedHome : 'x1-managed-home',
    managedIdentityBinder: ({ hermesHome, user } = {}) => {
      if (context && (
        comparablePath(hermesHome) !== comparablePath(context.managedHome) ||
        String(user?.id || '').trim().toLowerCase() !== context.expectedUserId.toLowerCase() ||
        String(user?.userName || '').trim() !== 'x1-fixture-user'
      )) {
        throw new MatrixError('rollback_managed_identity_mismatch')
      }
      pendingIdentityBinding = 'fixed-synthetic'
      events.push({ kind: 'identity-binding' })
    },
    homeWriter: payload => {
      const { bootstrap } = payload
      homeBootstrapContractVersion = bootstrap?.bootstrapContractVersion ?? null
      events.push({ kind: 'home-writer' })
      if (rollbackContext) {
        return writeRollbackHome({
          context,
          identityBinding: pendingIdentityBinding,
          payload,
          writer: homeModule.writeManagedRuntimeHome
        }).launch
      }
      return {
        env: {},
        hermesHome: 'x1-managed-home',
        publicState: { authenticated: true, enabled: true, status: 'authenticated' }
      }
    }
  })

  let errorCode = null
  let succeeded = false
  try {
    await runtime.prepareLaunch()
    succeeded = true
  } catch (error) {
    errorCode = safeCode(error, 'desktop_runtime_failed')
  }

  return {
    counts: {
      bootstrap: countEvents(events, 'bootstrap'),
      home: countEvents(events, 'home-writer'),
      manifest: countEvents(events, 'runtime-manifest'),
      profiles: countEvents(events, 'model-profiles'),
      unexpected: countEvents(events, 'unexpected')
    },
    errorCode,
    homeBootstrapContractVersion,
    requestContractHeader: events.find(event => event.kind === 'bootstrap')?.contractHeader ?? null,
    succeeded,
    eventOrder: events.map(event => event.kind),
    events: events.map(event => ({
      kind: event.kind,
      ...(event.method ? { method: event.method } : {}),
      ...(event.auth ? { auth: event.auth } : {}),
      ...(Object.prototype.hasOwnProperty.call(event, 'contractHeader')
        ? { contractHeader: event.contractHeader }
        : {})
    })),
    stateTransition: {
      before: stateBefore,
      after: context ? safeStateSnapshot(context.state) : null
    }
  }
}

function runtimeMatches(item, result) {
  return result.succeeded === (item.expected.errorCode === null) && result.errorCode === item.expected.errorCode
}

function countsMatch(item, result) {
  return (
    result.counts.bootstrap === 1 &&
    result.counts.profiles === item.expected.profiles &&
    result.counts.manifest === item.expected.manifest &&
    result.counts.home === item.expected.home &&
    result.counts.unexpected === 0
  )
}

function eventOrderMatches(item, result) {
  const expected = item.expected.errorCode === null
    ? item.desktopRef === 'desktopP2'
      ? ['bootstrap', 'model-profiles', 'runtime-manifest', 'identity-binding', 'home-writer']
      : ['bootstrap', 'model-profiles', 'runtime-manifest', 'home-writer']
    : item.id === 'p2-required-p1-desktop'
      ? ['bootstrap', 'model-profiles']
      : ['bootstrap']
  return result.eventOrder.join('\0') === expected.join('\0') && transportEventsMatch(result.events)
}

function transportEventsMatch(events) {
  if (!Array.isArray(events)) return false
  const expectedMethods = {
    bootstrap: 'GET',
    'model-profiles': 'GET',
    'runtime-manifest': 'POST'
  }
  for (const event of events) {
    if (event.kind === 'home-writer' || event.kind === 'identity-binding') continue
    if (!(event.kind in expectedMethods)) return false
    if (event.method !== expectedMethods[event.kind] || event.auth !== 'synthetic-bearer') return false
  }
  return true
}

function rollbackTransitionMatches(previousAfter, result, step = null) {
  try {
    const before = safeStateSnapshot(result?.stateTransition?.before)
    const after = safeStateSnapshot(result?.stateTransition?.after)
    if (previousAfter && JSON.stringify(before) !== JSON.stringify(previousAfter)) return false
    const expectedVersion = step?.rollbackStep === 'gateway-p1' ? 1 : 2
    const semanticHashMatches = step?.rollbackStep !== 'gateway-p1' || after.hash !== before.hash
    return (
      after.writeCount === before.writeCount + 1 &&
      after.version === expectedVersion &&
      after.identityBinding === 'fixed-synthetic' &&
      after.files.length === MANAGED_HOME_FILES.length &&
      after.policy.enterpriseUserBinding === 'fixed-synthetic' &&
      /^[a-f0-9]{64}$/.test(after.policy.enterpriseUserIdSha256) &&
      after.policy.manifestId === 'x1-manifest' &&
      after.policy.policyVersion === 'x1-policy-v1' &&
      semanticHashMatches
    )
  } catch {
    return false
  }
}

async function runRollbackSequence({ context, steps, executeStep }) {
  validateRollbackContext(context)
  if (!Array.isArray(steps) || typeof executeStep !== 'function') {
    throw new MatrixError('rollback_sequence_invalid')
  }
  const completed = []
  let previousAfter = safeStateSnapshot(context.state)
  for (const step of steps) {
    let result
    try {
      result = await executeStep(step, context, previousAfter)
    } catch (error) {
      return {
        completed,
        errorCode: safeCode(error, 'rollback_step_interrupted'),
        finalState: safeStateSnapshot(context.state),
        stoppedAt: step.rollbackStep
      }
    }
    if (!result?.passed || !rollbackTransitionMatches(previousAfter, result.runtime, step)) {
      return {
        completed,
        errorCode: 'rollback_step_failed',
        finalState: safeStateSnapshot(context.state),
        stoppedAt: step.rollbackStep
      }
    }
    previousAfter = safeStateSnapshot(result.runtime.stateTransition.after)
    completed.push(step.rollbackStep)
  }
  return { completed, errorCode: null, finalState: safeStateSnapshot(context.state), stoppedAt: null }
}

async function executeRollbackPhase({ assertions, context, steps, executeStep }) {
  const sequence = await runRollbackSequence({ context, steps, executeStep })
  const expected = ['required', 'p2-compatible', 'desktop-p1', 'gateway-p1']
  const passed = sequence.errorCode === null && sequence.completed.join('\0') === expected.join('\0')
  setAssertion(
    assertions,
    'rollback.order',
    passed ? 'PASS' : 'FAIL',
    passed ? null : (sequence.errorCode || 'rollback_order_incomplete')
  )
  return sequence
}

async function executeOrdinaryPhase({ steps, executeStep }) {
  const completed = []
  for (const step of steps) {
    const result = await executeStep(step)
    if (!result?.passed) {
      return {
        completed,
        errorCode: result?.failureCode || 'ordinary_case_failed',
        stoppedAt: step.id
      }
    }
    completed.push(step.id)
  }
  return { completed, errorCode: null, stoppedAt: null }
}

function contractMatches(item, fixture, result) {
  const expectedHeader = item.requestProfile === 'p2' ? '2' : null
  if (result.requestContractHeader !== expectedHeader) return false
  if (item.id === 'p1-gateway-p2-desktop') {
    return fixture.evidence.body.contractClassification === 'legacy' && result.errorCode === 'enterprise_gateway_contract_too_old'
  }
  if (item.id === 'p2-compatible-p1-desktop') {
    return fixture.evidence.body.contractClassification === 'v2' && result.homeBootstrapContractVersion === 2
  }
  if (item.id === 'p2-required-p1-desktop') {
    return fixture.evidence.body.contractClassification === 'problem' && result.counts.profiles === 1
  }
  if (item.expected.statusCode === 200) {
    const expectedClassification = item.gatewayRef === 'gatewayP1' ? 'legacy' : 'v2'
    return fixture.evidence.body.contractClassification === expectedClassification
  }
  return true
}

function archiveKey(kind, refName) {
  return `${kind}-${refName}`
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
  return `x1-enterprise-bootstrap-matrix-${stamp}-${crypto.randomUUID().slice(0, 8)}`
}

function makeShortTempRoot() {
  return path.join(os.tmpdir(), `x1m-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`)
}

function ownedTempOwner(item, index) {
  if (!item?.id || !Number.isInteger(index) || index < 0) {
    throw new MatrixError('matrix_temp_owner_invalid')
  }
  return `e${String(index).padStart(2, '0')}-${sha256(item.id).slice(0, 6)}`
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function comparablePath(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '') || path.parse(path.resolve(value)).root
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function pathEntryExists(target) {
  try {
    fs.lstatSync(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function pathComponents(target) {
  const resolved = path.resolve(target)
  const parsed = path.parse(resolved)
  const relative = resolved.slice(parsed.root.length)
  const parts = relative.split(path.sep).filter(Boolean)
  const components = [parsed.root]
  let current = parsed.root
  for (const part of parts) {
    current = path.join(current, part)
    components.push(current)
  }
  return components
}

function inspectCanonicalPath(target, { mustExist = false } = {}) {
  const resolved = path.resolve(target)
  let nearestExisting = null
  for (const component of pathComponents(resolved)) {
    let stat
    try {
      stat = fs.lstatSync(component)
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
    if (stat.isSymbolicLink()) throw new MatrixError('matrix_path_reparse_forbidden')
    const real = fs.realpathSync.native(component)
    if (comparablePath(real) !== comparablePath(component)) {
      throw new MatrixError('matrix_path_reparse_forbidden')
    }
    nearestExisting = component
  }
  if (!nearestExisting) throw new MatrixError('matrix_path_ancestor_unavailable')
  if (mustExist && !fs.existsSync(resolved)) throw new MatrixError('matrix_source_root_invalid')
  if (fs.existsSync(resolved) && !fs.lstatSync(resolved).isDirectory()) {
    throw new MatrixError('matrix_path_not_directory')
  }
  const canonicalAncestor = fs.realpathSync.native(nearestExisting)
  const canonical = path.resolve(canonicalAncestor, path.relative(nearestExisting, resolved))
  return { canonical, nearestExisting, resolved }
}

function assertNoBidirectionalOverlap(left, right) {
  if (isWithin(left, right) || isWithin(right, left)) {
    throw new MatrixError('matrix_output_overlaps_source')
  }
}

function validateRoots(options, { runRoot = null, tempRoot = null } = {}) {
  if (
    !fs.existsSync(path.join(options.desktopSourceRoot, '.git')) ||
    !fs.existsSync(path.join(options.gatewaySourceRoot, '.git'))
  ) {
    throw new MatrixError('matrix_source_root_invalid')
  }
  const desktop = inspectCanonicalPath(options.desktopSourceRoot, { mustExist: true })
  const gateway = inspectCanonicalPath(options.gatewaySourceRoot, { mustExist: true })
  const output = inspectCanonicalPath(options.outputDirectory)
  assertNoBidirectionalOverlap(output.canonical, desktop.canonical)
  assertNoBidirectionalOverlap(output.canonical, gateway.canonical)

  if (runRoot) {
    const run = inspectCanonicalPath(runRoot)
    assertNoBidirectionalOverlap(run.canonical, desktop.canonical)
    assertNoBidirectionalOverlap(run.canonical, gateway.canonical)
  }
  if (tempRoot) {
    const temporary = inspectCanonicalPath(tempRoot)
    assertNoBidirectionalOverlap(temporary.canonical, desktop.canonical)
    assertNoBidirectionalOverlap(temporary.canonical, gateway.canonical)
    assertNoBidirectionalOverlap(temporary.canonical, output.canonical)
  }
  return { desktop, gateway, output }
}

function prepareRunDirectories(options, runRoot, tempRoot) {
  // This preflight is intentionally side-effect free. It resolves every
  // existing component before any persistent or temporary directory exists.
  validateRoots(options, { runRoot, tempRoot })
  const outputExisted = fs.existsSync(options.outputDirectory)
  let runCreated = false
  let tempCreated = false
  try {
    fs.mkdirSync(options.outputDirectory, { recursive: true })
    fs.mkdirSync(runRoot)
    runCreated = true
    fs.mkdirSync(tempRoot)
    tempCreated = true
    // Re-evaluate all now-existing components and canonical containment to
    // close the create-time race as far as the filesystem API permits.
    validateRoots(options, { runRoot, tempRoot })
  } catch (error) {
    // Never delete a pre-existing path after a create collision. Only remove
    // directories this invocation successfully created.
    let cleanupPassed = true
    for (const [created, target] of [[tempCreated, tempRoot], [runCreated, runRoot]]) {
      if (!created) continue
      try {
        fs.rmSync(target, { force: true, recursive: true })
      } catch {
        cleanupPassed = false
      }
      if (pathEntryExists(target)) cleanupPassed = false
    }
    if (!outputExisted) {
      try { fs.rmdirSync(options.outputDirectory) } catch {}
    }
    if (!cleanupPassed) throw new MatrixError('matrix_directory_cleanup_failed')
    throw error
  }
}

function createOwnedTempEnvironment(tempRoot, owner) {
  const safeOwner = String(owner || '')
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(safeOwner)) {
    throw new MatrixError('matrix_temp_owner_invalid')
  }
  const temp = inspectCanonicalPath(tempRoot, { mustExist: true })
  const childRoot = path.join(tempRoot, 'child-temp')
  const ownedRoot = path.join(childRoot, safeOwner)
  let childCreated = false
  let ownerCreated = false
  try {
    if (!pathEntryExists(childRoot)) {
      fs.mkdirSync(childRoot)
      childCreated = true
    }
    const child = inspectCanonicalPath(childRoot, { mustExist: true })
    if (!isWithin(child.canonical, temp.canonical) ||
        comparablePath(child.canonical) === comparablePath(temp.canonical)) {
      throw new MatrixError('matrix_temp_owner_escape')
    }
    if (!fs.lstatSync(childRoot).isDirectory()) throw new MatrixError('matrix_path_not_directory')

    if (!isWithin(path.resolve(ownedRoot), path.resolve(childRoot))) {
      throw new MatrixError('matrix_temp_owner_escape')
    }
    if (process.platform === 'win32' && ownedRoot.length > MAX_OWNED_TEMP_PATH_LENGTH) {
      throw new MatrixError('matrix_temp_path_too_long')
    }
    if (pathEntryExists(ownedRoot)) throw new MatrixError('matrix_temp_owner_preexisting')
    fs.mkdirSync(ownedRoot)
    ownerCreated = true
    const owned = inspectCanonicalPath(ownedRoot, { mustExist: true })
    if (!isWithin(owned.canonical, child.canonical) ||
        comparablePath(owned.canonical) === comparablePath(child.canonical) ||
        !isWithin(owned.canonical, temp.canonical)) {
      throw new MatrixError('matrix_temp_owner_escape')
    }
    if (!fs.lstatSync(ownedRoot).isDirectory()) throw new MatrixError('matrix_path_not_directory')
    return {
      environment: { TEMP: ownedRoot, TMP: ownedRoot },
      ownedRoot
    }
  } catch (error) {
    if (ownerCreated) removeCreatedEmptyDirectory(ownedRoot)
    if (childCreated) removeCreatedEmptyDirectory(childRoot)
    throw error
  }
}

function removeCreatedEmptyDirectory(target) {
  try {
    const stat = fs.lstatSync(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    if (comparablePath(fs.realpathSync.native(target)) !== comparablePath(target)) return false
    fs.rmdirSync(target)
    return !pathEntryExists(target)
  } catch {
    return !pathEntryExists(target)
  }
}

function createProcessRunner(commandRecords, { cleanupTimeoutMs = 10000, spawnImpl = spawn } = {}) {
  const active = new Set()
  let cancelled = false
  let cancellationPromise = null

  function waitForClose(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
    return new Promise(resolve => {
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.removeListener('close', onClose)
        resolve(value)
      }
      const onClose = () => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref?.()
      child.once('close', onClose)
    })
  }

  async function killTree(child) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return true
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        let killer
        try {
          killer = spawnImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            shell: false,
            stdio: 'ignore',
            windowsHide: true
          })
        } catch {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          try { killer.kill('SIGKILL') } catch {}
          resolve()
        }, Math.min(cleanupTimeoutMs, 5000))
        timer.unref?.()
        killer.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        killer.once('error', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch {
        try { child.kill('SIGTERM') } catch {}
      }
    }
    if (await waitForClose(child, Math.floor(cleanupTimeoutMs / 2))) return true
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL') } catch {
        try { child.kill('SIGKILL') } catch {}
      }
    } else {
      try { child.kill('SIGKILL') } catch {}
    }
    return waitForClose(child, Math.ceil(cleanupTimeoutMs / 2))
  }

  const cancel = () => {
    if (cancellationPromise) return cancellationPromise
    cancelled = true
    cancellationPromise = Promise.all([...active].map(async entry => {
      const cleaned = await killTree(entry.child)
      if (!cleaned) entry.record.cleanupStatus = 'alive-after-timeout'
      return cleaned
    })).then(results => results.every(Boolean))
    return cancellationPromise
  }

  async function run(id, command, args, { cwd, env = null } = {}) {
    if (cancelled) throw new MatrixError('matrix_cancelled')
    const record = {
      id,
      pid: null,
      exitCode: null,
      cleanupStatus: 'NOT_RUN',
      stdoutSha256: null,
      stderrSha256: null
    }
    commandRecords.push(record)
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawnImpl(command, args, {
          cwd,
          env: env ? { ...process.env, ...env } : process.env,
          detached: process.platform !== 'win32',
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch {
        record.cleanupStatus = 'not-started'
        reject(new MatrixError('matrix_child_start_failed'))
        return
      }
      record.pid = child.pid || null
      const entry = { child, record }
      active.add(entry)
      const stdout = []
      const stderr = []
      child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
      child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
      child.on('error', () => {
        active.delete(entry)
        record.cleanupStatus = child.exitCode === null ? 'start-failed' : 'exited'
        reject(new MatrixError('matrix_child_start_failed'))
      })
      child.on('close', code => {
        active.delete(entry)
        const stdoutBytes = Buffer.concat(stdout)
        const stderrBytes = Buffer.concat(stderr)
        record.exitCode = Number.isInteger(code) ? code : -1
        record.cleanupStatus = 'exited'
        record.stdoutSha256 = sha256(stdoutBytes)
        record.stderrSha256 = sha256(stderrBytes)
        resolve({ exitCode: record.exitCode, stderr: stderrBytes, stdout: stdoutBytes })
      })
    })
  }

  return {
    active,
    cancel,
    get cancelled() { return cancelled },
    run,
    waitForCleanup: () => cancellationPromise || Promise.resolve(true)
  }
}

async function cleanupOwnedTempRoot({ runner, tempRoot }) {
  let processesClean = false
  let filesystemClean = false
  try {
    if (runner.active.size > 0) await runner.cancel()
    const cleanupResult = await runner.waitForCleanup()
    processesClean = cleanupResult === true && runner.active.size === 0
  } catch {
    processesClean = false
  }
  try {
    fs.rmSync(tempRoot, { force: true, recursive: true })
    filesystemClean = !fs.existsSync(tempRoot)
  } catch {
    filesystemClean = false
  }
  return { filesystemClean, passed: processesClean && filesystemClean, processesClean }
}

async function gitBytes(runner, id, root, args) {
  const result = await runner.run(id, 'git', ['-C', root, ...args])
  if (result.exitCode !== 0) throw new MatrixError('matrix_git_command_failed')
  return result.stdout
}

async function sourceState(runner, kind, root) {
  const head = (await gitBytes(runner, `${kind}-head`, root, ['rev-parse', 'HEAD'])).toString('utf8').trim()
  const status = await gitBytes(runner, `${kind}-status`, root, ['status', '--porcelain=v1', '--untracked-files=all'])
  const unstaged = await gitBytes(runner, `${kind}-diff`, root, ['diff', '--binary', '--no-ext-diff'])
  const staged = await gitBytes(runner, `${kind}-diff-cached`, root, ['diff', '--cached', '--binary', '--no-ext-diff'])
  return {
    head,
    dirty: status.length > 0,
    statusSha256: sha256(status),
    trackedDiffSha256: sha256(Buffer.concat([unstaged, staged]))
  }
}

function sourceStatesEqual(before, after) {
  return (
    before?.head === after?.head &&
    before?.dirty === after?.dirty &&
    before?.statusSha256 === after?.statusSha256 &&
    before?.trackedDiffSha256 === after?.trackedDiffSha256
  )
}

async function verifyFixedRefs(runner, desktopRoot, gatewayRoot) {
  const resolved = {}
  for (const [name, ref] of Object.entries(FIXED_REFS)) {
    const root = name.startsWith('desktop') ? desktopRoot : gatewayRoot
    const actual = (await gitBytes(runner, `verify-${name}`, root, ['rev-parse', '--verify', `${ref}^{commit}`]))
      .toString('utf8')
      .trim()
      .toLowerCase()
    if (actual !== ref) throw new MatrixError('matrix_fixed_ref_mismatch')
    const tree = (await gitBytes(runner, `verify-${name}-tree`, root, [
      'rev-parse', '--verify', `${ref}^{tree}`
    ])).toString('utf8').trim().toLowerCase()
    if (!/^[a-f0-9]{40}$/.test(tree)) throw new MatrixError('matrix_fixed_tree_invalid')
    resolved[name] = { ref, resolvedCommit: actual, tree }
  }
  return resolved
}

async function createArchive(runner, { destination, extract = true, format = 'tar', id, ref, root }) {
  const archivePath = `${destination}.${format}`
  if (extract) fs.mkdirSync(destination, { recursive: true })
  const archived = await runner.run(`${id}-archive`, 'git', [
    '-C', root, 'archive', `--format=${format}`, '--output', archivePath, ref
  ])
  if (archived.exitCode !== 0) throw new MatrixError('matrix_git_archive_failed')
  const archiveSha256 = sha256(fs.readFileSync(archivePath))
  if (extract) {
    const extracted = await runner.run(`${id}-extract`, 'tar', ['-xf', archivePath, '-C', destination])
    if (extracted.exitCode !== 0) throw new MatrixError('matrix_archive_extract_failed')
  }
  fs.rmSync(archivePath, { force: true })
  return { archiveSha256, format }
}

function reportCase(item, fixture, result) {
  return {
    id: item.id,
    gateway: { ref: FIXED_REFS[item.gatewayRef], mode: item.mode },
    desktop: { ref: FIXED_REFS[item.desktopRef], requestProfile: item.requestProfile },
    rollbackStep: item.rollbackStep || null,
    raw: {
      bodyFile: `${item.id}/${BODY_FILE}`,
      bodyBytes: fixture.bodyBytes.length,
      bodySha256: fixture.bodySha256,
      evidenceFile: `${item.id}/${GATEWAY_EVIDENCE_FILE}`,
      evidenceSha256: fixture.evidenceSha256
    },
    response: {
      contractClassification: fixture.evidence.body.contractClassification,
      statusCode: fixture.evidence.response.statusCode
    },
    runtime: {
      counts: result.counts,
      errorCode: result.errorCode,
      eventOrder: result.eventOrder,
      events: result.events,
      requestContractHeader: result.requestContractHeader,
      succeeded: result.succeeded,
      stateTransition: item.rollbackStep ? result.stateTransition : null
    }
  }
}

function validateRunnerIdentity(identity, source) {
  const actualScriptSha256 = sha256(fs.readFileSync(__filename))
  return (
    exactKeys(identity, ['scriptSha256', 'sourceHead']) &&
    identity.scriptSha256 === actualScriptSha256 &&
    /^[a-f0-9]{40}$/.test(String(identity.sourceHead || '')) &&
    identity.sourceHead === source?.desktop?.before?.head
  )
}

function sensitiveBytesMatch(bytes, forbiddenValues) {
  const text = Buffer.from(bytes).toString('utf8')
  const normalizedText = text.replaceAll('\\\\', '\\')
  if (/\b(?:dsk|gw)_[A-Za-z0-9._-]{8,}\b/.test(text)) return true
  return forbiddenValues.some(value => (
    value && normalizedText.toLowerCase().includes(String(value).toLowerCase())
  ))
}

function scanOutputFiles(root, forbiddenValues) {
  const pending = [root]
  let scanned = 0
  while (pending.length) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(target)
        continue
      }
      if (!entry.isFile()) continue
      const bytes = fs.readFileSync(target)
      scanned += 1
      if (sensitiveBytesMatch(bytes, forbiddenValues)) return { passed: false, scanned }
    }
  }
  return { passed: true, scanned }
}

function prepareManifestForPublish(manifest, forbiddenValues) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  if (sensitiveBytesMatch(bytes, forbiddenValues)) {
    throw new MatrixError('matrix_manifest_sensitive_value_detected')
  }
  return bytes
}

function writeManifestLast(runRoot, manifest, { preparedBytes = null } = {}) {
  const finalPath = path.join(runRoot, MATRIX_MANIFEST_FILE)
  const temporaryPath = path.join(runRoot, `.${MATRIX_MANIFEST_FILE}.${crypto.randomUUID()}.tmp`)
  const serialized = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  if (preparedBytes && !Buffer.from(preparedBytes).equals(serialized)) {
    throw new MatrixError('matrix_manifest_prepared_bytes_mismatch')
  }
  const bytes = preparedBytes || serialized
  fs.writeFileSync(temporaryPath, bytes, { flag: 'wx' })
  fs.renameSync(temporaryPath, finalPath)
  return { file: MATRIX_MANIFEST_FILE, sha256: sha256(bytes) }
}

async function executeMatrix(options) {
  const assertions = createAssertions()
  const commandRecords = []
  const cases = []
  const runner = createProcessRunner(commandRecords)
  const runId = makeRunId()
  const runRoot = path.join(options.outputDirectory, runId)
  const tempRoot = makeShortTempRoot()
  let source = null
  let fatalCode = null
  let cleanupPassed = false
  let exporterProject
  let exporterProjectSha256 = null
  let exporterArchiveSha256 = null
  let runnerIdentity = null
  let rollbackHome = null
  let expectedSyntheticUserId = null
  const fixedRefArchives = {}
  prepareRunDirectories(options, runRoot, tempRoot)

  const onSignal = () => runner.cancel()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    try {
      validateRoots(options, { runRoot, tempRoot })
      if (!/^[a-f0-9]{40}$/.test(String(GATEWAY_EXPORTER_REF || ''))) {
        throw new MatrixError('matrix_gateway_exporter_ref_not_pinned')
      }
      source = {
        desktop: { before: await sourceState(runner, 'desktop-source-before', options.desktopSourceRoot) },
        gateway: { before: await sourceState(runner, 'gateway-source-before', options.gatewaySourceRoot) }
      }
      runnerIdentity = {
        scriptSha256: sha256(fs.readFileSync(__filename)),
        sourceHead: source.desktop.before.head
      }
      setAssertion(
        assertions,
        'evidence.runner-identity',
        validateRunnerIdentity(runnerIdentity, source) ? 'PASS' : 'FAIL',
        validateRunnerIdentity(runnerIdentity, source) ? null : 'matrix_runner_identity_invalid'
      )
      const resolvedFixedRefs = await verifyFixedRefs(runner, options.desktopSourceRoot, options.gatewaySourceRoot)
      const exporterActual = (await gitBytes(
        runner,
        'verify-gateway-exporter',
        options.gatewaySourceRoot,
        ['rev-parse', '--verify', `${GATEWAY_EXPORTER_REF}^{commit}`]
      )).toString('utf8').trim().toLowerCase()
      if (exporterActual !== GATEWAY_EXPORTER_REF) throw new MatrixError('matrix_gateway_exporter_ref_mismatch')
      setAssertion(assertions, 'preflight.fixed-refs', 'PASS')

      const archives = new Map()
      for (const [refName, ref] of Object.entries(FIXED_REFS)) {
        const kind = refName.startsWith('desktop') ? 'desktop' : 'gateway'
        const root = kind === 'desktop' ? options.desktopSourceRoot : options.gatewaySourceRoot
        const destination = path.join(tempRoot, archiveKey(kind, refName))
        const archive = await createArchive(runner, {
          destination,
          extract: kind === 'desktop',
          format: kind === 'desktop' ? 'tar' : 'zip',
          id: archiveKey(kind, refName),
          ref,
          root
        })
        if (kind === 'desktop') archives.set(refName, destination)
        fixedRefArchives[refName] = {
          ...resolvedFixedRefs[refName],
          archiveFormat: archive.format,
          archiveSha256: archive.archiveSha256
        }
      }
      const exporterArchive = path.join(tempRoot, 'gateway-exporter')
      const exporterArchiveEvidence = await createArchive(runner, {
        destination: exporterArchive,
        id: 'gateway-exporter',
        ref: GATEWAY_EXPORTER_REF,
        root: options.gatewaySourceRoot
      })
      exporterArchiveSha256 = exporterArchiveEvidence.archiveSha256
      exporterProject = path.join(
        exporterArchive,
        'tools',
        'X1.DesktopBootstrapExporter',
        'X1.DesktopBootstrapExporter.csproj'
      )
      if (!fs.existsSync(exporterProject)) throw new MatrixError('matrix_gateway_exporter_archive_invalid')
      exporterProjectSha256 = sha256(fs.readFileSync(exporterProject))
      setAssertion(assertions, 'preflight.gateway-exporter', 'PASS')
      setAssertion(assertions, 'preflight.archive-only', 'PASS')

      const executeItem = async (item, rollbackContext = null, previousAfter = null) => {
        const caseOutput = path.join(runRoot, item.id)
        fs.mkdirSync(caseOutput)
        const itemIndex = CASES.indexOf(item)
        const exporterTemp = createOwnedTempEnvironment(tempRoot, ownedTempOwner(item, itemIndex))
        const exported = await runner.run(`export-${item.id}`, 'dotnet', [
          'run',
          '--project', exporterProject,
          '--configuration', 'Release',
          '--',
          // The archived exporter independently resolves and archives this Git
          // root at sut-ref; passing a pre-extracted directory would allow a
          // caller-declared ref to diverge from the executed source.
          '--gateway-source-root', options.gatewaySourceRoot,
          '--sut-ref', FIXED_REFS[item.gatewayRef],
          '--mode', item.mode,
          '--request-profile', item.requestProfile,
          '--output-directory', caseOutput
        ], { cwd: exporterArchive, env: exporterTemp.environment })
        if (exported.exitCode !== 0) {
          setAssertion(assertions, `${item.id}.exporter-exit`, 'FAIL', 'gateway_exporter_nonzero')
          return { failureCode: 'gateway_exporter_nonzero', passed: false, runtime: null }
        }
        setAssertion(assertions, `${item.id}.exporter-exit`, 'PASS')

        let fixture
        try {
          fixture = loadGatewayFixture(caseOutput, item, fixedRefArchives[item.gatewayRef])
          if (item.id === 'p2-required-p2-desktop') {
            expectedSyntheticUserId = fixtureUserIdentity(fixture).id
          }
          setAssertion(assertions, `${item.id}.raw-evidence-integrity`, 'PASS')
        } catch (error) {
          setAssertion(assertions, `${item.id}.raw-evidence-integrity`, 'FAIL', safeCode(error))
          return { failureCode: safeCode(error), passed: false, runtime: null }
        }

        let result
        try {
          result = await consumeWithArchivedDesktop({
            archiveRoot: archives.get(item.desktopRef),
            fixture,
            item,
            rollbackContext
          })
        } catch (error) {
          setAssertion(assertions, `${item.id}.runtime-outcome`, 'FAIL', safeCode(error))
          return { failureCode: safeCode(error), passed: false, runtime: null }
        }
        const outcomePassed = runtimeMatches(item, result)
        const sequencePassed = countsMatch(item, result) && eventOrderMatches(item, result)
        const contractPassed = contractMatches(item, fixture, result)
        setAssertion(
          assertions,
          `${item.id}.runtime-outcome`,
          outcomePassed ? 'PASS' : 'FAIL',
          outcomePassed ? null : 'desktop_runtime_outcome_mismatch'
        )
        setAssertion(
          assertions,
          `${item.id}.request-counts`,
          sequencePassed ? 'PASS' : 'FAIL',
          sequencePassed ? null : 'desktop_runtime_request_sequence_mismatch'
        )
        setAssertion(
          assertions,
          `${item.id}.contract-semantics`,
          contractPassed ? 'PASS' : 'FAIL',
          contractPassed ? null : 'desktop_contract_semantics_mismatch'
        )
        let sharedStatePassed = true
        if (item.rollbackStep) {
          sharedStatePassed = rollbackTransitionMatches(previousAfter, result, item)
          setAssertion(
            assertions,
            `${item.id}.shared-state`,
            sharedStatePassed ? 'PASS' : 'FAIL',
            sharedStatePassed ? null : 'rollback_shared_state_discontinuous'
          )
        }
        cases.push(reportCase(item, fixture, result))
        return {
          failureCode: outcomePassed && sequencePassed && contractPassed && sharedStatePassed
            ? null
            : 'desktop_case_assertion_failed',
          passed: outcomePassed && sequencePassed && contractPassed && sharedStatePassed,
          runtime: result
        }
      }

      const ordinarySequence = await executeOrdinaryPhase({
        steps: CASES.filter(candidate => !candidate.rollbackStep),
        executeStep: executeItem
      })
      if (ordinarySequence.errorCode === null) {
        rollbackHome = path.join(tempRoot, 'rollback-managed-home')
        const rollbackContext = createRollbackContext(rollbackHome, expectedSyntheticUserId)
        await executeRollbackPhase({
          assertions,
          context: rollbackContext,
          steps: CASES.filter(candidate => candidate.rollbackStep),
          executeStep: executeItem
        })
      }
    } catch (error) {
      fatalCode = safeCode(error)
      const target = assertions.find(item => item.status === 'NOT_RUN')
      if (target) setAssertion(assertions, target.id, 'FAIL', fatalCode)
    }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    try {
      const cleanup = await cleanupOwnedTempRoot({ runner, tempRoot })
      cleanupPassed = cleanup.passed
    } catch {
      cleanupPassed = false
    }
  }

  if (rollbackHome) {
    setAssertion(
      assertions,
      'rollback.home-cleanup',
      !fs.existsSync(rollbackHome) ? 'PASS' : 'FAIL',
      !fs.existsSync(rollbackHome) ? null : 'rollback_managed_home_cleanup_failed'
    )
  }

  if (source) {
    const primaryChildrenExited = runner.active.size === 0 && commandRecords.every(item => item.cleanupStatus === 'exited')
    if (!primaryChildrenExited) {
      setAssertion(assertions, 'preflight.source-unchanged', 'FAIL', 'matrix_child_cleanup_before_audit_failed')
    } else {
      // Cancellation intentionally disables the primary runner. Use a fresh,
      // read-only runner only after every primary child has exited so the
      // cancellation manifest can still prove both source trees unchanged.
      const auditRunner = createProcessRunner(commandRecords)
      try {
        source.desktop.after = await sourceState(auditRunner, 'desktop-source-after', options.desktopSourceRoot)
        source.gateway.after = await sourceState(auditRunner, 'gateway-source-after', options.gatewaySourceRoot)
        source.desktop.unchanged = sourceStatesEqual(source.desktop.before, source.desktop.after)
        source.gateway.unchanged = sourceStatesEqual(source.gateway.before, source.gateway.after)
        const unchanged = source.desktop.unchanged && source.gateway.unchanged
        setAssertion(
          assertions,
          'preflight.source-unchanged',
          unchanged ? 'PASS' : 'FAIL',
          unchanged ? null : 'matrix_source_mutated'
        )
      } catch {
        setAssertion(assertions, 'preflight.source-unchanged', 'FAIL', 'matrix_source_recheck_failed')
      }
    }
  }

  setAssertion(
    assertions,
    'commands.all-exited',
    commandRecords.every(item => item.cleanupStatus === 'exited') ? 'PASS' : 'FAIL',
    commandRecords.every(item => item.cleanupStatus === 'exited') ? null : 'matrix_child_cleanup_failed'
  )
  setAssertion(
    assertions,
    'cleanup.temp-removed',
    cleanupPassed ? 'PASS' : 'FAIL',
    cleanupPassed ? null : 'matrix_temp_cleanup_failed'
  )

  const forbiddenValues = [
    options.desktopSourceRoot,
    options.gatewaySourceRoot,
    runRoot,
    tempRoot,
    os.homedir(),
    process.env.USERPROFILE || '',
    process.env.USERNAME || ''
  ].filter(value => String(value).length >= 3)
  let scan = { passed: false, scanned: 0 }
  try {
    scan = scanOutputFiles(runRoot, forbiddenValues)
  } catch {
    scan = { passed: false, scanned: 0 }
  }
  setAssertion(
    assertions,
    'evidence.no-sensitive-values',
    scan.passed ? 'PASS' : 'FAIL',
    scan.passed ? null : 'matrix_sensitive_value_detected'
  )

  const exitCode = exitCodeForAssertions(assertions, runner.cancelled)
  const status = exitCode === 0 ? 'PASS' : 'FAIL'
  const manifest = {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    status,
    run: { id: runId, output: runId },
    fixedRefs: FIXED_REFS,
    gatewayExporter: {
      ref: GATEWAY_EXPORTER_REF,
      archiveSha256: exporterArchiveSha256,
      archiveProjectSha256: exporterProjectSha256
    },
    fixedRefArchives,
    source,
    runner: runnerIdentity,
    matrix: {
      cases,
      requiredCaseCount: CASES.length,
      completedCaseCount: cases.length,
      rollbackOrder: ['required', 'p2-compatible', 'desktop-p1', 'gateway-p1']
    },
    evidenceScan: { filesScanned: scan.scanned },
    assertions,
    commands: commandRecords,
    command: { exitCode },
    fatalCode
  }
  const preparedManifestBytes = prepareManifestForPublish(manifest, forbiddenValues)
  const written = writeManifestLast(runRoot, manifest, { preparedBytes: preparedManifestBytes })
  return { exitCode: manifest.command.exitCode, manifest, runId, written }
}

async function runCli(args, { stderr = process.stderr, stdout = process.stdout } = {}) {
  const options = parseArguments(args)
  if (!options) {
    stderr.write('NOT_RUN x1_matrix_arguments_invalid\n')
    return 2
  }
  try {
    const result = await executeMatrix(options)
    if (result.exitCode === 0) {
      stdout.write(`PASS ${result.runId}/${MATRIX_MANIFEST_FILE} sha256=${result.written.sha256}\n`)
    } else {
      stderr.write(`FAIL x1_enterprise_bootstrap_matrix ${result.runId}/${MATRIX_MANIFEST_FILE}\n`)
    }
    return result.exitCode
  } catch (error) {
    stderr.write(`FAIL ${safeCode(error, 'x1_enterprise_bootstrap_matrix_failed')}\n`)
    return 1
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(code => {
    process.exitCode = code
  })
}

module.exports = {
  CASES,
  FIXED_REFS,
  FIXED_SYNTHETIC_USER_ID,
  GATEWAY_EXPORTER_REF,
  MAX_OWNED_TEMP_PATH_LENGTH,
  MATRIX_MANIFEST_FILE,
  assertionIds,
  contractMatches,
  countsMatch,
  createProcessRunner,
  cleanupOwnedTempRoot,
  createOwnedTempEnvironment,
  createRollbackContext,
  createTransport,
  createAssertions,
  eventOrderMatches,
  executeOrdinaryPhase,
  executeRollbackPhase,
  exitCodeForAssertions,
  gatewayAssertionsMatch,
  inspectCanonicalPath,
  loadGatewayFixture,
  managedHomeSnapshot,
  makeShortTempRoot,
  ownedTempOwner,
  parseArguments,
  prepareRunDirectories,
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
}
