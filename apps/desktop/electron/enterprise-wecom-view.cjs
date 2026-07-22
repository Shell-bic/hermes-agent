const crypto = require('node:crypto')

const OFFICIAL_WE_COM_PATHS = new Map([['open.work.weixin.qq.com:443', [{ prefix: '/wwopen/' }]]])
const WE_COM_PAGE_ZOOM_FACTOR = 0.9
const WE_COM_FIT_CSS = `
  html, body {
    width: 100% !important;
    height: 100% !important;
    overflow: hidden !important;
  }
  body.login_page_standalone {
    box-sizing: border-box !important;
    padding: 8px 0 0 !important;
    background: #fff !important;
  }
  .wrp_code_iframe {
    margin-top: 8px !important;
  }
  .impowerBox .qrcode {
    min-height: 0 !important;
  }
`

function parseSecureUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl || ''))
  } catch {
    throw new Error('Enterprise WeCom authorization URL is invalid.')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Enterprise WeCom authorization URL must use HTTPS.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Enterprise WeCom authorization URL must not contain userinfo.')
  }
  return parsed
}

function isAllowedWeComNavigation(rawUrl, allowedPaths) {
  try {
    const parsed = parseSecureUrl(rawUrl)
    const authority = `${parsed.hostname.toLowerCase()}:${parsed.port || '443'}`
    const rules = allowedPaths.get(authority) || []
    return rules.some(rule =>
      Object.prototype.hasOwnProperty.call(rule, 'exact')
        ? parsed.pathname === rule.exact
        : parsed.pathname.startsWith(rule.prefix)
    )
  } catch {
    return false
  }
}

function safeNavigationTarget(rawUrl) {
  try {
    const parsed = parseSecureUrl(rawUrl)
    const pathname = /^\/wecom\/login\/[^/]+$/.test(parsed.pathname)
      ? '/wecom/login/[redacted]'
      : parsed.pathname
    return `${parsed.origin}${pathname}`
  } catch {
    return 'invalid-url'
  }
}

function safeErrorLabel(error) {
  const value = String(error?.code || error?.errno || error?.name || 'unknown')
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'unknown'
}

function normalizeQrBounds(bounds, contentBounds = {}) {
  if (!bounds || bounds.visible === false) {
    return { height: 0, width: 0, x: 0, y: 0, visible: false }
  }

  const maxWidth = Math.max(0, Math.floor(Number(contentBounds.width) || 0))
  const maxHeight = Math.max(0, Math.floor(Number(contentBounds.height) || 0))
  const x = Math.max(0, Math.min(maxWidth, Math.floor(Number(bounds.x) || 0)))
  const y = Math.max(0, Math.min(maxHeight, Math.floor(Number(bounds.y) || 0)))
  const width = Math.max(0, Math.min(maxWidth - x, Math.floor(Number(bounds.width) || 0)))
  const height = Math.max(0, Math.min(maxHeight - y, Math.floor(Number(bounds.height) || 0)))

  return { height, width, x, y, visible: width > 0 && height > 0 }
}

class EnterpriseWeComView {
  constructor({ WebContentsView, getHostWindow, randomUUID = crypto.randomUUID, rememberLog = () => {} } = {}) {
    this.WebContentsView = WebContentsView
    this.getHostWindow = getHostWindow
    this.randomUUID = randomUUID
    this.rememberLog = rememberLog
    this.view = null
    this.partition = null
    this.allowedPaths = new Map(OFFICIAL_WE_COM_PATHS)
    this.lastBounds = null
    this.downloadHandler = null
  }

