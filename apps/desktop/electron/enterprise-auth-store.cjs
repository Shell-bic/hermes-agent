const fs = require('node:fs')
const path = require('node:path')

function isSecureStorageAvailable(safeStorage) {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    return false
  }

  if (typeof safeStorage.getSelectedStorageBackend === 'function') {
    try {
      if (String(safeStorage.getSelectedStorageBackend() || '').trim().toLowerCase() === 'basic_text') {
        return false
      }
    } catch {
      // This Electron API is Linux-specific and may reject on other platforms.
      // isEncryptionAvailable remains the platform contract outside Linux.
    }
  }

  return true
}

function encryptValue(value, safeStorage) {
  const text = String(value || '')

  if (!text) {
    throw new Error('Cannot encrypt an empty enterprise desktop token.')
  }

  if (!isSecureStorageAvailable(safeStorage)) {
    throw new Error('Secure enterprise token storage is unavailable.')
  }

  try {
    return {
      encoding: 'safeStorage',
      value: safeStorage.encryptString(text).toString('base64')
    }
  } catch (error) {
    throw new Error(`Secure enterprise token storage failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function decryptValue(secret, safeStorage) {
  if (!secret || typeof secret !== 'object') {
    return ''
  }

  const value = String(secret.value || '')
  if (!value) return ''

  if (secret.encoding !== 'safeStorage' || !isSecureStorageAvailable(safeStorage)) {
    return ''
  }

  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64')) || ''
  } catch {
    return ''
  }
}

function sanitizeCachedSession(session) {
  if (!session || typeof session !== 'object') {
    return null
  }

  return {
    expiresAt: session.expiresAt || null,
    user: session.user || null
  }
}

class EnterpriseAuthStore {
  constructor({ filePath, fsImpl = fs, safeStorage } = {}) {
    if (!filePath) {
      throw new Error('EnterpriseAuthStore requires filePath.')
    }

    this.filePath = filePath
    this.fs = fsImpl
    this.safeStorage = safeStorage
  }

  readRaw() {
    try {
      return JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'))
    } catch {
      return null
    }
  }

  readSession() {
    const raw = this.readRaw()
    const encryptedToken = raw?.desktopToken

    if (!encryptedToken) {
      return null
    }

    // Known-invalid or legacy plaintext envelopes must not remain on disk.
    // A valid safeStorage envelope is different: the OS credential service
    // can become temporarily unavailable while Electron is shutting down
    // (notably when the dev terminal receives Ctrl+C). Fail closed for this
    // read, but preserve the ciphertext so the next normal launch can decrypt
    // the still-valid Desktop session.
    if (
      typeof encryptedToken !== 'object' ||
      encryptedToken.encoding !== 'safeStorage' ||
      !String(encryptedToken.value || '')
    ) {
      this.clear()
      return null
    }

    if (!isSecureStorageAvailable(this.safeStorage)) {
      return null
    }

    const desktopToken = decryptValue(encryptedToken, this.safeStorage)

    if (!desktopToken) {
      // Decryption can also fail transiently while the OS credential service
      // is locking. Keep the encrypted envelope; explicit login overwrites it
      // if it is genuinely no longer decryptable.
      return null
    }

    const expiresAt = raw.expiresAt || null
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
      this.clear()
      return null
    }

    return {
      desktopToken,
      expiresAt,
      user: raw.user || null
    }
  }

  readPublicSession() {
    return sanitizeCachedSession(this.readSession())
  }

  writeSession(session) {
    const desktopToken = String(session?.desktopToken || '').trim()

    if (!desktopToken) {
      throw new Error('Cannot persist an empty enterprise desktop token.')
    }

    const temporaryPath = `${this.filePath}.${process.pid}.tmp`

    try {
      const encryptedToken = encryptValue(desktopToken, this.safeStorage)
      const payload = {
        desktopToken: encryptedToken,
        expiresAt: session.expiresAt || null,
        user: session.user || null,
        updatedAt: new Date().toISOString()
      }

      this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      this.fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
      this.fs.renameSync(temporaryPath, this.filePath)

      return sanitizeCachedSession(payload)
    } catch (error) {
      this.clearPath(temporaryPath)
      this.clear()
      throw error
    }
  }

  clearPath(filePath) {
    try {
      this.fs.rmSync(filePath, { force: true })
    } catch {
      // Missing or locked auth files are handled by the next login attempt.
    }
  }

  clear() {
    this.clearPath(this.filePath)
    this.clearPath(`${this.filePath}.${process.pid}.tmp`)
  }
}

function createEnterpriseAuthStore(options) {
  return new EnterpriseAuthStore(options)
}

module.exports = {
  EnterpriseAuthStore,
  createEnterpriseAuthStore,
  decryptValue,
  encryptValue,
  isSecureStorageAvailable,
  sanitizeCachedSession
}
