const WINDOW_CONNECTION_CHANNELS = Object.freeze({
  ACK: 'hermes:enterprise:runtime-revoke-ack',
  NOT_READY: 'hermes:enterprise:runtime-revoke-not-ready',
  READY: 'hermes:enterprise:runtime-revoke-ready',
  REVOKE: 'hermes:enterprise:runtime-revoke'
})

class EnterpriseWindowConnectionError extends Error {
  constructor(code) {
    super(code)
    this.name = 'EnterpriseWindowConnectionError'
    this.code = code
  }
}

function createEnterpriseWindowConnections(options = {}) {
  const ipcMain = options.ipcMain
  const getWindows = options.getWindows || (() => [])
  const isTrustedWindow = options.isTrustedWindow || (() => true)
  const timeoutMs = Math.max(50, Number(options.timeoutMs) || 2_000)
  const readySenders = new Set()
  const notReadySenders = new Set()
  const pending = new Map()
  let nextRevocationId = 1

  if (!ipcMain?.on || !ipcMain?.removeListener) {
    throw new TypeError('Enterprise window connection cleanup requires ipcMain event methods.')
  }

  const senderId = event => Number(event?.sender?.id)
  const onReady = event => {
    const id = senderId(event)
    if (!Number.isInteger(id)) return
    readySenders.add(id)
    notReadySenders.delete(id)
    for (const operation of pending.values()) {
      const window = targets().find(candidate => candidate.webContents.id === id)
      if (window && !operation.ackedSenderIds.has(id)) {
        operation.senderIds.add(id)
        operation.send(window)
      }
    }
  }
  const onNotReady = event => {
    const id = senderId(event)
    if (Number.isInteger(id)) {
      readySenders.delete(id)
      notReadySenders.add(id)
    }
  }
  const onAck = (event, payload) => {
    const revocationId = Number(payload?.revocationId)
    const operation = pending.get(revocationId)
    const id = senderId(event)
    if (!operation || !Number.isInteger(id) || !operation.senderIds.has(id)) return
    if (payload?.ok !== true) operation.failed = true
    operation.senderIds.delete(id)
    operation.ackedSenderIds.add(id)
    if (operation.senderIds.size === 0) operation.finish()
  }

  ipcMain.on(WINDOW_CONNECTION_CHANNELS.READY, onReady)
  ipcMain.on(WINDOW_CONNECTION_CHANNELS.NOT_READY, onNotReady)
  ipcMain.on(WINDOW_CONNECTION_CHANNELS.ACK, onAck)

  function targets() {
    return getWindows().filter(window => {
      const contents = window?.webContents
      return (
        contents &&
        Number.isInteger(contents.id) &&
        !notReadySenders.has(contents.id) &&
        isTrustedWindow(window) === true &&
        window.isDestroyed?.() !== true &&
        contents.isDestroyed?.() !== true
      )
    })
  }

  function closeAll({ reasonCode = 'enterprise_runtime_revoked' } = {}) {
    const windows = targets()
    if (windows.length === 0) return Promise.resolve(true)

    const revocationId = nextRevocationId++
    const senderIds = new Set(windows.map(window => window.webContents.id))
    let timer = null
    let settled = false

    const promise = new Promise((resolve, reject) => {
      const operation = {
        ackedSenderIds: new Set(),
        failed: false,
        senderIds,
        send: window => {
          try {
            window.webContents.send(WINDOW_CONNECTION_CHANNELS.REVOKE, {
              reasonCode: /^[a-z0-9_.-]{1,96}$/.test(String(reasonCode || ''))
                ? String(reasonCode)
                : 'enterprise_runtime_revoked',
              revocationId
            })
          } catch {
            operation.failed = true
            operation.senderIds.delete(window.webContents.id)
          }
        },
        finish: () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          pending.delete(revocationId)
          if (operation.failed) reject(new EnterpriseWindowConnectionError('enterprise_window_revoke_failed'))
          else resolve(true)
        }
      }
      pending.set(revocationId, operation)
      timer = setTimeout(() => {
        operation.failed = true
        operation.finish()
      }, timeoutMs)

      for (const window of windows) {
        operation.send(window)
      }
      if (operation.senderIds.size === 0) operation.finish()
    })

    return promise
  }

  function dispose() {
    ipcMain.removeListener(WINDOW_CONNECTION_CHANNELS.READY, onReady)
    ipcMain.removeListener(WINDOW_CONNECTION_CHANNELS.NOT_READY, onNotReady)
    ipcMain.removeListener(WINDOW_CONNECTION_CHANNELS.ACK, onAck)
    readySenders.clear()
    notReadySenders.clear()
  }

  return Object.freeze({ closeAll, dispose })
}

module.exports = {
  createEnterpriseWindowConnections,
  EnterpriseWindowConnectionError,
  WINDOW_CONNECTION_CHANNELS
}
