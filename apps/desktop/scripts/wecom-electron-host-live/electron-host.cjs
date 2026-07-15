const {
  isAllowedMainHistorySanitization,
  isAllowedMainNavigation,
  isAllowedOfficialPopup,
  isAllowedPopupNavigation,
  rendererFailureCode,
  shouldBlockRedirect
} = require('./policy.cjs')

function createElectronHost(options) {
  const {
    app, BrowserWindow, session, webContents, start, authOrigin, authPath,
    configureSession, onFinish, onObservation
  } = options
  const state = { popupCreated: false, officialOriginObserved: false, navigationPolicyPassed: true }
  const partition = `pb02-live-${start.runId}`
  const webPreferences = Object.freeze({
    contextIsolation: true,
    devTools: false,
    nodeIntegration: false,
    partition,
    sandbox: true,
    webSecurity: true
  })
  let mainWindow = null
  let popupWindow = null
  let acceptedPopupUrl = null
  let finishing = false
  let shutdownReceived = false
  let mainInitialLoadCompleted = false
  let mainHistorySanitized = false
  let mainCurrentUrl = null

  function observe() {
    onObservation?.({ ...state, mainHistorySanitized })
  }

  function navigationUrl(event, detailsOrUrl) {
    if (typeof detailsOrUrl === 'string') return detailsOrUrl
    if (typeof detailsOrUrl?.url === 'string') return detailsOrUrl.url
    return typeof event?.url === 'string' ? event.url : ''
  }

  async function finish(result, failureCode) {
    if (finishing) return
    finishing = true
    if (popupWindow && !popupWindow.isDestroyed()) popupWindow.destroy()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
    for (let attempt = 0; attempt < 50 && webContents.getAllWebContents().length > 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (webContents.getAllWebContents().length > 0) {
      result = 'FAIL'
      failureCode = 'renderer_crashed'
    }
    onFinish({
      protocolVersion: 1,
      result,
      failureCode,
      electronVersion: process.versions.electron,
      popupCreated: state.popupCreated,
      officialOriginObserved: state.officialOriginObserved,
      navigationPolicyPassed: state.navigationPolicyPassed
    })
  }

  function blockNavigation(event, code = 'navigation_blocked') {
    event?.preventDefault?.()
    state.navigationPolicyPassed = false
    observe()
    void finish('FAIL', code)
  }

  function wireNavigation(contents, allow) {
    contents.on('will-navigate', (event, value) => { if (!allow(navigationUrl(event, value))) blockNavigation(event) })
    contents.on('will-redirect', event => { if (shouldBlockRedirect()) blockNavigation(event) })
    contents.on('will-frame-navigate', (event, value) => { if (!allow(navigationUrl(event, value))) blockNavigation(event) })
    contents.on('did-navigate', (_event, url) => { if (!allow(url)) blockNavigation(null) })
    contents.on('did-navigate-in-page', (_event, url) => { if (!allow(url)) blockNavigation(null) })
    contents.on('will-attach-webview', event => blockNavigation(event))
    contents.setWindowOpenHandler(() => {
      state.navigationPolicyPassed = false
      observe()
      queueMicrotask(() => void finish('FAIL', 'popup_blocked'))
      return { action: 'deny' }
    })
  }

  function wireFailureEvents(contents, initialCode, phase) {
    contents.on('render-process-gone', () => void finish('FAIL', rendererFailureCode(phase.completed, initialCode)))
    contents.on('unresponsive', () => void finish('FAIL', rendererFailureCode(phase.completed, initialCode, true)))
    contents.on('devtools-opened', () => {
      contents.closeDevTools()
      state.navigationPolicyPassed = false
      observe()
      void finish('FAIL', 'navigation_blocked')
    })
  }

  async function startHost() {
    await app.whenReady()
    const isolatedSession = session.fromPartition(partition, { cache: true })
    isolatedSession.setPermissionCheckHandler(() => false)
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolatedSession.setDevicePermissionHandler(() => false)
    isolatedSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    isolatedSession.on('will-download', event => event.preventDefault())
    configureSession?.(isolatedSession)

    mainWindow = new BrowserWindow({
      width: 980, height: 760, show: true, title: '企业微信机器人授权验收', webPreferences
    })
    const mainPhase = { completed: false }
    wireFailureEvents(mainWindow.webContents, 'gateway_load_failed', mainPhase)
    mainWindow.on('closed', () => {
      mainWindow = null
      if (!finishing && !shutdownReceived) void finish('FAIL', 'operator_canceled')
    })
    mainWindow.webContents.on('did-fail-load', (_event, code, _description, _url, isMain) => {
      if (isMain && code !== -3) void finish('FAIL', 'gateway_load_failed')
    })
    mainWindow.webContents.once('did-finish-load', () => { mainPhase.completed = true })
    mainWindow.webContents.on('will-navigate', (event, value) => {
      if (!isAllowedMainNavigation(navigationUrl(event, value), start)) blockNavigation(event)
    })
    mainWindow.webContents.on('will-redirect', event => blockNavigation(event))
    mainWindow.webContents.on('will-frame-navigate', (event, value) => {
      if (!isAllowedMainNavigation(navigationUrl(event, value), start)) blockNavigation(event)
    })
    mainWindow.webContents.on('did-navigate', (_event, url) => {
      if (!isAllowedMainNavigation(url, start)) return blockNavigation(null)
      mainInitialLoadCompleted = true
      mainCurrentUrl = url
    })
    mainWindow.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isAllowedMainHistorySanitization(url, start, {
        isMainFrame,
        initialLoadCompleted: mainInitialLoadCompleted,
        alreadySanitized: mainHistorySanitized,
        previousUrl: mainCurrentUrl
      })) return blockNavigation(null)
      mainHistorySanitized = true
      mainCurrentUrl = url
      observe()
    })
    mainWindow.webContents.on('will-attach-webview', event => blockNavigation(event))
    mainWindow.webContents.setWindowOpenHandler(details => {
      if (acceptedPopupUrl !== null || !isAllowedOfficialPopup(details.url, start, authOrigin, authPath)) {
        state.navigationPolicyPassed = false
        observe()
        queueMicrotask(() => void finish('FAIL', 'popup_blocked'))
        return { action: 'deny' }
      }
      acceptedPopupUrl = details.url
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 720, height: 760, show: true, title: '企业微信扫码授权', webPreferences
        }
      }
    })
    mainWindow.webContents.on('did-create-window', (popup, details) => {
      if (!acceptedPopupUrl || details.url !== acceptedPopupUrl ||
          !isAllowedOfficialPopup(details.url, start, authOrigin, authPath)) {
        popup.destroy()
        return blockNavigation(null, 'popup_blocked')
      }
      popupWindow = popup
      state.popupCreated = true
      observe()
      const popupPhase = { completed: false }
      wireFailureEvents(popup.webContents, 'popup_load_failed', popupPhase)
      wireNavigation(popup.webContents, url => isAllowedPopupNavigation(url, acceptedPopupUrl, authOrigin, authPath))
      popup.webContents.on('did-fail-load', (_event, code, _description, _url, isMain) => {
        if (isMain && code !== -3) void finish('FAIL', 'popup_load_failed')
      })
      popup.webContents.once('did-finish-load', () => {
        popupPhase.completed = true
        if (!isAllowedPopupNavigation(popup.webContents.getURL(), acceptedPopupUrl, authOrigin, authPath)) {
          return blockNavigation(null)
        }
        state.officialOriginObserved = true
        observe()
      })
      popup.on('closed', () => { popupWindow = null })
    })

    try { await mainWindow.loadURL(start.authorizationUrl) }
    catch { if (!finishing) void finish('FAIL', 'gateway_load_failed') }
  }

  function shutdown() {
    if (shutdownReceived) return void finish('FAIL', 'duplicate_shutdown')
    shutdownReceived = true
    if (!state.popupCreated || !state.officialOriginObserved || !state.navigationPolicyPassed || !mainHistorySanitized) {
      return void finish('FAIL', 'popup_not_observed')
    }
    void finish('PASS', 'none')
  }

  return { fail: code => void finish('FAIL', code), shutdown, start: startHost }
}

module.exports = { createElectronHost }
