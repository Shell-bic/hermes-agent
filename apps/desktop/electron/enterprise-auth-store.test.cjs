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

test('enterprise auth store persists desktop token without exposing it in public session', () => {
  const filePath = tempFile()
  const store = createEnterpriseAuthStore({ filePath })

  store.writeSession({
    desktopToken: 'desktop-secret',
    expiresAt: '2026-07-01T00:00:00Z',
    user: { displayName: 'Ada' }
  })

  assert.equal(store.readSession().desktopToken, 'desktop-secret')
  assert.deepEqual(store.readPublicSession(), {
    expiresAt: '2026-07-01T00:00:00Z',
    user: { displayName: 'Ada' }
  })
  assert.equal(JSON.stringify(store.readPublicSession()).includes('desktop-secret'), false)
})

test('enterprise auth store uses safeStorage when available', () => {
  const filePath = tempFile()
  const safeStorage = {
    decryptString: buffer => Buffer.from(buffer.toString(), 'base64').toString('utf8'),
    encryptString: value => Buffer.from(Buffer.from(value, 'utf8').toString('base64')),
    isEncryptionAvailable: () => true
  }
  const store = createEnterpriseAuthStore({ filePath, safeStorage })

  store.writeSession({ desktopToken: 'desktop-secret' })

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(raw.desktopToken.encoding, 'safeStorage')
  assert.notEqual(raw.desktopToken.value, 'desktop-secret')
  assert.equal(store.readSession().desktopToken, 'desktop-secret')
})
