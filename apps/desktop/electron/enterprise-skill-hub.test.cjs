const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const contract = require('../../../contracts/enterprise-skill-hub/v1/contract.json')
const { createEnterpriseGatewayClient } = require('./enterprise-gateway-client.cjs')
const { createEnterpriseManagedLifecycle } = require('./enterprise-managed-lifecycle.cjs')
const { createEnterpriseRuntimeAccess } = require('./enterprise-runtime-access.cjs')
const { createEnterpriseSkillHub, readJsonResponse } = require('./enterprise-skill-hub.cjs')

const DESKTOP_TOKEN = 'dsk_test-secret-token'
const DESKTOP_USER_ID = '67f4d4f5-2164-45b4-9d62-3809e211b2f4'
const LOCAL_TOKEN = 'local-dashboard-token'
const INSTALLED_PATH = contract.localInstallApi.installedRoute.split(' ')[1]
const CONTRACT_ROOT = path.resolve(__dirname, '../../../contracts/enterprise-skill-hub/v1')

function sha256(body) {
  return crypto.createHash('sha256').update(body).digest('hex')
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status
  })
}

function catalogItem(body, overrides = {}) {
  return {
    key: 'invoice-review',
    name: 'invoice-review',
    description: 'Review enterprise invoices',
    category: 'finance',
    declaredVersion: '1.0.0',
    currentRevision: 1,
    artifactSha256: sha256(body),
    artifactSizeBytes: body.length,
    fileCount: 2,
    publishedAt: '2026-07-13T08:00:00Z',
    policyStatus: 'available',
    policyReason: null,
    ...overrides
  }
}

function downloadResponse(body, item, overrides = {}) {
  return new Response(overrides.stream || body, {
    headers: {
      'content-length': String(overrides.contentLength ?? body.length),
      [contract.artifact.downloadSha256Header]: overrides.headerSha || item.artifactSha256
    },
    status: overrides.status || 200
  })
}

function tempEntries() {
  return new Set(
    fs
      .readdirSync(os.tmpdir(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('hermes-enterprise-skill-'))
      .map(entry => entry.name)
  )
}

function deferred() {
  let resolve
  const promise = new Promise(next => {
    resolve = next
  })
  return { promise, resolve }
}

function createHarness({
  body = Buffer.from('enterprise-skill-zip'),
  clientOverrides = {},
  detail,
  details,
  download,
  getManagedContext,
  isManaged = false,
  localConnection,
  localFetch,
  onCommit,
  onDownload,
  operationStore: suppliedOperationStore,
  runtimeAccess
} = {}) {
  const item = detail || catalogItem(body)
  const operationBase = {
    operationId: '8bd3e8fb-8f0d-4f1c-8850-f79e48a8aac5',
    desktopUserId: DESKTOP_USER_ID,
    tenantId: 'tenant-1',
    materializationBindingSchemaVersion: 2,
    materializedContentHash: 'c'.repeat(64),
    materializationRecoveryExpiresAt: '2026-07-21T10:30:00+00:00',
    expiresAt: '2026-07-20T10:30:00Z'
  }
  let storedOperation = null
  const memoryOperationStore = {
    assertAvailable: () => true,
    clear: () => { storedOperation = null },
    readOperation: () => storedOperation,
    writeIntent: value => (storedOperation = { ...value, phase: 'creating' }),
    writeOperation: value => (storedOperation = { ...value, phase: 'created' })
  }
  const operationStore = suppliedOperationStore || memoryOperationStore
  let detailIndex = 0
  const gatewayTokens = []
  const client = {
    async skillHubSkills(token) {
      gatewayTokens.push(token)
      return { items: [{ ...item, desktopToken: token }], page: 1, pageSize: 20, total: 1 }
    },
    async skillHubSkill(token) {
      gatewayTokens.push(token)
      const current = details?.[Math.min(detailIndex++, details.length - 1)] || item
      return { ...current, desktopToken: token }
    },
    async downloadSkillPackage(token, _key, _revision, options) {
      gatewayTokens.push(token)
      onDownload?.(options)
      return download || downloadResponse(body, item)
    },
    async createSkillInstallOperation(token, request) {
      gatewayTokens.push(token)
      return {
        operation: {
          ...operationBase,
          clientOperationId: request.clientOperationId,
          status: 'pending',
          skillKey: request.skillKey,
          packageRevision: request.packageRevision,
          artifactSha256: request.artifactSha256,
          installAuthorizationHash: 'b'.repeat(64)
        },
        reconciliationToken: 'srt_test-recovery'
      }
    },
    async commitSkillInstallOperation(token, _operationId) {
      gatewayTokens.push(token)
      onCommit?.()
      return {
        operation: {
          ...operationBase,
          clientOperationId: storedOperation.clientOperationId,
          status: 'commit-authorized',
          skillKey: storedOperation.key,
          packageRevision: storedOperation.revision,
          artifactSha256: storedOperation.artifactSha256,
          installAuthorizationHash: storedOperation.installAuthorizationHash
        },
        materializationReceipt: 'header.payload.signature'
      }
    },
    async getSkillInstallOperation() {
      return {
        operation: {
          ...operationBase,
          clientOperationId: storedOperation.clientOperationId,
          status: 'pending',
          skillKey: storedOperation.key,
          packageRevision: storedOperation.revision,
          artifactSha256: storedOperation.artifactSha256,
          installAuthorizationHash: storedOperation.installAuthorizationHash
        },
        materializationReceipt: null
      }
    },
    ...clientOverrides
  }
  const localRequests = []
  const fetchImpl =
    localFetch ||
    (async (url, init = {}) => {
      localRequests.push({ init, url: String(url) })
      if (String(url).endsWith(INSTALLED_PATH)) {
        return jsonResponse({ items: [] })
      }
      if (String(url).includes('/install-operations/') && init.method === 'GET') {
        return jsonResponse({ operationId: operationBase.operationId, state: 'staged' })
      }
      if (String(url).includes('/install-operations/') && String(url).includes('/abort')) {
        return jsonResponse({ operationId: operationBase.operationId, state: 'aborted', targetAbsent: true })
      }
      if (String(url).includes('/install-operations/') && String(url).includes('/materialize')) {
        return jsonResponse({
          artifactSha256: item.artifactSha256,
          key: item.key,
          name: item.name,
          revision: item.currentRevision,
          state: 'installed'
        })
      }
      const chunks = []
      for await (const chunk of init.body) chunks.push(Buffer.from(chunk))
      assert.deepEqual(Buffer.concat(chunks), body)
      return jsonResponse({
        operationId: operationBase.operationId,
        state: 'staged'
      })
    })
  const hub = createEnterpriseSkillHub({
    authStore: { readSession: () => ({ desktopToken: DESKTOP_TOKEN }) },
    client,
    fetchImpl,
    getManagedContext:
      getManagedContext ||
      (() => ({
        userId: DESKTOP_USER_ID,
        hermesHome: `C:\\Hermes\\enterprise\\${DESKTOP_USER_ID}`
      })),
    isManaged,
    localConnection:
      localConnection ||
      (async () => ({ baseUrl: 'http://127.0.0.1:9000', mode: 'local', token: LOCAL_TOKEN })),
    operationStore,
    runtimeAccess
  })
  return { body, client, gatewayTokens, hub, item, localRequests, operationStore }
}

function createdStoredOperation(overrides = {}) {
  return {
    phase: 'created',
    operationId: '8bd3e8fb-8f0d-4f1c-8850-f79e48a8aac5',
    clientOperationId: 'desktop-operation-recovery',
    key: 'invoice-review',
    revision: 1,
    artifactSha256: sha256(Buffer.from('enterprise-skill-zip')),
    installAuthorizationHash: 'b'.repeat(64),
    desktopUserId: DESKTOP_USER_ID,
    tenantId: 'tenant-1',
    materializationBindingSchemaVersion: 2,
    materializedContentHash: 'c'.repeat(64),
    materializationRecoveryExpiresAt: '2026-07-21T10:30:00+00:00',
    expiresAt: '2026-07-20T10:30:00Z',
    reconciliationToken: 'srt_test-recovery',
    userId: DESKTOP_USER_ID,
    hermesHome: `C:\\Hermes\\enterprise\\${DESKTOP_USER_ID}`,
    ...overrides
  }
}

function memoryStore(initial = null) {
  let value = initial
  return {
    assertAvailable: () => true,
    clear: () => { value = null },
    readOperation: () => value,
    writeIntent: input => (value = { ...input, phase: 'creating' }),
    writeOperation: input => (value = { ...input, phase: 'created' })
  }
}

test('contract keeps Desktop transport on the frozen routes, SHA header, and 50 MiB limit', () => {
  assert.equal(contract.schemaVersion, 1)
  assert.equal(contract.limits.maxArtifactBytes, 50 * 1024 * 1024)
  assert.equal(contract.artifact.downloadSha256Header, 'X-Hermes-Artifact-Sha256')
  assert.equal(contract.localInstallApi.installContentType, 'application/zip')
  assert.match(contract.localInstallApi.installRoute, /\?key=<urlencoded>&revision=<positive-integer>$/)
})

test('Node reads the canonical fixture with the frozen ordinal inventory and content digest', () => {
  const root = path.join(CONTRACT_ROOT, 'fixtures/valid/expense-review')
  const expected = require(path.join(CONTRACT_ROOT, 'fixtures/valid/expense-review.expected.json'))
  const paths = []

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile()) paths.push(path.relative(root, fullPath).split(path.sep).join('/'))
    }
  }

  walk(root)
  paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const digest = crypto.createHash('sha256')
  const inventory = paths.map(relativePath => {
    const content = fs.readFileSync(path.join(root, ...relativePath.split('/')))
    const fileSha256 = sha256(content)
    digest.update(`${relativePath}\0${fileSha256}\0${content.length}\n`, 'utf8')
    return { path: relativePath, sha256: fileSha256, sizeBytes: content.length }
  })

  assert.deepEqual(inventory, expected.inventory)
  assert.equal(digest.digest('hex'), expected.contentSha256)
  assert.equal(inventory.length, expected.fileCount)
})

