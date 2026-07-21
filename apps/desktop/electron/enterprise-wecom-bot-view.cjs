const crypto = require('node:crypto')

const OFFICIAL_BOT_AUTH_ORIGIN = 'https://work.weixin.qq.com'
const OFFICIAL_BOT_AUTH_PATH = '/ai/qc/gen'

function parseSecureUrl(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw new Error('Enterprise WeCom Bot authorization URL is invalid.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Enterprise WeCom Bot authorization URL must be credential-free HTTPS.')
  }
  return url
}

function expectedState(authorizationUrl) {
  const state = parseSecureUrl(authorizationUrl).searchParams.get('state') || ''
  return /^[A-Za-z0-9_-]{16,256}$/.test(state) ? state : ''
}

function isExpectedOfficialPopup(candidate, state) {
  try {
    const url = parseSecureUrl(candidate)
    const keys = [...url.searchParams.keys()]
    return url.origin === OFFICIAL_BOT_AUTH_ORIGIN &&
      url.pathname === OFFICIAL_BOT_AUTH_PATH &&
      keys.length === 3 && new Set(keys).size === 3 &&
      ['source', 'state', 'timestamp'].every(key => keys.includes(key)) &&
      url.searchParams.getAll('source').length === 1 && /^[A-Za-z0-9._-]{1,128}$/.test(url.searchParams.get('source') || '') &&
      url.searchParams.getAll('state').length === 1 && url.searchParams.get('state') === state &&
      url.searchParams.getAll('timestamp').length === 1 && /^\d{10,16}$/.test(url.searchParams.get('timestamp') || '')
  } catch {
    return false
  }
}

function isExactNavigation(candidate, expected) {
  try {
    return parseSecureUrl(candidate).href === parseSecureUrl(expected).href
  } catch {
    return false
  }
}

class EnterpriseWeComBotView {
  constructor({ BrowserWindow, randomUUID = crypto.randomUUID, rememberLog = () => {} } = {}) {
    this.BrowserWindow = BrowserWindow
    this.randomUUID = randomUUID
    this.rememberLog = rememberLog
    this.window = null
    this.popup = null
    this.partition = null
    this.downloadHandler = null
  }

  async open(authorizationUrl) {
    const initial = parseSecureUrl(authorizationUrl)
    const state = expectedState(initial.href)
    if (!state) throw new Error('Enterprise WeCom Bot authorization state is missing or invalid.')
    await this.destroy()
    if (typeof this.BrowserWindow !== 'function') throw new Error('Enterprise WeCom Bot window is unavailable.')

    this.partition = `hermes-wecom-bot-${this.randomUUID()}`
    const webPreferences = {
      contextIsolation: true,
      devTools: false,
      nodeIntegration: false,
      partition: this.partition,
      sandbox: true,
      webSecurity: true
    }
    const win = new this.BrowserWindow({
      height: 760,
      show: true,
      title: '绑定企业微信智能机器人',
      webPreferences,
      width: 980
    })
    this.window = win
    let acceptedPopupUrl = null
    let initialLoaded = false
    let queryScrubbed = false
    const queryFree = `${initial.origin}${initial.pathname}`
    const allowParent = (url, inPage = false) => {
      if (isExactNavigation(url, initial.href)) return true
      if (inPage && initialLoaded && !queryScrubbed && isExactNavigation(url, queryFree)) {
        queryScrubbed = true
        return true
      }
      return false
    }
    const deny = event => {
      event?.preventDefault?.()
      this.rememberLog('[enterprise-wecom-bot] blocked authorization navigation')
    }

    win.webContents.on('will-navigate', (event, url) => { if (!allowParent(url)) deny(event) })
    win.webContents.on('will-redirect', deny)
    win.webContents.on('will-frame-navigate', (event, details) => {
      const url = typeof details === 'string' ? details : details?.url
      if (!allowParent(url)) deny(event)
    })
    win.webContents.on('did-navigate', (_event, url) => {
      if (!allowParent(url)) return win.destroy()
      initialLoaded = true
    })
    win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame || !allowParent(url, true)) win.destroy()
    })
    win.webContents.on('will-attach-webview', deny)
    win.webContents.setWindowOpenHandler(details => {
      if (acceptedPopupUrl || !isExpectedOfficialPopup(details.url, state)) {
        this.rememberLog('[enterprise-wecom-bot] blocked unexpected popup')
        return { action: 'deny' }
      }
      acceptedPopupUrl = details.url
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          height: 760,
          show: true,
          title: '企业微信扫码授权',
          webPreferences,
          width: 720
        }
      }
    })
    win.webContents.on('did-create-window', (popup, details) => {
      if (!acceptedPopupUrl || details.url !== acceptedPopupUrl || !isExpectedOfficialPopup(details.url, state)) {
        popup.destroy()
        return
      }
      this.popup = popup
      const allowPopup = url => isExactNavigation(url, acceptedPopupUrl)
      popup.webContents.on('will-navigate', (event, url) => { if (!allowPopup(url)) deny(event) })
      popup.webContents.on('will-redirect', deny)
      popup.webContents.on('will-frame-navigate', (event, details) => {
        const url = typeof details === 'string' ? details : details?.url
        if (!allowPopup(url)) deny(event)
      })
      popup.webContents.on('will-attach-webview', deny)
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      popup.on('closed', () => { if (this.popup === popup) this.popup = null })
    })

    const isolatedSession = win.webContents.session
    isolatedSession.setPermissionCheckHandler(() => false)
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolatedSession.setDevicePermissionHandler?.(() => false)
    isolatedSession.setDisplayMediaRequestHandler?.((_request, callback) => callback({}))
    this.downloadHandler = event => event.preventDefault()
    isolatedSession.on('will-download', this.downloadHandler)
    win.on('closed', () => { if (this.window === win) this.window = null })

    try {
      await win.loadURL(initial.href)
    } catch (error) {
      await this.destroy()
      throw error
    }
  }

  focus() {
    this.window?.show?.()
    this.window?.focus?.()
  }

  async destroy() {
    const win = this.window
    const popup = this.popup
    this.window = null
    this.popup = null
    const isolatedSession = win?.webContents?.session
    if (isolatedSession && this.downloadHandler) isolatedSession.removeListener?.('will-download', this.downloadHandler)
    this.downloadHandler = null
    try { if (popup && !popup.isDestroyed()) popup.destroy() } catch { /* teardown is best-effort */ }
    try { if (win && !win.isDestroyed()) win.destroy() } catch { /* teardown is best-effort */ }
    try {
      await isolatedSession?.clearStorageData?.()
      await isolatedSession?.clearCache?.()
    } catch { /* ephemeral partition cleanup is best-effort */ }
    this.partition = null
  }
}

function createEnterpriseWeComBotView(options) {
  return new EnterpriseWeComBotView(options)
}

module.exports = {
  EnterpriseWeComBotView,
  OFFICIAL_BOT_AUTH_ORIGIN,
  OFFICIAL_BOT_AUTH_PATH,
  createEnterpriseWeComBotView,
  expectedState,
  isExactNavigation,
  isExpectedOfficialPopup,
  parseSecureUrl
}
