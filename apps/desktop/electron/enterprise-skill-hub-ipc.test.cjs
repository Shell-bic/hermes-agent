const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')

const { createEnterpriseManagedLifecycle } = require('./enterprise-managed-lifecycle.cjs')
const { createEnterpriseRuntimeAccess } = require('./enterprise-runtime-access.cjs')
const { createEnterpriseSkillHubIpcHandler, registerEnterpriseSkillHubIpc } = require('./enterprise-skill-hub-ipc.cjs')
const { createEnterpriseSkillHub } = require('./enterprise-skill-hub.cjs')
const { unwrapEnterprisePublicResult } = require('./enterprise-public-error.cjs')

function deferred() {
  let resolve
  const promise = new Promise(next => {
    resolve = next
  })
  return { promise, resolve }
}

function harness() {
  const lifecycle = createEnterpriseManagedLifecycle({ hasSession: true })
  lifecycle.markRunning()
  const access = createEnterpriseRuntimeAccess({
    getLifecycle: () => lifecycle,
    isManaged: () => true
  })
  const handler = createEnterpriseSkillHubIpcHandler({
    assertTrusted: event => {
      if (event?.senderFrame?.url !== 'file:///desktop/index.html') throw new Error('untrusted')
    },
    getLifecycle: () => lifecycle,
    isEnabled: () => true
  })
  return { access, handler, lifecycle }
}

test('real Skill Hub IPC handler returns a captured-epoch structured error when revoke aborts its operation', async () => {
  const { access, handler, lifecycle } = harness()
  const started = deferred()
  const resultPromise = handler.run({ senderFrame: { url: 'file:///desktop/index.html' } }, () =>
    access.run(
      'enterprise:skill-hub:install',
      async (lease, signal) => {
        started.resolve()
        await new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(
                Object.assign(new Error('raw secret body'), {
                  code: 'request-canceled',
                  lifecycleEpoch: lease.lifecycleEpoch
                })
              )
            },
            { once: true }
          )
        })
      },
      { ipc: true }
    )
  )

  await started.promise
  await lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
  const result = await resultPromise

  assert.equal(result.ok, false)
  assert.equal(result.error.errorCode, 'request-canceled')
  assert.equal(result.error.lifecycleEpoch, 0)
  assert.equal(result.error.recoveryKind, 'none')
  assert.equal(JSON.stringify(result).includes('raw secret body'), false)
})

test('terminal status caused by this IPC uses the post-transition epoch and strict trusted sender boundary', async () => {
  const { handler, lifecycle } = harness()
  const denied = await handler.run({ senderFrame: { url: 'https://evil.invalid' } }, async () => 'never')
  assert.equal(denied.ok, false)
  assert.equal(denied.error.errorCode, 'enterprise_skill_hub_untrusted_renderer')

  const result = await handler.run({ senderFrame: { url: 'file:///desktop/index.html' } }, async () => {
    throw Object.assign(new Error('server response body'), { status: 426 })
  })
  assert.equal(lifecycle.getSnapshot().state, 'blocked')
  assert.equal(result.error.lifecycleEpoch, lifecycle.getSnapshot().lifecycleEpoch)
  assert.equal(result.error.recoveryKind, 'upgrade')
})

test('handler to preload unwrap preserves D4 structured recovery fields', async () => {
  const { handler } = harness()
  const result = await handler.run({ senderFrame: { url: 'file:///desktop/index.html' } }, async () => {
    throw Object.assign(new Error('private receipt payload'), {
      code: 'install_operation_receipt_invalid',
      status: 409
    })
  })
  assert.throws(() => unwrapEnterprisePublicResult(result), error => {
    assert.equal(error.envelope, 'enterprise-public-error.v1')
    assert.equal(error.errorCode, 'install_operation_receipt_invalid')
    assert.equal(error.httpStatus, 409)
    assert.equal(error.lifecycleEpoch, 0)
    assert.equal(error.recoveryKind, 'none')
    assert.equal(error.message, 'The enterprise skill installation receipt is invalid.')
    assert.equal(error.message.includes('private receipt payload'), false)
    return true
  })
})

test('registered production wiring to real hub install aborts on revoke before POST and cleans temp state', async () => {
  const { access, lifecycle } = harness()
  const body = Buffer.from('enterprise-skill-package')
  const artifactSha256 = crypto.createHash('sha256').update(body).digest('hex')
  const item = {
    artifactSha256,
    artifactSizeBytes: body.length,
    category: 'finance',
    currentRevision: 1,
    fileCount: 1,
    key: 'invoice-review',
    name: 'invoice-review',
    policyStatus: 'available'
  }
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('hermes-enterprise-skill-')))
  let postCount = 0
  const hub = createEnterpriseSkillHub({
    authStore: { readSession: () => ({ desktopToken: 'dsk_test' }) },
    client: {
      downloadSkillPackage: async () => {
        void lifecycle.revoke({ reasonCode: 'policy_denied', terminalState: 'blocked' })
        return new Response(body, {
          headers: {
            'content-length': String(body.length),
            'x-hermes-artifact-sha256': artifactSha256
          }
        })
      },
      skillHubSkill: async () => item
    },
    fetchImpl: async () => {
      postCount += 1
      return new Response('{}')
    },
    isManaged: true,
    localConnection: async () => ({ baseUrl: 'http://127.0.0.1:9000', token: 'local-token' }),
    runtimeAccess: access
  })
  let rejectedOperationCalls = 0
  const originalList = hub.list.bind(hub)
  hub.list = (...args) => {
    rejectedOperationCalls += 1
    return originalList(...args)
  }

  const handlers = new Map()
  registerEnterpriseSkillHubIpc({
    assertTrusted: event => {
      if (!event?.senderWindowValid || !event?.sender || event.senderFrame !== event.sender.mainFrame) throw new Error('untrusted')
      if (event.senderFrame.url !== 'file:///desktop/index.html') throw new Error('untrusted')
    },
    getLifecycle: () => lifecycle,
    hub,
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    isEnabled: () => true
  })

  const sameUrlSubframe = { url: 'file:///desktop/index.html' }
  const untrusted = await handlers.get('hermes:enterprise:skill-hub:list')({
    sender: { mainFrame: { url: 'file:///desktop/index.html' } },
    senderFrame: sameUrlSubframe,
    senderWindowValid: true
  }, {})
  assert.equal(untrusted.error.errorCode, 'enterprise_skill_hub_untrusted_renderer')
  const orphanFrame = { url: 'file:///desktop/index.html' }
  const noWindow = await handlers.get('hermes:enterprise:skill-hub:list')({
    sender: { mainFrame: orphanFrame },
    senderFrame: orphanFrame,
    senderWindowValid: false
  }, {})
  assert.equal(noWindow.error.errorCode, 'enterprise_skill_hub_untrusted_renderer')
  assert.equal(rejectedOperationCalls, 0)

  const mainFrame = { url: 'file:///desktop/index.html' }
  const event = { sender: { mainFrame }, senderFrame: mainFrame, senderWindowValid: true }

  const result = await handlers.get('hermes:enterprise:skill-hub:install')(
    event,
    { key: item.key, revision: item.currentRevision }
  )
  const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('hermes-enterprise-skill-'))

  assert.equal(result.ok, false)
  assert.equal(result.envelope, 'enterprise-public-result.v1')
  assert.equal(postCount, 0)
  assert.deepEqual(
    after.filter(name => !before.has(name)),
    []
  )
})