test('list and detail expose allowlisted DTO fields without enterprise token material', async () => {
  const { gatewayTokens, hub } = createHarness()
  const page = await hub.list({ q: 'invoice' })
  const detail = await hub.detail('invoice-review')

  assert.deepEqual(gatewayTokens, [DESKTOP_TOKEN, DESKTOP_TOKEN])
  assert.equal(page.items[0].installState, 'not-installed')
  assert.equal(Object.hasOwn(page.items[0], 'desktopToken'), false)
  assert.equal(Object.hasOwn(detail, 'desktopToken'), false)
  assert.equal(JSON.stringify({ page, detail }).includes(DESKTOP_TOKEN), false)
})

test('non-denied U4 policy statuses remain installable instead of failing closed as unknown', async () => {
  const { hub } = createHarness({
    detail: catalogItem(Buffer.from('enterprise-skill-zip'), { policyStatus: 'recommended' })
  })

  const page = await hub.list()
  const detail = await hub.detail('invoice-review')

  assert.equal(page.items[0].policyStatus, 'recommended')
  assert.equal(detail.policyStatus, 'recommended')
})

test('install authenticates only to Gateway, streams verified bytes to local Backend, and cleans temp files', async () => {
  const before = tempEntries()
  const { gatewayTokens, hub, item, localRequests } = createHarness()
  const result = await hub.install({ key: item.key, revision: item.currentRevision })
  const after = tempEntries()

  assert.deepEqual(gatewayTokens, [DESKTOP_TOKEN, DESKTOP_TOKEN, DESKTOP_TOKEN, DESKTOP_TOKEN, DESKTOP_TOKEN])
  assert.deepEqual(
    [...after].filter(name => !before.has(name)),
    []
  )
  const installRequest = localRequests.find(request => request.init.method === 'POST')
  assert.ok(installRequest)
  assert.match(installRequest.url, /\/api\/skills\/enterprise\/install-operations\/.+\/stage\?/)
  assert.equal(installRequest.init.headers['X-Hermes-Artifact-Sha256'], item.artifactSha256)
  assert.equal(installRequest.init.headers['Content-Type'], 'application/zip')
  assert.equal(installRequest.init.headers.Authorization, undefined)
  assert.equal(JSON.stringify(installRequest.init.headers).includes(DESKTOP_TOKEN), false)
  assert.equal(JSON.stringify(result).includes(DESKTOP_TOKEN), false)
  assert.equal(result.item.installState, 'installed')
})

