const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createEnterpriseWeComRelay, validateInboxMessage } = require('./enterprise-wecom-relay.cjs')

const message = {
  bindingId: '11234567-89ab-4def-8abc-0123456789ab',
  conversationId: 'conversation-1',
  inboxId: 'inbox-1',
  messageId: 'message-1',
  receivedAt: '2026-07-15T10:00:00Z',
  text: '你好'
}

test('relay durably queues final response before submit and acknowledges after acceptance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-relay-'))
  const calls = []
  let leased = false
  const client = {
    acquireWeComPersonalBotRuntimeLease: async () => ({ status: 'active', bindingId: message.bindingId }),
    leaseWeComPersonalBotInbox: async () => ({ messages: leased ? [] : (leased = true, [message]) }),
    submitWeComPersonalBotOutbox: async (_token, payload) => calls.push(['outbox', payload]),
    ackWeComPersonalBotInbox: async (_token, inboxId) => calls.push(['ack', inboxId])
  }
  const relay = createEnterpriseWeComRelay({
    client,
    getRuntimeToken: () => 'runtime-token',
    getWsUrl: async () => 'ws://unused',
    storePath: path.join(root, 'relay.json')
  })
  relay.store = new (require('./enterprise-wecom-relay.cjs').RelayStore)(path.join(root, 'relay.json'))
  relay.dispatch = async () => ({ sessionId: 'session-1', text: '最终回复' })

  await relay.tick()

  assert.deepEqual(calls.map(call => call[0]), ['outbox', 'ack'])
  assert.equal(calls[0][1].conversationId, 'conversation-1')
  assert.equal(relay.store.state.pendingOutbox.length, 0)
  assert.equal(JSON.stringify(relay.store.state).includes('runtime-token'), false)
})

test('inbox validator rejects unknown credential fields', () => {
  assert.throws(() => validateInboxMessage({ ...message, credential: 'forbidden' }), /invalid/)
})

test('composer outbox sends only the active binding and preserves stale entries as orphaned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-relay-composer-'))
  const queueDir = path.join(root, 'wecom-composer-outbox')
  const orphanedDir = path.join(root, 'wecom-composer-outbox-orphaned')
  const activeName = '11111111111111111111111111111111.json'
  const staleName = '22222222222222222222222222222222.json'
  const staleBindingId = '21234567-89ab-4def-8abc-0123456789ab'
  fs.mkdirSync(queueDir, { recursive: true })
  fs.writeFileSync(path.join(queueDir, activeName), JSON.stringify({
    bindingId: message.bindingId,
    conversationId: 'active-conversation',
    idempotencyKey: 'active-key',
    text: 'active message'
  }))
  fs.writeFileSync(path.join(queueDir, staleName), JSON.stringify({
    bindingId: staleBindingId,
    conversationId: 'stale-conversation',
    idempotencyKey: 'stale-key',
    text: 'stale message'
  }))

  const submitted = []
  const relay = createEnterpriseWeComRelay({
    client: {
      acquireWeComPersonalBotRuntimeLease: async () => ({ status: 'active', bindingId: message.bindingId }),
      leaseWeComPersonalBotInbox: async () => ({ messages: [] }),
      submitWeComPersonalBotOutbox: async (_token, payload) => submitted.push(payload),
      ackWeComPersonalBotInbox: async () => {}
    },
    getRuntimeToken: () => 'runtime-token',
    getWsUrl: async () => 'ws://unused',
    storePath: path.join(root, 'relay.json')
  })

  await relay.tick()

  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].conversationId, 'active-conversation')
  assert.equal(fs.existsSync(path.join(queueDir, activeName)), false)
  assert.equal(fs.existsSync(path.join(queueDir, staleName)), false)
  assert.equal(fs.existsSync(path.join(orphanedDir, staleName)), true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(orphanedDir, staleName), 'utf8')).bindingId, staleBindingId)
})
