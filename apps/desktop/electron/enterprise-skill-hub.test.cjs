const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const contract = require('../../../contracts/enterprise-skill-hub/v1/contract.json')
const { createEnterpriseGatewayClient } = require('./enterprise-gateway-client.cjs')
const { createEnterpriseSkillHub } = require('./enterprise-skill-hub.cjs')

const DESKTOP_TOKEN = 'dsk_test-secret-token'
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

function createHarness({ body = Buffer.from('enterprise-skill-zip'), detail, download, localFetch } = {}) {
  const item = detail || catalogItem(body)
  const gatewayTokens = []
  const client = {
    async skillHubSkills(token) {
      gatewayTokens.push(token)
      return { items: [{ ...item, desktopToken: token }], page: 1, pageSize: 20, total: 1 }
    },
    async skillHubSkill(token) {
      gatewayTokens.push(token)
      return { ...item, desktopToken: token }
    },
    async downloadSkillPackage(token) {
      gatewayTokens.push(token)
      return download || downloadResponse(body, item)
    }
  }
  const localRequests = []
  const fetchImpl = localFetch || (async (url, init = {}) => {
    localRequests.push({ init, url: String(url) })
    if (String(url).endsWith(INSTALLED_PATH)) {
      return jsonResponse({ items: [] })
    }
    const chunks = []
    for await (const chunk of init.body) chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), body)
    return jsonResponse({
      artifactSha256: item.artifactSha256,
      key: item.key,
      name: item.name,
      revision: item.currentRevision,
      state: 'installed'
    })
  })
  const hub = createEnterpriseSkillHub({
    authStore: { readSession: () => ({ desktopToken: DESKTOP_TOKEN }) },
    client,
    fetchImpl,
    localConnection: async () => ({ baseUrl: 'http://127.0.0.1:9000', token: LOCAL_TOKEN })
  })
  return { body, gatewayTokens, hub, item, localRequests }
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
  paths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
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

  assert.deepEqual(gatewayTokens, [DESKTOP_TOKEN, DESKTOP_TOKEN])
  assert.deepEqual([...after].filter(name => !before.has(name)), [])
  const installRequest = localRequests.find(request => request.init.method === 'POST')
  assert.ok(installRequest)
  assert.match(installRequest.url, /\/api\/skills\/enterprise\/install\?key=invoice-review&revision=1$/)
  assert.equal(installRequest.init.headers['X-Hermes-Artifact-Sha256'], item.artifactSha256)
  assert.equal(installRequest.init.headers['Content-Type'], 'application/zip')
  assert.equal(installRequest.init.headers.Authorization, undefined)
  assert.equal(JSON.stringify(installRequest.init.headers).includes(DESKTOP_TOKEN), false)
  assert.equal(JSON.stringify(result).includes(DESKTOP_TOKEN), false)
  assert.equal(result.item.installState, 'installed')
})

for (const [name, mutate, code] of [
  ['truncated package', (_body, item) => downloadResponse(Buffer.from('short'), item, { contentLength: item.artifactSizeBytes }), 'artifact_length_mismatch'],
  ['oversized metadata', (body, item) => downloadResponse(body, item, { contentLength: contract.limits.maxArtifactBytes + 1 }), 'artifact_too_large'],
  ['SHA header mismatch', (body, item) => downloadResponse(body, item, { headerSha: '0'.repeat(64) }), 'artifact_hash_mismatch'],
  ['body hash mismatch', (body, item) => downloadResponse(Buffer.alloc(body.length, 0x78), item, { contentLength: item.artifactSizeBytes }), 'artifact_hash_mismatch']
]) {
  test(`${name} is rejected and its unique temp directory is removed`, async () => {
    const body = Buffer.from('enterprise-skill-zip')
    const item = catalogItem(body)
    const before = tempEntries()
    const { hub } = createHarness({ body, detail: item, download: mutate(body, item) })
    await assert.rejects(() => hub.install({ key: item.key, revision: 1 }), error => error.code === code)
    const after = tempEntries()
    assert.deepEqual([...after].filter(entry => !before.has(entry)), [])
  })
}

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
  const { hub } = createHarness({ body, detail: item, download: downloadResponse(body, item, { stream: interrupted }) })
  await assert.rejects(() => hub.install({ key: item.key, revision: 1 }), /socket reset/)
  const after = tempEntries()
  assert.deepEqual([...after].filter(entry => !before.has(entry)), [])
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

test('local conflict and update-not-supported codes remain readable', async () => {
  for (const code of ['skill_name_conflict', 'update_not_supported']) {
    const { hub, item } = createHarness({
      localFetch: async (url, init = {}) => {
        if (String(url).endsWith(INSTALLED_PATH)) return jsonResponse({ items: [] })
        for await (const chunk of init.body) {
          // Drain the stream so cleanup also exercises the normal upload path.
          assert.ok(chunk)
        }
        return jsonResponse({ code, message: `Readable ${code}` }, 409)
      }
    })
    await assert.rejects(
      () => hub.install({ key: item.key, revision: item.currentRevision }),
      error => error.code === code && error.status === 409 && error.message === `Readable ${code}`
    )
  }
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