test('allowed install revoked after download aborts before local commit and cleans its temp directory', async () => {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: true })
  lifecycle.markRunning()
  const runtimeAccess = createEnterpriseRuntimeAccess({
    getLifecycle: () => lifecycle,
    isManaged: () => true
  })
  const before = tempEntries()
  let observedSignal = null
  let revoke = null
  const { hub, item, localRequests, operationStore } = createHarness({
    isManaged: true,
    onDownload: options => {
      observedSignal = options.signal
      revoke = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
    },
    runtimeAccess
  })

  await assert.rejects(
    hub.install({ key: item.key, revision: item.currentRevision }),
    error => ['enterprise_lifecycle_effect_denied', 'enterprise_lifecycle_ipc_denied', 'request-canceled'].includes(error.code)
  )
  await revoke

  assert.equal(observedSignal.aborted, true)
  assert.equal(
    localRequests.some(request => request.url.includes('/stage')),
    false
  )
  assert.equal(localRequests.some(request => request.url.includes('/abort')), false)
  assert.equal(operationStore.readOperation().phase, 'created')
  assert.deepEqual(
    [...tempEntries()].filter(name => !before.has(name)),
    []
  )
})

test('managed Skill Hub fails closed without runtime access while unmanaged use stays compatible', async () => {
  const managed = createHarness({ isManaged: true }).hub
  await assert.rejects(managed.list(), error => error.code === 'enterprise_runtime_access_unavailable')

  const unmanaged = createHarness().hub
  assert.equal((await unmanaged.list()).items.length, 1)
})

test('revocation after Gateway commit blocks fresh local materialization and preserves evidence', async () => {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: true })
  lifecycle.markRunning()
  const runtimeAccess = createEnterpriseRuntimeAccess({ getLifecycle: () => lifecycle, isManaged: () => true })
  let revoke = null
  const { hub, item, localRequests, operationStore } = createHarness({
    isManaged: true,
    onCommit: () => {
      revoke = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
    },
    runtimeAccess
  })

  await assert.rejects(
    hub.install({ key: item.key, revision: item.currentRevision }),
    error => ['enterprise_lifecycle_effect_denied', 'enterprise_lifecycle_ipc_denied', 'request-canceled'].includes(error.code)
  )
  await revoke
  assert.equal(localRequests.some(request => request.url.includes('/stage')), true)
  assert.equal(localRequests.some(request => request.url.includes('/materialize')), false)
  assert.equal(operationStore.readOperation().phase, 'created')
})

test('recovered success reacquires a lease before catalog fetch and cannot cross a revoked gap', async () => {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: true })
  lifecycle.markRunning()
  const runtimeAccess = createEnterpriseRuntimeAccess({ getLifecycle: () => lifecycle, isManaged: () => true })
  let catalogFetches = 0
  const { hub, item } = createHarness({
    isManaged: true,
    runtimeAccess,
    clientOverrides: {
      skillHubSkill: async () => {
        catalogFetches += 1
        return item
      }
    }
  })
  hub.reconcileBeforeUse = async () => {
    await lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
    return {
      installed: {
        artifactSha256: item.artifactSha256,
        key: item.key,
        name: item.name,
        revision: item.currentRevision,
        state: 'installed'
      }
    }
  }

  await assert.rejects(
    hub.install({ key: item.key, revision: item.currentRevision }),
    error => error.code === 'enterprise_lifecycle_ipc_denied'
  )
  assert.equal(catalogFetches, 0)
})

test('commit-authorized recovery revoked after local status performs zero materialization writes', async () => {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: true })
  lifecycle.markRunning()
  const runtimeAccess = createEnterpriseRuntimeAccess({ getLifecycle: () => lifecycle, isManaged: () => true })
  const store = memoryStore(createdStoredOperation())
  let materializes = 0
  let statusReads = 0
  let revokePromise = null
  const { hub } = createHarness({
    isManaged: true,
    operationStore: store,
    runtimeAccess,
    clientOverrides: {
      getSkillInstallOperation: async () => ({
        operation: {
          ...createdStoredOperation(),
          status: 'commit-authorized',
          skillKey: 'invoice-review',
          packageRevision: 1
        },
        materializationReceipt: 'header.payload.signature'
      })
    },
    localFetch: async (url, init = {}) => {
      if ((!init.method || init.method === 'GET') && String(url).includes('/install-operations/')) {
        statusReads += 1
        revokePromise = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
        return jsonResponse({ operationId: createdStoredOperation().operationId, state: 'staged' })
      }
      if (String(url).includes('/materialize')) {
        materializes += 1
        return jsonResponse({ state: 'installed' })
      }
      throw new Error(`unexpected local request: ${url}`)
    }
  })

  await assert.rejects(
    hub.recoverPendingOperation(),
    error => ['enterprise_lifecycle_effect_denied', 'enterprise_lifecycle_ipc_denied', 'request-canceled'].includes(error.code)
  )
  if (revokePromise) await revokePromise
  assert.equal(statusReads, 1)
  assert.equal(materializes, 0)
  assert.equal(store.readOperation().phase, 'created')
})

test('already-aborted JSON body fails before a throwing checkpoint or body read can run', async () => {
  const controller = new AbortController()
  controller.abort()
  let bodyReads = 0
  let checkpoints = 0
  await assert.rejects(readJsonResponse({
    text: async () => { bodyReads += 1 }
  }, {
    checkpoint: () => { checkpoints += 1; throw new Error('must not run') },
    signal: controller.signal
  }), error => error.code === 'request-canceled')
  assert.equal(bodyReads, 0)
  assert.equal(checkpoints, 0)
})

