const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createEnterpriseWeComView,
  isAllowedWeComNavigation,
  normalizeQrBounds,
  parseSecureUrl,
  safeNavigationTarget,
  WE_COM_FIT_CSS,
  WE_COM_PAGE_ZOOM_FACTOR
} = require('./enterprise-wecom-view.cjs')

function createHarness() {
  const calls = []
  const logs = []
  const listeners = new Map()
  const registeredEvents = []
  let currentUrl = 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect'
  const isolatedSession = {
    clearCache: async () => calls.push(['clear-cache']),
    clearStorageData: async () => calls.push(['clear-storage']),
    on: (name, handler) => listeners.set(`session:${name}`, handler),
    removeListener: (name, handler) => {
      if (listeners.get(`session:${name}`) === handler) listeners.delete(`session:${name}`)
    },
    setPermissionCheckHandler: handler => listeners.set('permission-check', handler),
    setPermissionRequestHandler: handler => listeners.set('permission-request', handler)
  }
  class FakeWebContentsView {
    constructor(options) {
      calls.push(['construct', options])
      this.webContents = {
        close: () => calls.push(['close']),
        getURL: () => currentUrl,
        insertCSS: async css => calls.push(['insert-css', css]),
        isDestroyed: () => false,
        loadURL: async url => calls.push(['load', url]),
        on: (name, handler) => {
          registeredEvents.push(name)
          listeners.set(name, handler)
        },
        session: isolatedSession,
        setZoomFactor: factor => calls.push(['zoom', factor]),
        setWindowOpenHandler: handler => listeners.set('window-open', handler)
      }
    }

    setBounds(bounds) {
      calls.push(['bounds', bounds])
    }

    setVisible(visible) {
      calls.push(['visible', visible])
    }
  }
  const hostWindow = {
    contentView: {
      addChildView: view => calls.push(['add', view]),
      removeChildView: view => calls.push(['remove', view])
    },
    getContentBounds: () => ({ height: 600, width: 800 }),
    webContents: { getZoomFactor: () => 1.25 },
    isDestroyed: () => false
  }
  const view = createEnterpriseWeComView({
    WebContentsView: FakeWebContentsView,
    getHostWindow: () => hostWindow,
    randomUUID: () => 'partition-id',
    rememberLog: line => logs.push(line)
  })
  return { calls, listeners, logs, registeredEvents, setCurrentUrl: url => (currentUrl = url), view }
}

test('QR view uses an ephemeral sandbox and denies windows downloads and permissions', async () => {
  const { calls, listeners, view } = createHarness()
  await view.open('https://auth.example.com/wecom/login/opaque_transaction_123', {
    authorizationOrigin: 'https://auth.example.com'
  })

  const options = calls.find(call => call[0] === 'construct')[1]
  assert.deepEqual(options.webPreferences, {
    contextIsolation: true,
    nodeIntegration: false,
    partition: 'hermes-wecom-partition-id',
    sandbox: true,
    webSecurity: true
  })
  assert.equal(options.webPreferences.partition.startsWith('persist:'), false)
  assert.deepEqual(calls.find(call => call[0] === 'zoom'), ['zoom', WE_COM_PAGE_ZOOM_FACTOR])
  assert.deepEqual(listeners.get('window-open')({ url: 'https://evil.test' }), { action: 'deny' })
  assert.equal(listeners.get('permission-check')(), false)
  let permissionResult = true
  listeners.get('permission-request')(null, 'camera', value => {
    permissionResult = value
  })
  assert.equal(permissionResult, false)
  let downloadBlocked = false
  listeners.get('session:will-download')({ preventDefault: () => (downloadBlocked = true) })
  assert.equal(downloadBlocked, true)

  await listeners.get('did-finish-load')()
  assert.equal(calls.filter(call => call[0] === 'zoom').length, 2)
  assert.deepEqual(calls.find(call => call[0] === 'insert-css'), ['insert-css', WE_COM_FIT_CSS])
})

test('QR fit CSS is applied only to the official WeCom document', async () => {
  const { calls, listeners, setCurrentUrl, view } = createHarness()
  await view.open('https://auth.example.com/wecom/login/opaque_transaction_123', {
    authorizationOrigin: 'https://auth.example.com'
  })
  setCurrentUrl('https://auth.example.com/wecom/callback?code=one&state=two')
  await listeners.get('did-finish-load')()
  assert.equal(calls.some(call => call[0] === 'insert-css'), false)
})

