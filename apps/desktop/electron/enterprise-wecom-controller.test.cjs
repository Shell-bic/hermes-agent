const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createEnterpriseWeComController,
  normalizeAuthorizationOrigin,
  stableErrorCode,
  validateAuthorizationUrl
} = require('./enterprise-wecom-controller.cjs')

function createHarness(overrides = {}) {
  const calls = []
  let remoteStatus = { status: 'pending', expiresAt: '2099-07-13T00:05:00Z' }
  const client = {
    cancelWeCom: async id => calls.push(['cancel', id]),
    loginMethods: async () => ({
      defaultMethod: 'wecom-qr',
      enterpriseDisplayName: 'Example Corp',
      methods: ['wecom-qr', 'password'],
      weComAuthorizationOrigin: 'https://auth.example.com'
    }),
    logout: async token => calls.push(['logout', token]),
    redeemWeCom: async request => {
      calls.push(['redeem', request.transactionId, request.verifier])
      return { desktopToken: 'dsk_secret', user: { displayName: 'Ada' } }
    },
    startWeCom: async request => {
      calls.push(['start', request.challenge])
      return {
        authorizationUrl: 'https://auth.example.com/wecom/login/opaque_transaction_123',
        expiresAt: '2099-07-13T00:05:00Z',
        transactionId: 'tx-secret'
      }
    },
    weComStatus: async id => {
      calls.push(['status', id])
      return remoteStatus
    },
    ...overrides.client
  }
  const qrView = {
    destroy: async () => calls.push(['view-destroy']),
    open: async (url, options) => calls.push(['view-open', url, options]),
    setBounds: bounds => calls.push(['bounds', bounds]),
    ...overrides.qrView
  }
  const runtime = {
    acceptLoginSession: async session => {
      calls.push(['session', session.desktopToken])
      return { user: session.user }
    },
    ...overrides.runtime
  }
  const controller = createEnterpriseWeComController({
    clearIntervalImpl: () => undefined,
    client,
    now: () => Date.parse('2099-07-13T00:00:00Z'),
    onAuthenticated: async () => calls.push(['authenticated']),
    qrView,
    randomBytes: () => Buffer.alloc(32, 7),
    runtime,
    setIntervalImpl: () => ({ unref: () => undefined }),
    ...overrides.options
  })
  return {
    calls,
    client,
    controller,
    setRemoteStatus: value => {
      remoteStatus = value
    }
  }
}

test('controller keeps transaction material private and completes the shared session path', async () => {
  const harness = createHarness()
  const initial = await harness.controller.initialize()

  assert.equal(initial.status, 'qr-pending')
  assert.equal(initial.enterpriseDisplayName, 'Example Corp')
  assert.deepEqual(initial.methods, ['wecom-qr', 'password'])
  assert.deepEqual(harness.calls.find(call => call[0] === 'view-open'), [
    'view-open',
    'https://auth.example.com/wecom/login/opaque_transaction_123',
    { authorizationOrigin: 'https://auth.example.com' }
  ])
  const publicJson = JSON.stringify(initial)
  for (const forbidden of ['transactionId', 'authorizationUrl', 'verifier', 'assertion', 'dsk_secret', 'tx-secret']) {
    assert.equal(publicJson.includes(forbidden), false, `public state leaked ${forbidden}`)
  }

  harness.setRemoteStatus({ status: 'verified', expiresAt: '2099-07-13T00:05:00Z' })
  const success = await harness.controller.poll()
  assert.equal(success.status, 'success')
  assert.deepEqual(success.user, { displayName: 'Ada' })
  assert.equal(JSON.stringify(success).includes('dsk_secret'), false)
  assert.equal(harness.calls.filter(call => call[0] === 'redeem').length, 1)
  assert.equal(harness.calls.filter(call => call[0] === 'session').length, 1)
  assert.equal(harness.calls.filter(call => call[0] === 'authenticated').length, 1)
})

test('controller removes a disabled WeCom method when trusted auth origin is missing', async () => {
  const { controller } = createHarness({
    client: {
      loginMethods: async () => ({ defaultMethod: 'wecom-qr', methods: ['wecom-qr', 'password'] })
    }
  })

  const state = await controller.initialize()
  assert.deepEqual(state.methods, ['password'])
  assert.equal(state.selectedMethod, 'password')
  assert.equal(state.status, 'password-ready')
})

