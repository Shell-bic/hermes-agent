const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  createEnterpriseWindowConnections,
  WINDOW_CONNECTION_CHANNELS
} = require('./enterprise-window-connections.cjs')

function sender(id) {
  return { sender: { id } }
}

function harness({ timeoutMs = 100 } = {}) {
  const ipcMain = new EventEmitter()
  const messages = []
  const windows = [11, 22, 33].map(id => ({
    isDestroyed: () => false,
    webContents: {
      id,
      isDestroyed: () => false,
      send: (channel, payload) => messages.push({ channel, id, payload })
    }
  }))
  const connections = createEnterpriseWindowConnections({ getWindows: () => windows, ipcMain, timeoutMs })
  return { connections, ipcMain, messages, windows }
}

test('every live trusted window must acknowledge closing its runtime connections', async () => {
  const { connections, ipcMain, messages } = harness()

  let settled = false
  const close = connections.closeAll({ reasonCode: 'policy_denied' }).then(() => {
    settled = true
  })
  assert.deepEqual(messages.map(message => message.id), [11, 22, 33])
  const revocationId = messages[0].payload.revocationId

  ipcMain.emit(WINDOW_CONNECTION_CHANNELS.ACK, sender(11), { ok: true, revocationId })
  await Promise.resolve()
  assert.equal(settled, false)
  ipcMain.emit(WINDOW_CONNECTION_CHANNELS.ACK, sender(22), { ok: true, revocationId })
  ipcMain.emit(WINDOW_CONNECTION_CHANNELS.ACK, sender(33), { ok: true, revocationId })
  await close
  assert.equal(settled, true)
})

test('negative or missing acknowledgement fails closed without exposing renderer details', async () => {
  const negative = harness()
  const rejected = negative.connections.closeAll()
  const revocationId = negative.messages[0].payload.revocationId
  negative.ipcMain.emit(WINDOW_CONNECTION_CHANNELS.ACK, sender(11), {
    error: 'Bearer should-not-cross-boundary',
    ok: false,
    revocationId
  })
  negative.ipcMain.emit(WINDOW_CONNECTION_CHANNELS.ACK, sender(22), { ok: true, revocationId })
  negative.ipcMain.emit(WINDOW_CONNECTION_CHANNELS.ACK, sender(33), { ok: true, revocationId })
  await assert.rejects(rejected, error => {
    assert.equal(error.code, 'enterprise_window_revoke_failed')
    assert.equal(error.message.includes('should-not-cross-boundary'), false)
    return true
  })

  const missing = harness({ timeoutMs: 50 })
  await assert.rejects(missing.connections.closeAll(), error => error.code === 'enterprise_window_revoke_failed')
})

test('a renderer that becomes ready during revoke is enrolled and cannot escape the acknowledgement barrier', async () => {
  const { connections, ipcMain, messages, windows } = harness()
  const close = connections.closeAll()
  const revocationId = messages[0].payload.revocationId

  const late = {
    isDestroyed: () => false,
    webContents: {
      id: 44,
      isDestroyed: () => false,
      send: (channel, payload) => messages.push({ channel, id: 44, payload })
    }
  }
  windows.push(late)
  ipcMain.emit(WINDOW_CONNECTION_CHANNELS.READY, sender(44))
  assert.equal(messages.some(message => message.id === 44), true)

  for (const id of [11, 22, 33, 44]) {
    ipcMain.emit(WINDOW_CONNECTION_CHANNELS.ACK, sender(id), { ok: true, revocationId })
  }
  await close
})

test('READY resends a revoke that was emitted before the existing window installed its listener', async () => {
  const { connections, ipcMain, messages } = harness()
  const close = connections.closeAll()
  const revocationId = messages[0].payload.revocationId
  assert.equal(messages.filter(message => message.id === 11).length, 1)

  ipcMain.emit(WINDOW_CONNECTION_CHANNELS.READY, sender(11))
  assert.equal(messages.filter(message => message.id === 11).length, 2)
  ipcMain.emit(WINDOW_CONNECTION_CHANNELS.READY, sender(11))
  assert.equal(messages.filter(message => message.id === 11).length, 3)

  for (const id of [11, 22, 33]) {
    ipcMain.emit(WINDOW_CONNECTION_CHANNELS.ACK, sender(id), { ok: true, revocationId })
  }
  await close
})

test('an explicit NOT_READY after local teardown is excluded from retry until a new READY', async () => {
  const { connections, ipcMain, messages } = harness()
  ipcMain.emit(WINDOW_CONNECTION_CHANNELS.NOT_READY, sender(11))
  ipcMain.emit(WINDOW_CONNECTION_CHANNELS.NOT_READY, sender(22))
  ipcMain.emit(WINDOW_CONNECTION_CHANNELS.NOT_READY, sender(33))

  await connections.closeAll()
  assert.equal(messages.length, 0)

  ipcMain.emit(WINDOW_CONNECTION_CHANNELS.READY, sender(22))
  const retry = connections.closeAll()
  assert.deepEqual(messages.map(message => message.id), [22])
  ipcMain.emit(WINDOW_CONNECTION_CHANNELS.ACK, sender(22), {
    ok: true,
    revocationId: messages[0].payload.revocationId
  })
  await retry
})
