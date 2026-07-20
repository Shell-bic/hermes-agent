const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createEnterpriseSkillInstallOperationStore
} = require('./enterprise-skill-install-operation-store.cjs')

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: value => Buffer.from(`cipher:${Buffer.from(value).toString('base64')}`),
    decryptString: value => Buffer.from(value.toString().slice('cipher:'.length), 'base64').toString()
  }
}

function operation() {
  return {
    operationId: '8bd3e8fb-8f0d-4f1c-8850-f79e48a8aac5',
    clientOperationId: 'desktop-operation-1',
    key: 'expense-review',
    revision: 1,
    artifactSha256: 'a'.repeat(64),
    installAuthorizationHash: 'b'.repeat(64),
    desktopUserId: '67f4d4f5-2164-45b4-9d62-3809e211b2f4',
    tenantId: 'tenant-1',
    materializationBindingSchemaVersion: 2,
    materializedContentHash: 'c'.repeat(64),
    materializationRecoveryExpiresAt: '2026-07-21T10:30:00+00:00',
    expiresAt: '2026-07-20T10:30:00Z',
    userId: '67f4d4f5-2164-45b4-9d62-3809e211b2f4',
    hermesHome: 'C:\\Hermes\\enterprise\\67f4d4f5-2164-45b4-9d62-3809e211b2f4',
    reconciliationToken: 'srt_super-secret-recovery-token'
  }
}

test('active install operation survives a new store instance without plaintext srt', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-skill-operation-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'active.json')
  const storage = safeStorage()
  const first = createEnterpriseSkillInstallOperationStore({ filePath, safeStorage: storage })
  first.writeIntent(operation())
  first.writeOperation(operation())

  const raw = fs.readFileSync(filePath, 'utf8')
  assert.equal(raw.includes(operation().reconciliationToken), false)
  assert.deepEqual(createEnterpriseSkillInstallOperationStore({ filePath, safeStorage: storage }).readOperation(), {
    ...operation(),
    phase: 'created'
  })
})

test('operation store rejects coerced numeric binding fields', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-skill-operation-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createEnterpriseSkillInstallOperationStore({
    filePath: path.join(directory, 'active.json'),
    safeStorage: safeStorage()
  })
  for (const revision of [true, '1', 1.5]) {
    assert.throws(() => store.writeIntent({ ...operation(), revision }), /invalid/i)
  }
  store.writeIntent(operation())
  for (const materializationBindingSchemaVersion of [true, '1', 1, 1.5]) {
    assert.throws(
      () => store.writeOperation({ ...operation(), materializationBindingSchemaVersion }),
      /invalid/i
    )
  }
  assert.throws(
    () => store.writeOperation({ ...operation(), materializedContentHash: '' }),
    /invalid/i
  )
})

test('operation store requires one canonical managed user id for intent and operation', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-skill-operation-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createEnterpriseSkillInstallOperationStore({
    filePath: path.join(directory, 'active.json'),
    safeStorage: safeStorage()
  })
  for (const userId of ['employee-1', operation().userId.toUpperCase(), '']) {
    assert.throws(() => store.writeIntent({ ...operation(), userId }), /invalid/i)
  }
  store.writeIntent(operation())
  assert.throws(
    () => store.writeOperation({
      ...operation(),
      desktopUserId: '98b87f26-62c7-4c66-a9de-b8df7aef7d73'
    }),
    /invalid/i
  )
  assert.equal(store.readOperation().phase, 'creating')
})

test('operation store prevents a replay from swapping the materialized content hash', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-skill-operation-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createEnterpriseSkillInstallOperationStore({
    filePath: path.join(directory, 'active.json'),
    safeStorage: safeStorage()
  })
  store.writeIntent(operation())
  store.writeOperation(operation())
  assert.throws(
    () => store.writeOperation({ ...operation(), materializedContentHash: 'd'.repeat(64) }),
    /does not match/i
  )
  assert.equal(store.readOperation().materializedContentHash, operation().materializedContentHash)
})

test('operation store fails closed for unavailable or basic_text secure storage', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-skill-operation-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const unavailable = createEnterpriseSkillInstallOperationStore({
    filePath: path.join(directory, 'unavailable.json'),
    safeStorage: { isEncryptionAvailable: () => false }
  })
  assert.throws(() => unavailable.writeIntent(operation()), /unavailable/i)

  const basicText = createEnterpriseSkillInstallOperationStore({
    filePath: path.join(directory, 'basic.json'),
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'basic_text'
    }
  })
  assert.throws(() => basicText.writeIntent(operation()), /unavailable/i)
})

test('operation store rejects oversized and malformed persisted state without clearing evidence', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-skill-operation-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'active.json')
  fs.writeFileSync(filePath, 'x'.repeat(70 * 1024))
  const store = createEnterpriseSkillInstallOperationStore({ filePath, safeStorage: safeStorage() })
  assert.throws(() => store.readOperation(), /unreadable/i)
  assert.equal(fs.existsSync(filePath), true)
})

test('pre-create intent survives restart and operation upgrade preserves its binding', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-skill-operation-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'active.json')
  const storage = safeStorage()
  const first = createEnterpriseSkillInstallOperationStore({ filePath, safeStorage: storage })
  const intent = first.writeIntent(operation())
  assert.equal(intent.phase, 'creating')
  assert.equal(JSON.stringify(intent).includes('srt_'), false)

  const restarted = createEnterpriseSkillInstallOperationStore({ filePath, safeStorage: storage })
  assert.deepEqual(restarted.readOperation(), intent)
  restarted.writeOperation(operation())
  assert.equal(restarted.readOperation().phase, 'created')
})

test('failed atomic upgrade leaves the creating intent recoverable and prevents identity takeover', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-skill-operation-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'active.json')
  const storage = safeStorage()
  const store = createEnterpriseSkillInstallOperationStore({ filePath, safeStorage: storage })
  const intent = store.writeIntent(operation())
  const fsImpl = { ...fs, renameSync: () => { throw new Error('simulated crash before rename') } }
  const crashing = createEnterpriseSkillInstallOperationStore({ filePath, fsImpl, safeStorage: storage })
  assert.throws(() => crashing.writeOperation(operation()), /simulated crash/)
  assert.deepEqual(store.readOperation(), intent)

  assert.throws(
    () => store.writeOperation({ ...operation(), userId: 'other-user' }),
    /invalid|does not match/
  )
  assert.deepEqual(store.readOperation(), intent)
})

test('post-rename fsync failure preserves readable recovery evidence', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-skill-operation-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'active.json')
  let syncs = 0
  const fsImpl = {
    ...fs,
    fsyncSync: descriptor => {
      syncs += 1
      if (syncs === 2) throw new Error('simulated power-loss sync failure')
      return fs.fsyncSync(descriptor)
    }
  }
  const crashing = createEnterpriseSkillInstallOperationStore({ filePath, fsImpl, safeStorage: safeStorage() })
  assert.throws(() => crashing.writeIntent(operation()), /power-loss sync failure/)
  const recovered = createEnterpriseSkillInstallOperationStore({ filePath, safeStorage: safeStorage() }).readOperation()
  assert.equal(recovered.phase, 'creating')
  assert.equal(recovered.clientOperationId, operation().clientOperationId)
})