test('controller retries login methods after a cold-start outage and restores both login choices', async () => {
  let attempts = 0
  const { calls, controller } = createHarness({
    client: {
      loginMethods: async () => {
        attempts += 1
        calls.push(['methods', attempts])
        if (attempts === 1) {
          throw Object.assign(new Error('offline'), { code: 'gateway-offline' })
        }
        return {
          defaultMethod: 'wecom-qr',
          enterpriseDisplayName: 'Example Corp',
          methods: ['wecom-qr', 'password'],
          weComAuthorizationOrigin: 'https://auth.example.com'
        }
      }
    }
  })

  const offline = await controller.initialize()
  assert.equal(offline.status, 'gateway-offline')
  assert.deepEqual(offline.methods, [])

  const recovered = await controller.retry()
  assert.equal(recovered.status, 'qr-pending')
  assert.deepEqual(recovered.methods, ['wecom-qr', 'password'])
  assert.equal(recovered.selectedMethod, 'wecom-qr')
  assert.equal(calls.filter(call => call[0] === 'methods').length, 2)
})

test('controller cancels a pending transaction when switching to password', async () => {
  const { calls, controller } = createHarness()
  await controller.initialize()

  const state = await controller.selectMethod('password')
  assert.equal(state.status, 'password-ready')
  assert.equal(state.selectedMethod, 'password')
  assert.equal(calls.some(call => call[0] === 'cancel' && call[1] === 'tx-secret'), true)
  assert.equal(calls.filter(call => call[0] === 'view-destroy').length >= 2, true)
})

test('controller switches to password without waiting for a pending remote cancellation', async () => {
  const neverResolves = new Promise(() => undefined)
  const { calls, controller } = createHarness({
    client: {
      cancelWeCom: id => {
        calls.push(['cancel', id])
        return neverResolves
      }
    }
  })
  await controller.initialize()

  const state = await Promise.race([
    controller.selectMethod('password'),
    new Promise(resolve => setTimeout(() => resolve({ status: 'timed-out' }), 50))
  ])
  assert.equal(state.status, 'password-ready')
  assert.equal(state.selectedMethod, 'password')
  assert.equal(calls.some(call => call[0] === 'cancel' && call[1] === 'tx-secret'), true)
})

test('terminal dispose cancels a pending transaction immediately and blocks new login work', async () => {
  const { calls, controller } = createHarness()
  await controller.initialize()

  const state = await controller.dispose()
  assert.equal(state.status, 'idle')
  assert.equal(calls.some(call => call[0] === 'cancel' && call[1] === 'tx-secret'), true)
  assert.equal((await controller.start()).status, 'idle')
  assert.equal(calls.filter(call => call[0] === 'start').length, 1)
})

test('terminal dispose covers the Gateway timeout window and revokes before resolving', async () => {
  let releaseRedeem
  let releaseLogout
  let notifyLogoutStarted
  const redeemResult = new Promise(resolve => {
    releaseRedeem = resolve
  })
  const logoutResult = new Promise(resolve => {
    releaseLogout = resolve
  })
  const logoutStarted = new Promise(resolve => {
    notifyLogoutStarted = resolve
  })
  const { calls, controller, setRemoteStatus } = createHarness({
    client: {
      logout: async token => {
        calls.push(['logout', token])
        notifyLogoutStarted()
        return logoutResult
      },
      redeemWeCom: async () => redeemResult,
      timeoutMs: 30
    }
  })
  assert.equal(controller.disposeWaitMs, 450)
  await controller.initialize()
  setRemoteStatus({ status: 'verified' })
  const poll = controller.poll()
  while (controller.getPublicState().status !== 'qr-verified') {
    await new Promise(resolve => setImmediate(resolve))
  }

  let disposeResolved = false
  const dispose = controller.dispose().then(state => {
    disposeResolved = true
    return state
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposeResolved, false)
  assert.equal(calls.some(call => call[0] === 'session'), false)

  releaseRedeem({ desktopToken: 'dsk_shutdown', user: { displayName: 'Ada' } })
  await logoutStarted
  assert.equal(disposeResolved, false)
  releaseLogout()
  const [disposed, polled] = await Promise.all([dispose, poll])
  assert.equal(disposed.status, 'idle')
  assert.equal(polled.status, 'idle')
  assert.equal(calls.some(call => call[0] === 'logout' && call[1] === 'dsk_shutdown'), true)
  assert.equal(calls.some(call => call[0] === 'session'), false)
  assert.equal(calls.some(call => call[0] === 'authenticated'), false)
})

test('terminal dispose aborts an unresponsive redeem at its final bound', async () => {
  let requestAborted = false
  const { calls, controller, setRemoteStatus } = createHarness({
    client: {
      redeemWeCom: async request =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => {
              requestAborted = true
              reject(new Error('aborted'))
            },
            { once: true }
          )
        })
    },
    options: { disposeWaitMs: 5 }
  })
  await controller.initialize()
  setRemoteStatus({ status: 'verified' })
  const poll = controller.poll()
  while (controller.getPublicState().status !== 'qr-verified') {
    await new Promise(resolve => setImmediate(resolve))
  }

  assert.equal((await controller.dispose()).status, 'idle')
  assert.equal((await poll).status, 'idle')
  assert.equal(requestAborted, true)
  assert.equal(calls.some(call => call[0] === 'cancel' && call[1] === 'tx-secret'), true)
  assert.equal(calls.some(call => call[0] === 'session'), false)
})

