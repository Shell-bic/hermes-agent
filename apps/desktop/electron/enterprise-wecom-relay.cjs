const fs = require('node:fs')
const path = require('node:path')

const RELAY_CONTRACT_VERSION = 'wecom-bot-runtime.v1'
const MAX_TEXT_LENGTH = 32_000
const MAX_WECOM_MESSAGE_LENGTH = 4_000
const STREAM_UPDATE_INTERVAL_MS = 500

function relayIdempotencyKey(inboxId) {
  return `wecom_${String(inboxId).replaceAll('-', '')}_final`
}

function relayStreamId(inboxId) {
  return `wecom_${String(inboxId).replaceAll('-', '')}`
}

function relayStreamUpdateKey(inboxId, sequence) {
  return `wecom_${String(inboxId).replaceAll('-', '')}_stream_${String(sequence).padStart(6, '0')}`
}

function safeText(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= MAX_TEXT_LENGTH && !containsControlCharacter(text, { allowWhitespace: true }) ? text : ''
}

function persistedFinal(messages, baselineMessageCount) {
  if (!Array.isArray(messages)) return ''
  const start = Math.max(0, Number.isFinite(baselineMessageCount) ? baselineMessageCount : 0)
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = safeText(message.text)
    if (text && !/^Error:/i.test(text)) return text
  }
  return ''
}

function validId(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !containsControlCharacter(value)
}

function containsControlCharacter(value, { allowWhitespace = false } = {}) {
  return [...value].some(character => {
    const code = character.charCodeAt(0)
    return code < 32 && !(allowWhitespace && (code === 9 || code === 10 || code === 13))
  })
}

function validateInboxMessage(value) {
  const fields = ['inboxId', 'bindingId', 'conversationId', 'messageId', 'text', 'receivedAt']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      fields.some(field => !Object.prototype.hasOwnProperty.call(value, field)) ||
      !validId(value.inboxId) || !/^[0-9a-fA-F-]{36}$/.test(value.bindingId) ||
      !validId(value.conversationId) || !validId(value.messageId) || !safeText(value.text) ||
      !Number.isFinite(Date.parse(value.receivedAt))) {
    throw new Error('Enterprise WeCom inbox response is invalid.')
  }
  return value
}

class RelayStore {
  constructor(filePath, { fsImpl = fs } = {}) {
    this.filePath = filePath
    this.fs = fsImpl
    this.state = { pendingOutbox: [], sessions: {} }
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        this.state.pendingOutbox = Array.isArray(parsed.pendingOutbox) ? parsed.pendingOutbox : []
        for (const entry of this.state.pendingOutbox) {
          if (validId(entry?.inboxId) && entry?.payload && typeof entry.payload === 'object') {
            entry.payload.idempotencyKey = relayIdempotencyKey(entry.inboxId)
          }
        }
        this.state.sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
      }
    } catch { /* absent or malformed state starts from an empty queue */ }
  }

  save() {
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    this.fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 })
    this.fs.renameSync(temporary, this.filePath)
  }

  session(bindingId, conversationId) {
    return this.state.sessions[`${bindingId}:${conversationId}`] || null
  }

  setSession(bindingId, conversationId, sessionId) {
    this.state.sessions[`${bindingId}:${conversationId}`] = sessionId
    this.save()
  }

  enqueue(entry) {
    if (!this.state.pendingOutbox.some(item => item.inboxId === entry.inboxId)) {
      this.state.pendingOutbox.push(entry)
      this.save()
    }
  }

  remove(inboxId) {
    this.state.pendingOutbox = this.state.pendingOutbox.filter(item => item.inboxId !== inboxId)
    this.save()
  }
}