test('checkpoint-triggered abort is observed without an unhandled abort promise', async () => {
  const controller = new AbortController()
  let bodyReads = 0
  await assert.rejects(readJsonResponse({
    body: { cancel: async () => {} },
    text: async () => { bodyReads += 1 }
  }, {
    checkpoint: () => {
      controller.abort()
      throw new Error('stale lease')
    },
    signal: controller.signal
  }), error => error.code === 'request-canceled')
  assert.equal(bodyReads, 0)
  await new Promise(resolve => setImmediate(resolve))
})

test('a fast list branch failure aborts the hanging sibling request', async () => {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: true })
  lifecycle.markRunning()
  const runtimeAccess = createEnterpriseRuntimeAccess({ getLifecycle: () => lifecycle, isManaged: () => true })
  const siblingStarted = deferred()
  let siblingAborted = false
  const hub = createEnterpriseSkillHub({
    authStore: { readSession: () => ({ desktopToken: DESKTOP_TOKEN }) },
    client: {
      skillHubSkills: async () => {
        await siblingStarted.promise
        throw Object.assign(new Error('catalog failed'), { code: 'gateway-offline' })
      }
    },
    fetchImpl: async (_url, init) => new Promise(() => {
      init.signal.addEventListener('abort', () => {
        siblingAborted = true
      }, { once: true })
      siblingStarted.resolve()
    }),
    isManaged: true,
    localConnection: async () => ({ baseUrl: 'http://127.0.0.1:9000', mode: 'local', token: LOCAL_TOKEN }),
    runtimeAccess
  })

  await assert.rejects(hub.list(), error => error.code === 'gateway-offline')
  assert.equal(siblingAborted, true)
})

test('install is process-wide single-flight for the same request and rejects a different key while owned', async () => {
  const enteredPost = deferred()
  const releasePost = deferred()
  const body = Buffer.from('enterprise-skill-zip')
  const item = catalogItem(body)
  const { hub } = createHarness({
    body,
    localFetch: async url => {
      if (String(url).endsWith(INSTALLED_PATH)) return jsonResponse({ items: [] })
      if (String(url).includes('/stage')) {
        enteredPost.resolve()
        await releasePost.promise
        return jsonResponse({ operationId: '8bd3e8fb-8f0d-4f1c-8850-f79e48a8aac5', state: 'staged' })
      }
      return jsonResponse({
        artifactSha256: item.artifactSha256,
        key: item.key,
        name: item.name,
        revision: item.currentRevision,
        state: 'installed'
      })
    }
  })

  const first = hub.install({ key: item.key, revision: item.currentRevision })
  await enteredPost.promise
  const duplicate = hub.install({ key: item.key, revision: item.currentRevision })
  assert.equal(duplicate, first)
  await assert.rejects(
    hub.install({ key: 'another-skill', revision: 1 }),
    error => error.code === 'enterprise_skill_install_busy'
  )
  releasePost.resolve()
  await Promise.all([first, duplicate])
})

test('final catalog revalidation aborts a staged operation before materialization', async () => {
  const body = Buffer.from('enterprise-skill-zip')
  const first = catalogItem(body, { policyStatus: 'available' })
  const changed = { ...first, policyStatus: 'recommended' }
  const before = tempEntries()
  const { hub, localRequests, operationStore } = createHarness({ body, details: [first, changed] })

  await assert.rejects(
    hub.install({ key: first.key, revision: first.currentRevision }),
    error => error.code === 'package_revision_changed' && error.status === 409
  )
  assert.equal(
    localRequests.some(request => request.url.includes('/materialize')),
    false
  )
  assert.equal(localRequests.some(request => request.url.includes('/stage')), true)
  assert.equal(localRequests.some(request => request.url.includes('/abort')), true)
  assert.equal(operationStore.readOperation(), null)
  assert.deepEqual(
    [...tempEntries()].filter(name => !before.has(name)),
    []
  )
})

test('initial catalog detail must be bound to the requested key before download', async () => {
  const body = Buffer.from('enterprise-skill-zip')
  const returned = catalogItem(body, { key: 'another-skill', name: 'another-skill' })
  const { gatewayTokens, hub, localRequests } = createHarness({ body, detail: returned })

  await assert.rejects(
    hub.install({ key: 'invoice-review', revision: returned.currentRevision }),
    error => error.code === 'package_revision_changed'
  )
  assert.deepEqual(gatewayTokens, [DESKTOP_TOKEN])
  assert.equal(localRequests.some(request => request.init.method === 'POST'), false)
})

test('revocation interrupts a hanging local error body and preserves request-canceled', async () => {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: true })
  lifecycle.markRunning()
  const runtimeAccess = createEnterpriseRuntimeAccess({ getLifecycle: () => lifecycle, isManaged: () => true })
  const enteredErrorBody = deferred()
  const { hub, item } = createHarness({
    isManaged: true,
    localFetch: async (url, init = {}) => {
      if (String(url).endsWith(INSTALLED_PATH)) return jsonResponse({ items: [] })
      if (String(url).includes('/abort')) return jsonResponse({ state: 'aborted', targetAbsent: true })
      for await (const chunk of init.body) assert.ok(chunk)
      return {
        body: { cancel: async () => {} },
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => {
          enteredErrorBody.resolve()
          return new Promise(() => {})
        }
      }
    },
    runtimeAccess
  })

  const install = hub.install({ key: item.key, revision: item.currentRevision })
  await enteredErrorBody.promise
  const revoke = lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  await assert.rejects(
    install,
    error => error.code === 'request-canceled'
  )
  await revoke
})