test('normal logout reset allows the unified login controller to authenticate again', async () => {
  const { calls, controller, setRemoteStatus } = createHarness()
  await controller.initialize()
  setRemoteStatus({ status: 'verified' })
  assert.equal((await controller.poll()).status, 'success')

  assert.equal(
    (await controller.cancel({ force: true, nextStatus: 'idle', notifyRemote: true })).status,
    'idle'
  )
  const nextLogin = await controller.initialize()
  assert.equal(nextLogin.status, 'qr-pending')
  assert.deepEqual(nextLogin.methods, ['wecom-qr', 'password'])
  assert.equal(calls.filter(call => call[0] === 'start').length, 2)
})

test('initialize waits for non-terminal cleanup before macOS-style window reopen', async () => {
  let releaseCleanup
  let destroyCount = 0
  const cleanupGate = new Promise(resolve => {
    releaseCleanup = resolve
  })
  const { calls, controller } = createHarness({
    qrView: {
      destroy: async () => {
        calls.push(['view-destroy'])
        destroyCount += 1
        if (destroyCount === 2) {
          await cleanupGate
        }
      }
    }
  })
  await controller.initialize()
  const cleanup = controller.dispose({ permanent: false })
  let reopenResolved = false
  const reopen = controller.initialize().then(state => {
    reopenResolved = true
    return state
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reopenResolved, false)

  releaseCleanup()
  assert.equal((await cleanup).status, 'idle')
  assert.equal((await reopen).status, 'qr-pending')
  assert.equal(calls.filter(call => call[0] === 'start').length, 2)
})

test('a stale poll response cannot overwrite the password state after cancellation', async () => {
  let releaseStatus
  const statusResult = new Promise(resolve => {
    releaseStatus = resolve
  })
  const { controller } = createHarness({
    client: {
      weComStatus: async () => statusResult
    }
  })
  await controller.initialize()
  const poll = controller.poll()
  const passwordState = await controller.selectMethod('password')
  assert.equal(passwordState.status, 'password-ready')

  releaseStatus({ status: 'verified' })
  assert.equal((await poll).status, 'password-ready')
  assert.equal(controller.getPublicState().selectedMethod, 'password')
})

test('controller blocks method switching and cancellation while redeem is in flight', async () => {
  let releaseRedeem
  const redeemResult = new Promise(resolve => {
    releaseRedeem = resolve
  })
  const { controller, setRemoteStatus } = createHarness({
    client: {
      redeemWeCom: async () => redeemResult
    }
  })
  await controller.initialize()
  setRemoteStatus({ status: 'verified' })
  const poll = controller.poll()
  while (controller.getPublicState().status !== 'qr-verified') {
    await new Promise(resolve => setImmediate(resolve))
  }

  assert.equal((await controller.selectMethod('password')).status, 'qr-verified')
  assert.equal((await controller.cancel()).status, 'qr-verified')
  releaseRedeem({ desktopToken: 'dsk_secret', user: { displayName: 'Ada' } })
  assert.equal((await poll).status, 'success')
})

test('post-authentication hook failure does not reverse a successful login', async () => {
  const logs = []
  const { controller, setRemoteStatus } = createHarness({
    options: {
      onAuthenticated: async () => {
        throw new Error('backend restart failed')
      },
      rememberLog: message => logs.push(message)
    }
  })
  await controller.initialize()
  setRemoteStatus({ status: 'verified' })

  const state = await controller.poll()
  assert.equal(state.status, 'success')
  assert.equal(controller.getPublicState().status, 'success')
  assert.equal(logs.some(message => message.includes('post-authentication hook failed')), true)
})

test('controller expires locally using the server absolute expiry', async () => {
  let now = Date.parse('2099-07-13T00:00:00Z')
  const { controller } = createHarness({ options: { now: () => now } })
  await controller.initialize()
  now = Date.parse('2099-07-13T00:06:00Z')

  const state = await controller.poll()
  assert.equal(state.status, 'qr-expired')
  assert.equal(state.errorCode, 'qr-expired')
  assert.equal(state.expiresAt, null)
})

test('poll outage preserves the active QR transaction and expiry for offline recovery', async () => {
  const { calls, controller } = createHarness({
    client: {
      weComStatus: async () => {
        throw Object.assign(new Error('offline'), { code: 'gateway-offline' })
      }
    }
  })
  await controller.initialize()
  const destroyCountBeforePoll = calls.filter(call => call[0] === 'view-destroy').length

  const state = await controller.poll()
  assert.equal(state.status, 'gateway-offline')
  assert.equal(state.expiresAt, '2099-07-13T00:05:00.000Z')
  assert.equal(calls.filter(call => call[0] === 'view-destroy').length, destroyCountBeforePoll)
})

test('terminal gateway failure clears expiry after destroying the QR transaction', async () => {
  const { calls, controller, setRemoteStatus } = createHarness({
    client: {
      redeemWeCom: async () => {
        throw Object.assign(new Error('offline'), { code: 'gateway-offline' })
      }
    }
  })
  await controller.initialize()
  setRemoteStatus({ status: 'verified', expiresAt: '2099-07-13T00:05:00Z' })
  const destroyCountBeforeRedeem = calls.filter(call => call[0] === 'view-destroy').length

  const state = await controller.poll()
  assert.equal(state.status, 'gateway-offline')
  assert.equal(state.expiresAt, null)
  assert.equal(calls.filter(call => call[0] === 'view-destroy').length, destroyCountBeforeRedeem + 1)
})

test('controller fails closed on unknown remote state', async () => {
  const { controller, setRemoteStatus } = createHarness()
  await controller.initialize()
  setRemoteStatus({ status: 'mystery-state' })

  const state = await controller.poll()
  assert.equal(state.status, 'qr-error')
  assert.equal(state.errorCode, 'qr-error')
})

test('authorization origin and URL validation are exact and reject injected URLs', () => {
  assert.equal(normalizeAuthorizationOrigin('https://auth.example.com'), 'https://auth.example.com')
  assert.equal(normalizeAuthorizationOrigin('https://auth.example.com:443'), 'https://auth.example.com')
  assert.equal(normalizeAuthorizationOrigin('https://user@auth.example.com'), null)
  assert.equal(normalizeAuthorizationOrigin('https://auth.example.com/path'), null)
  assert.equal(
    validateAuthorizationUrl('https://auth.example.com/wecom/login/opaque_transaction_123', 'https://auth.example.com'),
    'https://auth.example.com/wecom/login/opaque_transaction_123'
  )
  for (const invalid of [
    'https://auth.example.com.evil.test/wecom/login/opaque_transaction_123',
    'https://user@auth.example.com/wecom/login/opaque_transaction_123',
    'https://auth.example.com:444/wecom/login/opaque_transaction_123',
    'https://auth.example.com/wecom/login/opaque_transaction_123/extra',
    'https://auth.example.com/wecom/login/opaque_transaction_123?next=https://evil.test',
    'https://auth.example.com/wecom/login/opaque_transaction_123#fragment'
  ]) {
    assert.equal(validateAuthorizationUrl(invalid, 'https://auth.example.com'), null, invalid)
  }
})

test('error codes use an explicit map and do not infer from substrings', () => {
  assert.equal(stableErrorCode({ code: 'wecom-out-of-scope' }), 'out-of-scope')
  assert.equal(stableErrorCode({ code: 'wecom_user_not_in_scope' }), 'out-of-scope')
  assert.equal(stableErrorCode({ code: 'wecom_authorization_denied' }), 'qr-denied')
  assert.equal(stableErrorCode({ code: 'wecom_corp_mismatch' }), 'qr-denied')
  assert.equal(stableErrorCode({ code: 'auth_service_timeout' }), 'service-unavailable')
  assert.equal(stableErrorCode({ code: 'auth_service_unavailable' }), 'service-unavailable')
  assert.equal(stableErrorCode({ code: 'wecom_service_unavailable' }), 'service-unavailable')
  assert.equal(stableErrorCode({ code: 'some-out-of-scope-looking-error' }), 'qr-error')
  assert.equal(stableErrorCode({ code: 'gateway-timeout' }), 'gateway-offline')
})