test('QR navigation allowlist is exact for auth paths and constrained for official WeCom paths', async () => {
  const { listeners, registeredEvents, view } = createHarness()
  await view.open('https://auth.example.com/wecom/login/opaque_transaction_123', {
    authorizationOrigin: 'https://auth.example.com'
  })
  const navigate = listeners.get('will-navigate')
  const redirect = listeners.get('will-redirect')
  assert.equal(registeredEvents.includes('will-redirect'), true)
  assert.equal(registeredEvents.includes('will-redirect-navigation'), false)
  assert.equal(typeof redirect, 'function')
  assert.equal(typeof listeners.get('will-frame-navigate'), 'function')
  const check = (url, expectedBlocked) => {
    let blocked = false
    navigate({ preventDefault: () => (blocked = true) }, url)
    assert.equal(blocked, expectedBlocked, url)
  }

  check('https://auth.example.com/wecom/login/opaque_transaction_123', false)
  check('https://auth.example.com/wecom/callback?code=one&state=two', false)
  check('https://open.work.weixin.qq.com/wwopen/sso/qrConnect', false)
  check('https://auth.example.com/wecom/callback.evil', true)
  check('https://auth.example.com/wecom/login/opaque_transaction_123-extra', true)
  check('https://auth.example.com.evil.test/wecom/login/opaque_transaction_123', true)
  check('https://auth.example.com:444/wecom/login/opaque_transaction_123', true)
  check('https://open.work.weixin.qq.com.evil.test/wwopen/sso/qrConnect', true)
  check('https://open.work.weixin.qq.com:444/wwopen/sso/qrConnect', true)
  check('http://open.work.weixin.qq.com/wwopen/sso/qrConnect', true)

  let redirectBlocked = false
  redirect({ preventDefault: () => (redirectBlocked = true) }, 'https://evil.test/escaped-by-302')
  assert.equal(redirectBlocked, true)

  const frameNavigate = listeners.get('will-frame-navigate')
  let allowedFrameBlocked = false
  frameNavigate({
    isMainFrame: true,
    preventDefault: () => (allowedFrameBlocked = true),
    url: 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=secret'
  })
  assert.equal(allowedFrameBlocked, false)

  let unsafeFrameBlocked = false
  frameNavigate({
    isMainFrame: false,
    preventDefault: () => (unsafeFrameBlocked = true),
    url: 'https://evil.test/frame'
  })
  assert.equal(unsafeFrameBlocked, true)
})

test('QR load failures log only a sanitized target and stable error label', async () => {
  const { logs, view } = createHarness()
  const transaction = 'opaque_transaction_secret_123'
  const OriginalView = view.WebContentsView
  view.WebContentsView = class extends OriginalView {
    constructor(options) {
      super(options)
      this.webContents.loadURL = async () => {
        throw Object.assign(new Error(`failed at https://auth.example.com/wecom/login/${transaction}?state=oauth-secret`), {
          code: 'ERR_FAILED'
        })
      }
    }
  }

  await assert.rejects(
    () => view.open(`https://auth.example.com/wecom/login/${transaction}`, {
      authorizationOrigin: 'https://auth.example.com'
    }),
    /failed at/
  )
  assert.equal(logs.length, 1)
  assert.equal(
    logs[0],
    '[enterprise-wecom] QR view load failed stage=load-url code=ERR_FAILED target=https://auth.example.com/wecom/login/[redacted]'
  )
  assert.equal(logs[0].includes(transaction), false)
  assert.equal(logs[0].includes('oauth-secret'), false)
})

test('QR view rejects userinfo query fragment and origin mismatch before construction', async () => {
  for (const url of [
    'https://user@auth.example.com/wecom/login/opaque_transaction_123',
    'https://auth.example.com/wecom/login/opaque_transaction_123?next=x',
    'https://auth.example.com/wecom/login/opaque_transaction_123#x',
    'https://evil.test/wecom/login/opaque_transaction_123'
  ]) {
    const { calls, view } = createHarness()
    await assert.rejects(
      () => view.open(url, { authorizationOrigin: 'https://auth.example.com' }),
      /userinfo|configured origin and path/
    )
    assert.equal(calls.some(call => call[0] === 'construct'), false)
  }
  assert.throws(() => parseSecureUrl('https://user@auth.example.com/path'), /userinfo/)
})

test('QR view clamps bounds and destroys the child view and isolated storage', async () => {
  const { calls, view } = createHarness()
  await view.open('https://auth.example.com/wecom/login/opaque_transaction_123', {
    authorizationOrigin: 'https://auth.example.com'
  })
  view.setBounds({ height: 400, visible: true, width: 400, x: 500, y: 300 })
  assert.deepEqual(calls.find(call => call[0] === 'bounds')[1], { height: 225, width: 175, x: 625, y: 375 })

  await view.destroy()
  assert.equal(calls.some(call => call[0] === 'remove'), true)
  assert.equal(calls.some(call => call[0] === 'close'), true)
  assert.equal(calls.some(call => call[0] === 'clear-storage'), true)
  assert.deepEqual(normalizeQrBounds({ visible: false }, { height: 600, width: 800 }), {
    height: 0,
    visible: false,
    width: 0,
    x: 0,
    y: 0
  })
})

test('navigation helper rejects unknown schemes and exact-path lookalikes', () => {
  const rules = new Map([
    ['auth.example.com:443', [{ exact: '/wecom/callback' }]],
    ['open.work.weixin.qq.com:443', [{ prefix: '/wwopen/' }]]
  ])
  assert.equal(isAllowedWeComNavigation('https://auth.example.com/wecom/callback', rules), true)
  assert.equal(isAllowedWeComNavigation('https://auth.example.com/wecom/callback.evil', rules), false)
  assert.equal(isAllowedWeComNavigation('javascript:alert(1)', rules), false)
  assert.equal(
    safeNavigationTarget('https://auth.example.com/wecom/login/opaque_transaction_secret?state=oauth-secret'),
    'https://auth.example.com/wecom/login/[redacted]'
  )
})