for (const [name, mutate, code] of [
  [
    'truncated package',
    (_body, item) => downloadResponse(Buffer.from('short'), item, { contentLength: item.artifactSizeBytes }),
    'artifact_length_mismatch'
  ],
  [
    'oversized metadata',
    (body, item) => downloadResponse(body, item, { contentLength: contract.limits.maxArtifactBytes + 1 }),
    'artifact_too_large'
  ],
  [
    'SHA header mismatch',
    (body, item) => downloadResponse(body, item, { headerSha: '0'.repeat(64) }),
    'artifact_hash_mismatch'
  ],
  [
    'body hash mismatch',
    (body, item) => downloadResponse(Buffer.alloc(body.length, 0x78), item, { contentLength: item.artifactSizeBytes }),
    'artifact_hash_mismatch'
  ]
]) {
  test(`${name} is rejected and its unique temp directory is removed`, async () => {
    const body = Buffer.from('enterprise-skill-zip')
    const item = catalogItem(body)
    const before = tempEntries()
    const { hub, localRequests, operationStore } = createHarness({ body, detail: item, download: mutate(body, item) })
    await assert.rejects(
      () => hub.install({ key: item.key, revision: 1 }),
      error => error.code === code
    )
    assert.equal(localRequests.some(request => request.url.includes('/abort')), true)
    assert.equal(operationStore.readOperation(), null)
    const after = tempEntries()
    assert.deepEqual(
      [...after].filter(entry => !before.has(entry)),
      []
    )
  })
}

test('pending deterministic failure treats exact local operation absence as an aborted target', async () => {
  const body = Buffer.from('enterprise-skill-zip')
  const item = catalogItem(body)
  let aborts = 0
  const { hub, operationStore } = createHarness({
    body,
    detail: item,
    localFetch: async (url, init = {}) => {
      if (String(url).endsWith(INSTALLED_PATH)) return jsonResponse({ items: [] })
      if (String(url).includes('/abort')) {
        aborts += 1
        return jsonResponse({ code: 'install_operation_not_found' }, 404)
      }
      for await (const chunk of init.body) assert.ok(chunk)
      return jsonResponse({ code: 'skill_name_conflict' }, 409)
    }
  })

  let caught = null
  try {
    await hub.install({ key: item.key, revision: item.currentRevision })
  } catch (error) {
    caught = error
  }
  assert.equal(aborts, 1)
  assert.equal(operationStore.readOperation(), null)
  assert.equal(caught?.code, 'skill_name_conflict')
})

test('network interruption rejects install and removes the temp directory', async () => {
  const body = Buffer.from('enterprise-skill-zip')
  const item = catalogItem(body)
  const interrupted = new ReadableStream({
    start(controller) {
      controller.enqueue(body.subarray(0, 4))
      controller.error(new Error('socket reset'))
    }
  })
  const before = tempEntries()
  const { hub, operationStore } = createHarness({ body, detail: item, download: downloadResponse(body, item, { stream: interrupted }) })
  await assert.rejects(
    () => hub.install({ key: item.key, revision: 1 }),
    error => error.code === 'install_operation_reconciling' && error.status === 202
  )
  assert.equal(operationStore.readOperation().phase, 'created')
  const after = tempEntries()
  assert.deepEqual(
    [...after].filter(entry => !before.has(entry)),
    []
  )
})

test('policy and revision checks stop before download', async () => {
  const restricted = createHarness({ detail: catalogItem(Buffer.from('zip'), { policyStatus: 'restricted' }) })
  await assert.rejects(
    () => restricted.hub.install({ key: restricted.item.key, revision: restricted.item.currentRevision }),
    error => error.code === 'skill_policy_denied' && error.status === 403
  )

  const changed = createHarness()
  await assert.rejects(
    () => changed.hub.install({ key: changed.item.key, revision: changed.item.currentRevision + 1 }),
    error => error.code === 'package_revision_changed' && error.status === 409
  )
  assert.deepEqual(restricted.gatewayTokens, [DESKTOP_TOKEN])
  assert.deepEqual(changed.gatewayTokens, [DESKTOP_TOKEN])
})

test('deterministic local conflict codes remain readable after aborting pending recovery evidence', async () => {
  for (const code of ['skill_name_conflict', 'update_not_supported']) {
    const { hub, item, operationStore } = createHarness({
      localFetch: async (url, init = {}) => {
        if (String(url).endsWith(INSTALLED_PATH)) return jsonResponse({ items: [] })
        if (String(url).includes('/abort')) return jsonResponse({ state: 'aborted', targetAbsent: true })
        for await (const chunk of init.body) {
          // Drain the stream so cleanup also exercises the normal upload path.
          assert.ok(chunk)
        }
        return jsonResponse({ code, message: `Readable ${code}` }, 409)
      }
    })
    await assert.rejects(
      () => hub.install({ key: item.key, revision: item.currentRevision }),
      error => error.code === code && error.status === 409
    )
    assert.equal(operationStore.readOperation(), null)
  }
})

test('create response loss replays the identical clientOperationId and preserves a pending operation', async () => {
  const store = memoryStore()
  const clientOperationIds = []
  let calls = 0
  const { hub, item } = createHarness({
    operationStore: store,
    clientOverrides: {
      createSkillInstallOperation: async (_token, request) => {
        clientOperationIds.push(request.clientOperationId)
        calls += 1
        if (calls === 1) throw new Error('response lost after create')
        return {
          operation: {
            ...createdStoredOperation(),
            clientOperationId: request.clientOperationId,
            status: 'pending',
            skillKey: request.skillKey,
            packageRevision: request.packageRevision
          },
          reconciliationToken: 'srt_test-recovery'
        }
      },
      getSkillInstallOperation: async () => ({
        operation: {
          ...createdStoredOperation(),
          clientOperationId: clientOperationIds[0],
          status: 'pending',
          skillKey: item.key,
          packageRevision: item.currentRevision
        },
        materializationReceipt: null
      })
    }
  })

  await assert.rejects(
    hub.install({ key: item.key, revision: item.currentRevision }),
    error => error.code === 'install_operation_reconciling' && error.status === 202
  )
  assert.equal(calls, 2)
  assert.equal(clientOperationIds[0], clientOperationIds[1])
  assert.equal(store.readOperation().phase, 'created')
  assert.equal(store.readOperation().reconciliationToken, 'srt_test-recovery')
})

test('commit-in-flight pending recovery keeps the SRT and local staged operation', async () => {
  const store = memoryStore(createdStoredOperation())
  const { hub, localRequests } = createHarness({ operationStore: store })

  const result = await hub.recoverPendingOperation()

  assert.equal(result.state, 'reconciling')
  assert.equal(store.readOperation().reconciliationToken, 'srt_test-recovery')
  assert.equal(localRequests.some(request => request.url.includes('/abort')), false)
})

