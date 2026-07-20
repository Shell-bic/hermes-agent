const fs = require('node:fs')
const path = require('node:path')

const { decryptValue, encryptValue, isSecureStorageAvailable } = require('./enterprise-auth-store.cjs')

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const CLIENT_OPERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SKILL_KEY_RE = /^[\p{L}\p{N}._-]+$/u
const MAX_STORE_BYTES = 64 * 1024
const MAX_TOKEN_LENGTH = 4096

function validSkillKey(value) {
  const first = String(value || '').split('.', 1)[0].toUpperCase()
  return (
    value.length <= 64 &&
    value !== '.' &&
    value !== '..' &&
    !value.endsWith('.') &&
    !value.endsWith(' ') &&
    !['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)].includes(first) &&
    SKILL_KEY_RE.test(value)
  )
}

class EnterpriseSkillInstallOperationStoreError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EnterpriseSkillInstallOperationStoreError'
    this.code = 'enterprise_skill_install_recovery_unavailable'
  }
}

function validateIntent(value) {
  const input = value && typeof value === 'object' ? value : {}
  const operation = {
    phase: String(input.phase || 'creating').trim(),
    clientOperationId: String(input.clientOperationId || '').trim(),
    key: String(input.key || '').trim(),
    revision: input.revision,
    artifactSha256: String(input.artifactSha256 || '').trim().toLowerCase(),
    userId: String(input.userId || '').trim(),
    hermesHome: String(input.hermesHome || '').trim()
  }
  if (
    operation.phase !== 'creating' ||
    !CLIENT_OPERATION_RE.test(operation.clientOperationId) ||
    !validSkillKey(operation.key) ||
    typeof operation.revision !== 'number' ||
    !Number.isSafeInteger(operation.revision) ||
    operation.revision < 1 ||
    !SHA256_RE.test(operation.artifactSha256) ||
    !GUID_RE.test(operation.userId) ||
    !operation.hermesHome ||
    operation.hermesHome.length > 4096 ||
    !path.isAbsolute(operation.hermesHome)
  ) {
    throw new EnterpriseSkillInstallOperationStoreError('Enterprise skill install recovery intent is invalid.')
  }
  return operation
}

function validateOperation(value) {
  const input = value && typeof value === 'object' ? value : {}
  const intent = validateIntent({ ...input, phase: 'creating' })
  const operation = {
    ...intent,
    phase: 'created',
    operationId: String(input.operationId || '').trim().toLowerCase(),
    installAuthorizationHash: String(input.installAuthorizationHash || '').trim().toLowerCase(),
    materializedContentHash: String(input.materializedContentHash || '').trim().toLowerCase(),
    desktopUserId: String(input.desktopUserId || '').trim(),
    tenantId: input.tenantId == null ? null : String(input.tenantId).trim(),
    materializationBindingSchemaVersion: input.materializationBindingSchemaVersion,
    materializationRecoveryExpiresAt: String(input.materializationRecoveryExpiresAt || '').trim(),
    expiresAt: String(input.expiresAt || '').trim(),
    reconciliationToken: String(input.reconciliationToken || '').trim()
  }
  if (
    !GUID_RE.test(operation.operationId) ||
    !GUID_RE.test(operation.desktopUserId) ||
    operation.desktopUserId !== operation.userId ||
    typeof operation.materializationBindingSchemaVersion !== 'number' ||
    !Number.isSafeInteger(operation.materializationBindingSchemaVersion) ||
    operation.materializationBindingSchemaVersion !== 2 ||
    !Number.isFinite(Date.parse(operation.materializationRecoveryExpiresAt)) ||
    (operation.tenantId !== null && (!operation.tenantId || operation.tenantId.length > 256)) ||
    !SHA256_RE.test(operation.installAuthorizationHash) ||
    !SHA256_RE.test(operation.materializedContentHash) ||
    !Number.isFinite(Date.parse(operation.expiresAt)) ||
    !operation.reconciliationToken.startsWith('srt_') ||
    operation.reconciliationToken.length > MAX_TOKEN_LENGTH
  ) {
    throw new EnterpriseSkillInstallOperationStoreError('Enterprise skill install recovery state is invalid.')
  }
  return operation
}

class EnterpriseSkillInstallOperationStore {
  constructor({ filePath, fsImpl = fs, safeStorage } = {}) {
    if (!filePath) throw new Error('EnterpriseSkillInstallOperationStore requires filePath.')
    this.filePath = filePath
    this.fs = fsImpl
    this.safeStorage = safeStorage
  }