class JsonRpcSocket {
  constructor({ WebSocketImpl = globalThis.WebSocket, timeoutMs = 10 * 60_000 } = {}) {
    this.WebSocketImpl = WebSocketImpl
    this.timeoutMs = timeoutMs
    this.socket = null
    this.nextId = 0
    this.pending = new Map()
    this.events = new Set()
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(url)
      this.socket = socket
      const timer = setTimeout(() => reject(new Error('Local Agent connection timed out.')), 15_000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Local Agent is unavailable.')) }, { once: true })
      socket.addEventListener('message', event => this.onMessage(event.data))
      socket.addEventListener('close', () => this.rejectAll(new Error('Local Agent connection closed.')))
    })
  }

  onMessage(raw) {
    let frame
    try { frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) } catch { return }
    if (frame.id != null) {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(frame.id)
      return frame.error ? pending.reject(new Error(frame.error.message || 'Local Agent request failed.')) : pending.resolve(frame.result)
    }
    if (frame.method === 'event' && frame.params?.type) {
      for (const listener of this.events) listener(frame.params)
    }
  }

  request(method, params) {
    const id = `wecom-relay-${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Local Agent request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { reject, resolve, timer })
      this.socket.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }))
    })
  }

  onEvent(listener) {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }

  waitForFinal(sessionId, { baselineMessageCount = 0, pollIntervalMs = 750 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false
      let pollTimer = null
      let lastPollError = null
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        cleanup()
        callback(value)
      }
      const timer = setTimeout(() => {
        finish(reject, lastPollError || new Error('Local Agent response timed out.'))
      }, this.timeoutMs)
      const listener = event => {
        if (event.session_id !== sessionId) return
        if (event.type === 'error') {
          finish(reject, new Error('Local Agent turn failed.'))
        } else if (event.type === 'message.complete') {
          const text = safeText(event.payload?.text)
          const status = event.payload?.status
          if (status !== 'complete' || !text || /^Error:/i.test(text)) {
            finish(reject, new Error('Local Agent did not produce a deliverable final response.'))
          } else {
            finish(resolve, text)
          }
        }
      }
      const pollHistory = async () => {
        if (settled) return
        try {
          const history = await this.request('session.history', { session_id: sessionId })
          const text = persistedFinal(history?.messages, baselineMessageCount)
          if (text) return finish(resolve, text)
          lastPollError = null
        } catch (error) {
          lastPollError = error instanceof Error ? error : new Error('Local Agent history is unavailable.')
        }
        if (!settled) pollTimer = setTimeout(pollHistory, pollIntervalMs)
      }
      const cleanup = () => {
        clearTimeout(timer)
        if (pollTimer) clearTimeout(pollTimer)
        this.events.delete(listener)
      }
      this.events.add(listener)
      pollTimer = setTimeout(pollHistory, pollIntervalMs)
    })
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  close() {
    try { this.socket?.close() } catch { /* socket may already be closed */ }
    this.socket = null
  }
}

class EnterpriseWeComRelay {
  constructor({ client, getRuntimeToken, getWsUrl, storePath, WebSocketImpl, onState = () => {},
    onSessionEvent = () => {}, pollIntervalMs = 1500,
    setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
    this.client = client
    this.getRuntimeToken = getRuntimeToken
    this.getWsUrl = getWsUrl
    this.WebSocketImpl = WebSocketImpl
    this.storePath = storePath
    this.store = null
    this.onState = onState
    this.onSessionEvent = onSessionEvent
    this.pollIntervalMs = pollIntervalMs
    this.setIntervalImpl = setIntervalImpl
    this.clearIntervalImpl = clearIntervalImpl
    this.timer = null
    this.running = false
    this.state = 'stopped'
  }

  updateState(state) {
    if (this.state !== state) {
      this.state = state
      this.onState({ state })
    }
  }

  start() {
    if (this.timer) return
    const storePath = typeof this.storePath === 'function' ? this.storePath() : this.storePath
    if (!storePath) return this.updateState('waiting-runtime-token')
    this.store = new RelayStore(storePath)
    this.updateState('connecting')
    void this.tick()
    this.timer = this.setIntervalImpl(() => void this.tick(), this.pollIntervalMs)
    this.timer?.unref?.()
  }

  stop() {
    if (this.timer) this.clearIntervalImpl(this.timer)
    this.timer = null
    this.store = null
    this.updateState('stopped')
  }

  async dispatch(message, runtimeToken) {
    if (!this.store) throw new Error('Enterprise WeCom relay store is unavailable.')
    const rpc = new JsonRpcSocket({ WebSocketImpl: this.WebSocketImpl })
    let clearSessionEvents = () => {}
    let streamTimer = null
    try {
      await rpc.connect(await this.getWsUrl())
      let session = null
      const stored = this.store.session(message.bindingId, message.conversationId)
      if (stored) {
        try {
          session = await rpc.request('session.resume', {
            session_id: stored,
            source_authorization: runtimeToken,
            source_context: {
              binding_id: message.bindingId,
              conversation_id: message.conversationId,
              source: 'wecom'
            }
          })
        } catch { /* stale sessions are recreated */ }
      }
      if (!session) {
        session = await rpc.request('session.create', {
          source_authorization: runtimeToken,
          source_context: {
            binding_id: message.bindingId,
            conversation_id: message.conversationId,
            source: 'wecom'
          },
          title: '企业微信会话'
        })
      }
      const runtimeSessionId = String(session?.session_id || '')
      const storedSessionId = String(session?.stored_session_id || session?.resumed || stored || '')
      if (!runtimeSessionId || !storedSessionId) throw new Error('Local Agent session response is invalid.')
      this.store.setSession(message.bindingId, message.conversationId, storedSessionId)
      const streamId = relayStreamId(message.inboxId)
      let streamText = ''
      let streamSequence = 0
      let streamEnabled = true
      let streamQueue = Promise.resolve()
      const submitStreamSnapshot = () => {
        streamTimer = null
        const content = streamText.trim()
        if (!streamEnabled || !content || content.length > MAX_WECOM_MESSAGE_LENGTH) return
        streamSequence += 1
        const idempotencyKey = relayStreamUpdateKey(message.inboxId, streamSequence)
        streamQueue = streamQueue.then(async () => {
          if (!streamEnabled) return
          try {
            await this.client.submitWeComPersonalBotOutbox(runtimeToken, {
              conversationId: message.conversationId,
              idempotencyKey,
              inReplyToInboxId: message.inboxId,
              streamFinish: false,
              streamId,
              text: content
            })
          } catch (error) {
            streamEnabled = false
            console.error('[hermes] [wecom-relay] streaming update failed', {
              code: typeof error?.code === 'string' ? error.code : null,
              status: Number.isInteger(error?.status) ? error.status : null
            })
          }
        })
      }
      clearSessionEvents = rpc.onEvent(event => {
        this.onSessionEvent({
          ...event,
          payload: { ...(event.payload && typeof event.payload === 'object' ? event.payload : {}), stored_session_id: storedSessionId }
        })
        if (event.session_id !== runtimeSessionId) return
        if (event.type === 'message.delta') {
          const delta = typeof event.payload?.text === 'string' ? event.payload.text : ''
          if (!delta || containsControlCharacter(delta, { allowWhitespace: true })) return
          streamText += delta
          if (!streamTimer && streamText.length <= MAX_WECOM_MESSAGE_LENGTH) {
            streamTimer = setTimeout(submitStreamSnapshot, STREAM_UPDATE_INTERVAL_MS)
            streamTimer?.unref?.()
          }
        } else if (event.type === 'message.complete' && streamTimer) {
          clearTimeout(streamTimer)
          streamTimer = null
        }
      })
      const baselineMessageCount = Array.isArray(session?.messages)
        ? session.messages.length
        : Number(session?.message_count || 0)
      const final = rpc.waitForFinal(runtimeSessionId, { baselineMessageCount })
      await rpc.request('prompt.submit', {
        session_id: runtimeSessionId,
        text: message.text,
        wecom_relay_inbound: true
      })
      const text = await final
      if (streamTimer) {
        clearTimeout(streamTimer)
        streamTimer = null
      }
      await streamQueue
      return { sessionId: storedSessionId, streamId, text }
    } finally {
      if (streamTimer) clearTimeout(streamTimer)
      clearSessionEvents()
      rpc.close()
    }
  }

  async flushPending(token) {
    if (!this.store) return
    for (const entry of [...this.store.state.pendingOutbox]) {
      await this.client.submitWeComPersonalBotOutbox(token, entry.payload)
      await this.client.ackWeComPersonalBotInbox(token, entry.inboxId)
      this.store.remove(entry.inboxId)
    }
  }

  async flushComposerOutbox(token) {
    const storeFile = typeof this.storePath === 'function' ? this.storePath() : this.storePath
    if (!storeFile) return
    const queueDir = path.join(path.dirname(storeFile), 'wecom-composer-outbox')
    let names
    try { names = fs.readdirSync(queueDir).filter(name => /^[a-f0-9]{32}\.json$/.test(name)) } catch { return }
    for (const name of names) {
      const file = path.join(queueDir, name)
      let payload
      try { payload = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
      const fields = ['bindingId', 'conversationId', 'idempotencyKey', 'text']
      if (!payload || Object.keys(payload).length !== fields.length || fields.some(field => !(field in payload)) ||
          !/^[0-9a-fA-F-]{36}$/.test(payload.bindingId) || !validId(payload.conversationId) ||
          !validId(payload.idempotencyKey, 512) || !safeText(payload.text)) {
        continue
      }
      await this.client.submitWeComPersonalBotOutbox(token, {
        conversationId: payload.conversationId,
        idempotencyKey: payload.idempotencyKey,
        text: payload.text
      })
      fs.unlinkSync(file)
    }
  }

  async tick() {
    if (this.running) return
    this.running = true
    try {
      const token = String(this.getRuntimeToken?.() || '').trim()
      if (!token) return this.updateState('waiting-runtime-token')
      const lease = await this.client.acquireWeComPersonalBotRuntimeLease(token)
      if (lease?.status === 'lease-lost' || lease?.status === 'replaced') return this.updateState('lease-lost')
      await this.flushPending(token)
      await this.flushComposerOutbox(token)
      const batch = await this.client.leaseWeComPersonalBotInbox(token, { maxMessages: 4 })
      const messages = Array.isArray(batch?.messages) ? batch.messages.map(validateInboxMessage) : []
      for (const message of messages) {
        const response = await this.dispatch(message, token)
        const payload = {
          conversationId: message.conversationId,
          idempotencyKey: relayIdempotencyKey(message.inboxId),
          inReplyToInboxId: message.inboxId,
          streamFinish: true,
          streamId: response.streamId,
          text: response.text
        }
        this.store.enqueue({ inboxId: message.inboxId, payload, sessionId: response.sessionId })
        await this.flushPending(token)
      }
      this.updateState('connected')
    } catch (error) {
      console.error('[hermes] [wecom-relay] tick failed', {
        code: typeof error?.code === 'string' ? error.code : null,
        status: Number.isInteger(error?.status) ? error.status : null
      })
      this.updateState(error?.status === 409 ? 'lease-lost' : 'error')
    } finally {
      this.running = false
    }
  }
}

function createEnterpriseWeComRelay(options) {
  return new EnterpriseWeComRelay(options)
}

module.exports = {
  EnterpriseWeComRelay,
  JsonRpcSocket,
  RELAY_CONTRACT_VERSION,
  RelayStore,
  createEnterpriseWeComRelay,
  safeText,
  validateInboxMessage
}