test('recovery uses one lifecycle lease and revocation prevents post-response persistence', async () => {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: true })
  lifecycle.markRunning()
  const runtimeAccess = createEnterpriseRuntimeAccess({ getLifecycle: () => lifecycle, isManaged: () => true })
  const store = memoryStore(createdStoredOperation())
  const started = deferred()
  let recoveryGets = 0
  let recoverySignal = null
  const { hub, localRequests } = createHarness({
    isManaged: true,
    operationStore: store,
    runtimeAccess,
    clientOverrides: {
      getSkillInstallOperation: async (_operationId, options) => {
        recoveryGets += 1
        recoverySignal = options.signal
        await started.promise
        return {
          operation: {
            ...createdStoredOperation(),
            status: 'pending',
            skillKey: 'invoice-review',
            packageRevision: 1
          },
          materializationReceipt: null
  }
}

    }
  })
  const first = hub.recoverPendingOperation()
  const second = hub.recoverPendingOperation()
  assert.equal(first, second)
  await lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  started.resolve()
  await assert.rejects(first, error =>
    ['enterprise_lifecycle_effect_denied', 'enterprise_lifecycle_ipc_denied', 'request-canceled'].includes(error.code)
  )
  assert.equal(recoveryGets, 1)
  assert.equal(recoverySignal.aborted, true)
  assert.equal(store.readOperation().phase, 'created')
  assert.equal(localRequests.some(request => request.init.method === 'POST'), false)
})

test('fresh create rejects a cross-user operation before download, stage, or success', async () => {
  const store = memoryStore()
  let downloads = 0
  const otherUserId = '98b87f26-62c7-4c66-a9de-b8df7aef7d73'
  const { hub, item, localRequests } = createHarness({
    operationStore: store,
    onDownload: () => { downloads += 1 },
    clientOverrides: {
      createSkillInstallOperation: async (_token, request) => ({
        operation: {
          ...createdStoredOperation({ desktopUserId: otherUserId }),
          clientOperationId: request.clientOperationId,
          status: 'pending',
          skillKey: request.skillKey,
          packageRevision: request.packageRevision
        },
        reconciliationToken: 'srt_cross-user'
      })
    }
  })
  await assert.rejects(
    hub.install({ key: item.key, revision: item.currentRevision }),
    error => error.code === 'install_operation_user_mismatch' && error.status === 409
  )
  assert.equal(store.readOperation().phase, 'creating')
  assert.equal(downloads, 0)
  assert.equal(localRequests.some(request => request.init.method === 'POST'), false)
})

test('SRT replay rejects a cross-user operation before local status or materialization', async () => {
  const store = memoryStore(createdStoredOperation())
  const otherUserId = '98b87f26-62c7-4c66-a9de-b8df7aef7d73'
  const { hub, localRequests } = createHarness({
    operationStore: store,
    clientOverrides: {
      getSkillInstallOperation: async () => ({
        operation: {
          ...createdStoredOperation({ desktopUserId: otherUserId }),
          status: 'commit-authorized',
          skillKey: 'invoice-review',
          packageRevision: 1
        },
        materializationReceipt: 'header.payload.signature'
      })
    }
  })
  await assert.rejects(
    hub.recoverPendingOperation(),
    error => error.code === 'install_operation_user_mismatch' && error.status === 409
  )
  assert.equal(store.readOperation().phase, 'created')
  assert.equal(localRequests.some(request => request.url.includes('/install-operations/')), false)
})

test('unknown create result remains a durable creating intent and returns reconciling', async () => {
  const store = memoryStore()
  const clientOperationIds = []
  const { hub, item } = createHarness({
    operationStore: store,
    clientOverrides: {
      createSkillInstallOperation: async (_token, request) => {
        clientOperationIds.push(request.clientOperationId)
        throw new Error('gateway unavailable')
      }
    }
  })
  await assert.rejects(
    hub.install({ key: item.key, revision: item.currentRevision }),
    error => error.code === 'install_operation_reconciling' && error.status === 202
  )
  assert.equal(clientOperationIds.length, 2)
  assert.equal(clientOperationIds[0], clientOperationIds[1])
  assert.equal(store.readOperation().phase, 'creating')
})

test('create response loss followed by explicit replay rejection clears the creating intent', async () => {
  const store = memoryStore()
  let calls = 0
  const replayRejected = Object.assign(new Error('operation was not created'), {
    code: 'skill_install_receipt_ineligible',
    status: 409
  })
  const { hub, item } = createHarness({
    operationStore: store,
    clientOverrides: {
      createSkillInstallOperation: async () => {
        calls += 1
        if (calls === 1) throw new Error('response lost')
        throw replayRejected
      }
    }
  })
  await assert.rejects(
    hub.install({ key: item.key, revision: item.currentRevision }),
    error => error === replayRejected
  )
  assert.equal(calls, 2)
  assert.equal(store.readOperation(), null)
})

test('fresh create clears intent only for stable Gateway rejections that prove no operation was created', async t => {
  for (const [code, status] of [
    ['desktop_session_required', 401],
    ['desktop_active_role_required', 403],
    ['skills_manage_required', 403],
    ['skill_policy_denied', 403],
    ['client_operation_id_conflict', 409],
    ['install_operation_reconciliation_invalid', 409],
    ['install_operation_pending_limit', 429],
    ['package_revision_changed', 409]
  ]) {
    await t.test(`${code}/${status}`, async () => {
      const store = memoryStore()
      let calls = 0
      const rejected = Object.assign(new Error(code), { code, status })
      const { hub, item } = createHarness({
        operationStore: store,
        clientOverrides: {
          createSkillInstallOperation: async () => {
            calls += 1
            throw rejected
          }
        }
      })

      await assert.rejects(hub.install({ key: item.key, revision: item.currentRevision }), error => error === rejected)
      assert.equal(calls, 1)
      assert.equal(store.readOperation(), null)
    })
  }
})