  assertAvailable() {
    if (!isSecureStorageAvailable(this.safeStorage)) {
      throw new EnterpriseSkillInstallOperationStoreError('Secure enterprise skill recovery storage is unavailable.')
    }
    return true
  }

  readOperation() {
    if (!this.fs.existsSync(this.filePath)) return null
    let document
    try {
      if (this.fs.statSync(this.filePath).size > MAX_STORE_BYTES) {
        throw new Error('oversize')
      }
      document = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'))
    } catch {
      throw new EnterpriseSkillInstallOperationStoreError('Enterprise skill install recovery state is unreadable.')
    }
    if (document?.schemaVersion !== 1 || !['creating', 'created'].includes(document?.phase)) {
      throw new EnterpriseSkillInstallOperationStoreError('Enterprise skill install recovery state is invalid.')
    }
    if (document.phase === 'creating') return validateIntent(document)
    const reconciliationToken = decryptValue(document.reconciliationToken, this.safeStorage)
    if (!reconciliationToken) throw new EnterpriseSkillInstallOperationStoreError('Secure enterprise skill recovery token is unavailable.')
    return validateOperation({ ...document, reconciliationToken })
  }

  writeDocument(document) {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    let descriptor = null
    try {
      this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      descriptor = this.fs.openSync(temporaryPath, 'w', 0o600)
      this.fs.writeFileSync(descriptor, JSON.stringify(document, null, 2), 'utf8')
      this.fs.fsyncSync?.(descriptor)
      this.fs.closeSync(descriptor)
      descriptor = null
      this.fs.renameSync(temporaryPath, this.filePath)
      descriptor = this.fs.openSync(this.filePath, 'r+')
      this.fs.fsyncSync?.(descriptor)
      this.fs.closeSync(descriptor)
      descriptor = null
      if (process.platform !== 'win32') {
        descriptor = this.fs.openSync(path.dirname(this.filePath), 'r')
        this.fs.fsyncSync?.(descriptor)
        this.fs.closeSync(descriptor)
        descriptor = null
      }
    } catch (error) {
      if (descriptor !== null) {
        try {
          this.fs.closeSync(descriptor)
        } catch {}
      }
      try {
        this.fs.rmSync(temporaryPath, { force: true })
      } catch {}
      throw error
    }
  }

  writeIntent(value) {
    this.assertAvailable()
    const intent = validateIntent({ ...value, phase: 'creating' })
    this.writeDocument({ schemaVersion: 1, ...intent, updatedAt: new Date().toISOString() })
    return intent
  }

  writeOperation(value) {
    this.assertAvailable()
    const operation = validateOperation(value)
    const current = this.readOperation()
    if (
      !current ||
      ['clientOperationId', 'key', 'revision', 'artifactSha256', 'userId', 'hermesHome'].some(
        field => current[field] !== operation[field]
      ) ||
      (current.phase === 'created' &&
        ['operationId', 'installAuthorizationHash', 'materializedContentHash', 'desktopUserId', 'tenantId', 'materializationBindingSchemaVersion', 'materializationRecoveryExpiresAt'].some(
          field => current[field] !== operation[field]
        ))
    ) {
      throw new EnterpriseSkillInstallOperationStoreError('Enterprise skill install recovery intent does not match.')
    }
    this.writeDocument({
      schemaVersion: 1,
      phase: 'created',
      operationId: operation.operationId,
      clientOperationId: operation.clientOperationId,
      key: operation.key,
      revision: operation.revision,
      artifactSha256: operation.artifactSha256,
      installAuthorizationHash: operation.installAuthorizationHash,
      desktopUserId: operation.desktopUserId,
      tenantId: operation.tenantId,
      materializationBindingSchemaVersion: operation.materializationBindingSchemaVersion,
      materializedContentHash: operation.materializedContentHash,
      materializationRecoveryExpiresAt: operation.materializationRecoveryExpiresAt,
      expiresAt: operation.expiresAt,
      userId: operation.userId,
      hermesHome: operation.hermesHome,
      reconciliationToken: encryptValue(operation.reconciliationToken, this.safeStorage),
      updatedAt: new Date().toISOString()
    })
    return operation
  }

  clear() {
    try {
      this.fs.rmSync(this.filePath, { force: true })
    } catch {}
    try {
      this.fs.rmSync(`${this.filePath}.${process.pid}.tmp`, { force: true })
    } catch {}
  }
}

function createEnterpriseSkillInstallOperationStore(options) {
  return new EnterpriseSkillInstallOperationStore(options)
}

module.exports = {
  EnterpriseSkillInstallOperationStore,
  EnterpriseSkillInstallOperationStoreError,
  createEnterpriseSkillInstallOperationStore,
  validateIntent,
  validateOperation
}
