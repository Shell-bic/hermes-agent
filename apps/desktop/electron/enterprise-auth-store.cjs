const fs = require('node:fs')
const path = require('node:path')

function encryptValue(value, safeStorage) {
  const text = String(value || '')

  if (!text) {
    return { encoding: 'plain', value: '' }
  }

  if (safeStorage && safeStorage.isEncryptionAvailable?.()) {
    try {
      return {
        encoding: 'safeStorage',
        value: safeStorage.encryptString(text).toString('base64')
      }
    } catch {
      // Fall through to plain so enterprise login still works on platforms
      // where safeStorage exists but the OS keychain is temporarily unavailable.
    }
  }

  return { encoding: 'plain', value: text }
}

function decryptValue(secret, safeStorage) {
  if (!secret || typeof secret !== 'object') {
    return ''
  }

  const value = String(secret.value || '')
  if (!value) return ''

  if (secret.encoding === 'safeStorage') {
    try {
      return safeStorage?.decryptString(Buffer.from(value, 'base64')) || ''
    } catch {
      return ''
    }
  }

  return value
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
    const desktopToken = decryptValue(raw?.desktopToken, this.safeStorage)

    if (!desktopToken) {
      return null
    }

    return {
      desktopToken,
      expiresAt: raw.expiresAt || null,
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

    const payload = {
      desktopToken: encryptValue(desktopToken, this.safeStorage),
      expiresAt: session.expiresAt || null,
      user: session.user || null,
      updatedAt: new Date().toISOString()
    }

    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    this.fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8')

    return sanitizeCachedSession(payload)
  }

  clear() {
    try {
      this.fs.rmSync(this.filePath, { force: true })
    } catch {
      // Missing or locked auth files are handled by the next login attempt.
    }
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
  sanitizeCachedSession
}