test('create 4xx without a terminal contract code preserves intent and replays idempotently', async () => {
  const store = memoryStore()
  let calls = 0
  const denied = Object.assign(new Error('request invalid'), { code: 'invalid_request', status: 400 })
  const { hub, item } = createHarness({
    operationStore: store,
    clientOverrides: {
      createSkillInstallOperation: async () => {
        calls += 1
        throw denied
      }
    }
  })
  await assert.rejects(hub.install({ key: item.key, revision: item.currentRevision }), error => error === denied)
  assert.equal(calls, 2)
  assert.equal(store.readOperation().phase, 'creating')
})

test('creating replay preserves intent for auth, conflict, throttling, and unknown client failures', async t => {
  for (const [code, status] of [
    ['desktop_session_required', 401],
    ['desktop_active_role_required', 403],
    ['skills_manage_required', 403],
    ['skill_policy_denied', 403],
    ['client_operation_id_conflict', 409],
    ['install_operation_reconciliation_invalid', 409],
    ['install_operation_pending_limit', 429],
    ['invalid_request', 400]
  ]) {
    await t.test(`${code}/${status}`, async () => {
      const store = memoryStore({
        phase: 'creating',
        clientOperationId: 'desktop-operation-recovery',
        key: 'invoice-review',
        revision: 1,
        artifactSha256: sha256(Buffer.from('enterprise-skill-zip')),
        userId: DESKTOP_USER_ID,
        hermesHome: `C:\\Hermes\\enterprise\\${DESKTOP_USER_ID}`
      })
      const { hub, localRequests } = createHarness({
        operationStore: store,
        clientOverrides: {
          createSkillInstallOperation: async () => {
            throw Object.assign(new Error(code), { code, status })
          }
        }
      })
      if (status === 429) {
        assert.equal((await hub.recoverPendingOperation()).state, 'reconciling')
      } else {
        await assert.rejects(hub.recoverPendingOperation(), error => error.code === code)
      }
      assert.equal(store.readOperation().phase, 'creating')
      assert.equal(localRequests.some(request => request.init.method === 'POST'), false)
    })
  }
})

test('Gateway operation contract rejects coerced revision and binding schema values', async t => {
  for (const [field, value] of [
    ['packageRevision', true],
    ['packageRevision', '1'],
    ['packageRevision', 1.5],
    ['materializationBindingSchemaVersion', true],
    ['materializationBindingSchemaVersion', '1'],
    ['materializationBindingSchemaVersion', 1],
    ['materializationBindingSchemaVersion', 1.5],
    ['materializedContentHash', 'not-a-sha256']
  ]) {
    await t.test(`${field}=${String(value)}`, async () => {
      const store = memoryStore()
      const { hub, item } = createHarness({
        operationStore: store,
        clientOverrides: {
          createSkillInstallOperation: async (_token, request) => ({
            operation: {
              ...createdStoredOperation(),
              clientOperationId: request.clientOperationId,
              status: 'pending',
              skillKey: request.skillKey,
              packageRevision: request.packageRevision,
              [field]: value
            },
            reconciliationToken: 'srt_test-recovery'
          })
        }
      })
      await assert.rejects(
        hub.install({ key: item.key, revision: item.currentRevision }),
        error => error.code === 'install_operation_response_invalid'
      )
      assert.equal(store.readOperation().phase, 'creating')
    })
  }
})

test('SRT replay cannot swap the authorized materialized content hash', async () => {
  const store = memoryStore(createdStoredOperation())
  const { hub, localRequests } = createHarness({
    operationStore: store,
    clientOverrides: {
      getSkillInstallOperation: async () => ({
        operation: {
          ...createdStoredOperation(),
          status: 'pending',
          skillKey: 'invoice-review',
          packageRevision: 1,
          materializedContentHash: 'd'.repeat(64)
        },
        materializationReceipt: null
      })
    }
  })
  await assert.rejects(
    hub.recoverPendingOperation(),
    error => error.code === 'install_operation_binding_mismatch' && error.status === 409
  )
  assert.equal(store.readOperation().materializedContentHash, 'c'.repeat(64))
  assert.equal(localRequests.some(request => request.url.includes('/abort')), false)
})

test('terminal Gateway recovery states perform idempotent local abort and clear persisted state', async () => {
  for (const [code, status] of [
    ['install_operation_not_found', 404],
    ['skill_install_receipt_ineligible', 409],
    ['skill_install_receipt_recovery_expired', 410]
  ]) {
    const store = memoryStore(createdStoredOperation())
    let aborts = 0
    const { hub } = createHarness({
      operationStore: store,
      clientOverrides: {
        getSkillInstallOperation: async () => {
          throw Object.assign(new Error(code), { code, status })
        }
      },
      localFetch: async url => {
        if (String(url).includes('/abort')) {
          aborts += 1
          return jsonResponse({ state: 'aborted', targetAbsent: true })
        }
        return jsonResponse({ items: [] })
      }
    })
    const result = await hub.recoverPendingOperation()
    assert.equal(result.state, 'aborted')
    assert.equal(aborts, 1)
    assert.equal(store.readOperation(), null)
  }
})

test('remote terminal state does not clear evidence for an unproven local 404', async () => {
  const store = memoryStore(createdStoredOperation())
  const { hub } = createHarness({
    operationStore: store,
    clientOverrides: {
      getSkillInstallOperation: async () => {
        throw Object.assign(new Error('gone'), {
          code: 'skill_install_receipt_recovery_expired',
          status: 410
        })
      }
    },
    localFetch: async () => jsonResponse({ message: 'wrong route' }, 404)
  })
  await assert.rejects(
    hub.recoverPendingOperation(),
    error => error.code === 'enterprise_skill_install_failed' && error.status === 404
  )
  assert.equal(store.readOperation().phase, 'created')
})