  async open(rawUrl, { authorizationOrigin } = {}) {
    const parsed = parseSecureUrl(rawUrl)
    const expectedOrigin = parseSecureUrl(`${String(authorizationOrigin || '').replace(/\/$/, '')}/`)
    if (
      parsed.username ||
      parsed.password ||
      expectedOrigin.username ||
      expectedOrigin.password ||
      parsed.origin !== expectedOrigin.origin ||
      !/^\/wecom\/login\/[A-Za-z0-9_-]{16,128}$/.test(parsed.pathname) ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('Enterprise WeCom authorization URL does not match the configured origin and path.')
    }
    await this.destroy()

    const hostWindow = this.getHostWindow?.()
    if (!hostWindow || hostWindow.isDestroyed?.() || !hostWindow.contentView) {
      throw new Error('Enterprise WeCom login window is unavailable.')
    }
    if (typeof this.WebContentsView !== 'function') {
      throw new Error('Enterprise WeCom WebContentsView is unavailable.')
    }

    this.allowedPaths = new Map(OFFICIAL_WE_COM_PATHS)
    const authHost = `${parsed.hostname.toLowerCase()}:${parsed.port || '443'}`
    this.allowedPaths.set(authHost, [{ exact: parsed.pathname }, { exact: '/wecom/callback' }])
    this.partition = `hermes-wecom-${this.randomUUID()}`
    const view = new this.WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: this.partition,
        sandbox: true,
        webSecurity: true
      }
    })
    this.view = view
    view.webContents.setZoomFactor?.(WE_COM_PAGE_ZOOM_FACTOR)

    const denyNavigation = (event, url) => {
      if (!isAllowedWeComNavigation(url, this.allowedPaths)) {
        event.preventDefault()
        this.rememberLog('[enterprise-wecom] blocked QR view navigation')
      }
    }
    const denyFrameNavigation = details => {
      if (!isAllowedWeComNavigation(details?.url, this.allowedPaths)) {
        details?.preventDefault?.()
        this.rememberLog('[enterprise-wecom] blocked QR view frame navigation')
      }
    }
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', denyNavigation)
    view.webContents.on('will-redirect', denyNavigation)
    // Electron 40 emits one Event<WebContentsWillFrameNavigateEventParams>
    // details object here, unlike the legacy (event, url) navigation events.
    view.webContents.on('will-frame-navigate', denyFrameNavigation)
    view.webContents.on('did-finish-load', async () => {
      try {
        const current = parseSecureUrl(view.webContents.getURL())
        if (current.hostname.toLowerCase() !== 'open.work.weixin.qq.com' || !current.pathname.startsWith('/wwopen/')) {
          return
        }
        // Chromium keeps zoom per origin, so the auth -> official qrConnect redirect
        // must reapply it after the official document has finished loading.
        view.webContents.setZoomFactor?.(WE_COM_PAGE_ZOOM_FACTOR)
        await view.webContents.insertCSS?.(WE_COM_FIT_CSS)
      } catch {
        this.rememberLog('[enterprise-wecom] failed to fit official QR page')
      }
    })

    const isolatedSession = view.webContents.session
    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    isolatedSession.setPermissionCheckHandler(() => false)
    this.downloadHandler = event => event.preventDefault()
    isolatedSession.on('will-download', this.downloadHandler)

    hostWindow.contentView.addChildView(view)
    if (this.lastBounds) {
      this.setBounds(this.lastBounds)
    }

    try {
      await view.webContents.loadURL(parsed.toString())
    } catch (error) {
      this.rememberLog(
        `[enterprise-wecom] QR view load failed stage=load-url code=${safeErrorLabel(error)} target=${safeNavigationTarget(parsed)}`
      )
      await this.destroy()
      throw error
    }
  }

  setBounds(bounds) {
    this.lastBounds = bounds || null
    const view = this.view
    const hostWindow = this.getHostWindow?.()
    if (!view || !hostWindow || hostWindow.isDestroyed?.()) {
      return
    }

    const hostZoom = Number(hostWindow.webContents?.getZoomFactor?.())
    const scale = Number.isFinite(hostZoom) && hostZoom > 0 ? hostZoom : 1
    const scaledBounds = bounds
      ? {
          height: Number(bounds.height) * scale,
          visible: bounds.visible,
          width: Number(bounds.width) * scale,
          x: Number(bounds.x) * scale,
          y: Number(bounds.y) * scale
        }
      : bounds
    const normalized = normalizeQrBounds(scaledBounds, hostWindow.getContentBounds?.() || {})
    view.setBounds({ height: normalized.height, width: normalized.width, x: normalized.x, y: normalized.y })
    view.setVisible?.(normalized.visible)
  }

  async destroy() {
    const view = this.view
    this.view = null
    if (!view) {
      return
    }

    const hostWindow = this.getHostWindow?.()
    try {
      hostWindow?.contentView?.removeChildView(view)
    } catch {
      // Window teardown can remove child views first.
    }

    const isolatedSession = view.webContents?.session
    if (isolatedSession && this.downloadHandler) {
      isolatedSession.removeListener?.('will-download', this.downloadHandler)
    }
    this.downloadHandler = null

    try {
      if (!view.webContents?.isDestroyed?.()) {
        view.webContents.close()
      }
    } catch {
      // The app or renderer may already be closing.
    }

    try {
      await isolatedSession?.clearStorageData?.()
      await isolatedSession?.clearCache?.()
    } catch {
      // The partition is ephemeral and disappears with the WebContents.
    }
    this.partition = null
  }
}

function createEnterpriseWeComView(options) {
  return new EnterpriseWeComView(options)
}

module.exports = {
  EnterpriseWeComView,
  OFFICIAL_WE_COM_PATHS,
  WE_COM_FIT_CSS,
  WE_COM_PAGE_ZOOM_FACTOR,
  createEnterpriseWeComView,
  isAllowedWeComNavigation,
  normalizeQrBounds,
  parseSecureUrl,
  safeErrorLabel,
  safeNavigationTarget
}
