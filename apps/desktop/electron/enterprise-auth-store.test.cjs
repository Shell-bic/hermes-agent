const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createEnterpriseAuthStore } = require('./enterprise-auth-store.cjs')

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-enterprise-auth-'))
  return path.join(dir, 'auth.json')
}

function fakeSafeStorage() {
  return {
    decryptString: buffer => Buffer.from(buffer.toString(), 'base64').toString('utf8'),
    encryptString: value => Buffer.from(Buffer.from(value, 'utf8').toString('base64')),
    isEncryptionAvailable: () => true
  }
}

test('enterprise auth store persists desktop token without exposing it in public session', () => {
  const filePath = tempFile()
  const store = createEnterpriseAuthStore({ filePath, safeStorage: fakeSafeStorage() })

  store.writeSession({
    desktopToken: 'desktop-secret',
    expiresAt: '2099-07-01T00:00:00Z',
    user: { displayName: 'Ada' }
  })

  assert.equal(store.readSession().desktopToken, 'desktop-secret')
  assert.deepEqual(store.readPublicSession(), {
    expiresAt: '2099-07-01T00:00:00Z',
    user: { displayName: 'Ada' }
  })
  assert.equal(JSON.stringify(store.readPublicSession()).includes('desktop-secret'), false)
})

test('enterprise auth store uses safeStorage when available', () => {
  const filePath = tempFile()
  const safeStorage = fakeSafeStorage()
  const store = createEnterpriseAuthStore({ filePath, safeStorage })

  store.writeSession({ desktopToken: 'desktop-secret' })

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(raw.desktopToken.encoding, 'safeStorage')
  assert.notEqual(raw.desktopToken.value, 'desktop-secret')
  assert.equal(store.readSession().desktopToken, 'desktop-secret')
})

test('enterprise auth store fails closed when safeStorage is unavailable', () => {
  const filePath = tempFile()
  const store = createEnterpriseAuthStore({
    filePath,
    safeStorage: { isEncryptionAvailable: () => false }
  })

  assert.throws(() => store.writeSession({ desktopToken: 'desktop-secret' }), /Secure enterprise token storage is unavailable/)
  assert.equal(fs.existsSync(filePath), false)
})

test('enterprise auth store rejects Linux basic_text even when Electron reports encryption available', () => {
  const filePath = tempFile()
  let encryptCalled = false
  const store = createEnterpriseAuthStore({
    filePath,
    safeStorage: {
      encryptString: () => {
        encryptCalled = true
        return Buffer.from('not-secure')
      },
      getSelectedStorageBackend: () => 'basic_text',
      isEncryptionAvailable: () => true
    }
  })

  assert.throws(() => store.writeSession({ desktopToken: 'desktop-secret' }), /Secure enterprise token storage is unavailable/)
  assert.equal(encryptCalled, false)
  assert.equal(fs.existsSync(filePath), false)
})

test('enterprise auth store clears an existing session when Linux falls back to basic_text', () => {
  const filePath = tempFile()
  let decryptCalled = false
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      desktopToken: { encoding: 'safeStorage', value: Buffer.from('ciphertext').toString('base64') },
      expiresAt: '2099-01-01T00:00:00Z'
    }),
    'utf8'
  )
  const store = createEnterpriseAuthStore({
    filePath,
    safeStorage: {
      decryptString: () => {
        decryptCalled = true
        return 'desktop-secret'
      },
      getSelectedStorageBackend: () => 'basic_text',
      isEncryptionAvailable: () => true
    }
  })

  assert.equal(store.readSession(), null)
  assert.equal(decryptCalled, false)
  assert.equal(fs.existsSync(filePath), false)
})

test('enterprise auth store clears any prior file when secure encryption fails', () => {
  const filePath = tempFile()
  fs.writeFileSync(filePath, 'legacy token material', 'utf8')
  const store = createEnterpriseAuthStore({
    filePath,
    safeStorage: {
      encryptString: () => {
        throw new Error('keychain locked')
      },
      isEncryptionAvailable: () => true
    }
  })

  assert.throws(() => store.writeSession({ desktopToken: 'desktop-secret' }), /Secure enterprise token storage failed/)
  assert.equal(fs.existsSync(filePath), false)
})

test('enterprise auth store clears prior and temporary files when atomic write fails', () => {
  const filePath = tempFile()
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(filePath, 'prior encrypted session', 'utf8')
  const fsImpl = Object.create(fs)
  fsImpl.writeFileSync = target => {
    fs.writeFileSync(target, 'partial encrypted session', 'utf8')
    throw new Error('disk full')
  }
  const store = createEnterpriseAuthStore({ filePath, fsImpl, safeStorage: fakeSafeStorage() })

  assert.throws(() => store.writeSession({ desktopToken: 'desktop-secret' }), /disk full/)
  assert.equal(fs.existsSync(filePath), false)
  assert.equal(fs.existsSync(temporaryPath), false)
})

test('enterprise auth store clears prior and temporary files when atomic rename fails', () => {
  const filePath = tempFile()
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(filePath, 'prior encrypted session', 'utf8')
  const fsImpl = Object.create(fs)
  fsImpl.renameSync = () => {
    throw new Error('rename denied')
  }
  const store = createEnterpriseAuthStore({ filePath, fsImpl, safeStorage: fakeSafeStorage() })

  assert.throws(() => store.writeSession({ desktopToken: 'desktop-secret' }), /rename denied/)
  assert.equal(fs.existsSync(filePath), false)
  assert.equal(fs.existsSync(temporaryPath), false)
})

test('enterprise auth store rejects and clears legacy plaintext sessions', () => {
  const filePath = tempFile()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    JSON.stringify({ desktopToken: { encoding: 'plain', value: 'legacy-secret' }, expiresAt: '2099-01-01T00:00:00Z' }),
    'utf8'
  )
  const store = createEnterpriseAuthStore({ filePath, safeStorage: fakeSafeStorage() })

  assert.equal(store.readSession(), null)
  assert.equal(fs.existsSync(filePath), false)
})

test('enterprise auth store clears an expired encrypted session', () => {
  const filePath = tempFile()
  const store = createEnterpriseAuthStore({ filePath, safeStorage: fakeSafeStorage() })
  store.writeSession({ desktopToken: 'desktop-secret', expiresAt: '2020-01-01T00:00:00Z' })

  assert.equal(store.readSession(), null)
  assert.equal(fs.existsSync(filePath), false)
})