test('commit-authorized recovery distinguishes transient waits from deterministic local failures', async t => {
  for (const [code, status, transient] of [
    ['local_backend_unavailable', 503, true],
    ['install_operation_receipt_invalid', 409, false],
    ['install_operation_content_changed', 409, false],
    ['install_operation_binding_mismatch', 409, false],
    ['install_operation_journal_invalid', 409, false],
    ['skill_name_conflict', 409, false]
  ]) {
    await t.test(code, async () => {
      const store = memoryStore(createdStoredOperation())
      const { hub } = createHarness({
        operationStore: store,
        clientOverrides: {
          getSkillInstallOperation: async () => ({
            operation: {
              ...createdStoredOperation(),
              status: 'commit-authorized',
              skillKey: 'invoice-review',
              packageRevision: 1
            },
            materializationReceipt: 'header.payload.signature'
          })
        },
        localFetch: async () => jsonResponse({ code, message: 'private backend details' }, status)
      })
      if (transient) {
        assert.equal((await hub.recoverPendingOperation()).state, 'reconciling')
      } else {
        await assert.rejects(
          hub.recoverPendingOperation(),
          error => error.code === code && error.status === status
        )
      }
      assert.equal(store.readOperation().phase, 'created')
    })
  }
})

test('catalog remains browsable while SRT recovery is unavailable and does not spawn duplicate recovery', async () => {
  const store = memoryStore(createdStoredOperation())
  let recoveryGets = 0
  const { hub } = createHarness({
    operationStore: store,
    clientOverrides: {
      getSkillInstallOperation: async () => {
        recoveryGets += 1
        throw Object.assign(new Error('temporarily unavailable'), {
          code: 'skill_install_receipt_unavailable',
          status: 503
        })
      }
    }
  })
  assert.equal((await hub.recoverPendingOperation()).state, 'reconciling')
  const page = await hub.list()
  const detail = await hub.detail('invoice-review')
  assert.equal(page.items.length, 1)
  assert.equal(page.pendingOperation.state, 'reconciling')
  assert.equal(detail.pendingOperation.state, 'reconciling')
  assert.equal(recoveryGets, 1)
})

test('local backend requests reject non-canonical or non-local connection descriptors before fetch', async t => {
  const cases = [
    ['missing mode', { baseUrl: 'http://127.0.0.1:9000', token: LOCAL_TOKEN }],
    ['wrong mode', { baseUrl: 'http://127.0.0.1:9000', mode: 'gateway', token: LOCAL_TOKEN }],
    ['https', { baseUrl: 'https://127.0.0.1:9000', mode: 'local', token: LOCAL_TOKEN }],
    ['localhost', { baseUrl: 'http://localhost:9000', mode: 'local', token: LOCAL_TOKEN }],
    ['ipv6', { baseUrl: 'http://[::1]:9000', mode: 'local', token: LOCAL_TOKEN }],
    ['host prefix', { baseUrl: 'http://127.0.0.1.evil.test:9000', mode: 'local', token: LOCAL_TOKEN }],
    ['userinfo', { baseUrl: 'http://user@127.0.0.1:9000', mode: 'local', token: LOCAL_TOKEN }],
    ['path', { baseUrl: 'http://127.0.0.1:9000/api', mode: 'local', token: LOCAL_TOKEN }],
    ['query', { baseUrl: 'http://127.0.0.1:9000?x=1', mode: 'local', token: LOCAL_TOKEN }],
    ['hash', { baseUrl: 'http://127.0.0.1:9000#x', mode: 'local', token: LOCAL_TOKEN }],
    ['leading-zero port', { baseUrl: 'http://127.0.0.1:09000', mode: 'local', token: LOCAL_TOKEN }],
    ['out-of-range port', { baseUrl: 'http://127.0.0.1:65536', mode: 'local', token: LOCAL_TOKEN }],
    ['empty token', { baseUrl: 'http://127.0.0.1:9000', mode: 'local', token: '' }]
  ]
  for (const [name, connection] of cases) {
    await t.test(name, async () => {
      let fetches = 0
      const { hub } = createHarness({
        localConnection: async () => connection,
        localFetch: async () => {
          fetches += 1
          return jsonResponse({ items: [] })
        }
      })
      await assert.rejects(
        hub.list(),
        error => error.code === 'local_backend_connection_invalid'
      )
      assert.equal(fetches, 0)
    })
  }
})

test('local backend boundary pins its token, path, origin, and redirect mode', async () => {
  const calls = []
  const { hub } = createHarness({
    localFetch: async (url, init) => {
      calls.push({ init, url: String(url) })
      return jsonResponse({ items: [] })
    }
  })
  await hub.localRequest(INSTALLED_PATH, {
    headers: { 'X-Hermes-Session-Token': 'attacker-token' }
  })
  assert.equal(calls[0].init.headers['X-Hermes-Session-Token'], LOCAL_TOKEN)
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].url, `http://127.0.0.1:9000${INSTALLED_PATH}`)
  await assert.rejects(
    hub.localRequest('//evil.example/api/skills/enterprise/installed'),
    error => error.code === 'local_backend_path_invalid'
  )
  await assert.rejects(
    hub.localRequest('https://evil.example/api/skills/enterprise/installed'),
    error => error.code === 'local_backend_path_invalid'
  )
  assert.equal(calls.length, 1)
})

test('local backend redirect is surfaced without a second token-bearing request', async () => {
  const calls = []
  const { hub } = createHarness({
    localFetch: async (url, init) => {
      calls.push({ init, url: String(url) })
      return new Response(null, {
        headers: { location: 'https://evil.example/steal' },
        status: 302
      })
    }
  })
  await assert.rejects(hub.localRequest(INSTALLED_PATH), error => error.status === 302)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers['X-Hermes-Session-Token'], LOCAL_TOKEN)
})

test('Gateway client confines dsk token to Authorization and preserves contract error codes', async () => {
  const calls = []
  const client = createEnterpriseGatewayClient({
    baseUrl: 'https://gateway.example.test',
    fetchImpl: async (url, init) => {
      calls.push({ init, url })
      return jsonResponse({ code: 'desktop_session_required', message: 'Session expired' }, 401)
    }
  })
  await assert.rejects(
    () => client.skillHubSkills(DESKTOP_TOKEN, { page: 1 }),
    error => error.code === 'desktop_session_required' && error.status === 401
  )
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${DESKTOP_TOKEN}`)
  assert.equal(String(calls[0].url).includes(DESKTOP_TOKEN), false)
  assert.equal(JSON.stringify(calls[0].init.body || '').includes(DESKTOP_TOKEN), false)
})
