const { contextBridge, ipcRenderer, webUtils } = require('electron')
const { isEnterpriseManagedEnv, redactManagedText } = require('./managed-redaction.cjs')
const { createManagedProfileInvoker } = require('./enterprise-managed-profile.cjs')
const { WINDOW_CONNECTION_CHANNELS } = require('./enterprise-window-connections.cjs')

const ENTERPRISE_MANAGED_OUTPUTS = isEnterpriseManagedEnv(process.env)

function unwrapEnterpriseSkillHub(result) {
  if (result?.ok) return result.value
  const error = new Error(result?.error?.message || 'Enterprise Skill Hub request failed.')
  error.code = result?.error?.code || 'enterprise_skill_hub_error'
  error.status = result?.error?.status || null
  throw error
}

const invokeManagedProfile = createManagedProfileInvoker(ipcRenderer)

contextBridge.exposeInMainWorld('hermesDesktop', {
  getConnection: profile => invokeManagedProfile('hermes:connection', profile),
  revalidateConnection: () => ipcRenderer.invoke('hermes:connection:revalidate'),
  touchBackend: profile => invokeManagedProfile('hermes:backend:touch', profile),
  getGatewayWsUrl: profile => invokeManagedProfile('hermes:gateway:ws-url', profile),
  openSessionWindow: (sessionId, opts) => ipcRenderer.invoke('hermes:window:openSession', sessionId, opts),
  openNewSessionWindow: () => ipcRenderer.invoke('hermes:window:openNewSession'),
  getBootProgress: () => ipcRenderer.invoke('hermes:boot-progress:get'),
  getConnectionConfig: profile => invokeManagedProfile('hermes:connection-config:get', profile),
  saveConnectionConfig: payload => invokeManagedProfile('hermes:connection-config:save', payload),
  applyConnectionConfig: payload => invokeManagedProfile('hermes:connection-config:apply', payload),
  testConnectionConfig: payload => invokeManagedProfile('hermes:connection-config:test', payload),
  probeConnectionConfig: remoteUrl => invokeManagedProfile('hermes:connection-config:probe', remoteUrl),
  oauthLoginConnectionConfig: remoteUrl => invokeManagedProfile('hermes:connection-config:oauth-login', remoteUrl),
  oauthLogoutConnectionConfig: remoteUrl => invokeManagedProfile('hermes:connection-config:oauth-logout', remoteUrl),
  enterprise: {
    managed: ENTERPRISE_MANAGED_OUTPUTS,
    cancelWeCom: () => ipcRenderer.invoke('hermes:enterprise:wecom-cancel'),
    login: payload => ipcRenderer.invoke('hermes:enterprise:login', payload),
    loginMethods: () => ipcRenderer.invoke('hermes:enterprise:login-methods'),
    loginState: () => ipcRenderer.invoke('hermes:enterprise:login-state'),
    lifecycleStatus: () => ipcRenderer.invoke('hermes:enterprise:lifecycle-status'),
    logout: () => ipcRenderer.invoke('hermes:enterprise:logout'),
    onLoginState: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('hermes:enterprise:login-state', listener)
      return () => ipcRenderer.removeListener('hermes:enterprise:login-state', listener)
    },
    refresh: () => ipcRenderer.invoke('hermes:enterprise:refresh'),
    refreshWeCom: () => ipcRenderer.invoke('hermes:enterprise:wecom-refresh'),
    selectLoginMethod: method => ipcRenderer.invoke('hermes:enterprise:login-method-select', method),
    refreshPolicy: () => ipcRenderer.invoke('hermes:enterprise:refreshPolicy'),
    selectModel: model => ipcRenderer.invoke('hermes:enterprise:selectModel', model),
    skillHub: {
      detail: key => ipcRenderer.invoke('hermes:enterprise:skill-hub:detail', key).then(unwrapEnterpriseSkillHub),
      install: payload =>
        ipcRenderer.invoke('hermes:enterprise:skill-hub:install', payload).then(unwrapEnterpriseSkillHub),
      list: query => ipcRenderer.invoke('hermes:enterprise:skill-hub:list', query).then(unwrapEnterpriseSkillHub)
    },
    setWeComBounds: bounds => ipcRenderer.invoke('hermes:enterprise:wecom-bounds', bounds),
    status: () => ipcRenderer.invoke('hermes:enterprise:status')
  },
  redactSensitiveText: value => redactManagedText(value, ENTERPRISE_MANAGED_OUTPUTS),
  profile: {
    get: () => ipcRenderer.invoke('hermes:profile:get'),
    set: name => invokeManagedProfile('hermes:profile:set', name)
  },
  api: request => invokeManagedProfile('hermes:api', request),
  notify: payload => ipcRenderer.invoke('hermes:notify', payload),
  requestMicrophoneAccess: () => ipcRenderer.invoke('hermes:requestMicrophoneAccess'),
  readFileDataUrl: filePath => ipcRenderer.invoke('hermes:readFileDataUrl', filePath),
  readFileText: filePath => ipcRenderer.invoke('hermes:readFileText', filePath),
  selectPaths: options => ipcRenderer.invoke('hermes:selectPaths', options),
  writeClipboard: text => ipcRenderer.invoke('hermes:writeClipboard', text),
  saveImageFromUrl: url => ipcRenderer.invoke('hermes:saveImageFromUrl', url),
  saveImageBuffer: (data, ext) => ipcRenderer.invoke('hermes:saveImageBuffer', { data, ext }),
  saveClipboardImage: () => ipcRenderer.invoke('hermes:saveClipboardImage'),
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  normalizePreviewTarget: (target, baseDir) => ipcRenderer.invoke('hermes:normalizePreviewTarget', target, baseDir),
  watchPreviewFile: url => ipcRenderer.invoke('hermes:watchPreviewFile', url),
  stopPreviewFileWatch: id => ipcRenderer.invoke('hermes:stopPreviewFileWatch', id),
  setTitleBarTheme: payload => ipcRenderer.send('hermes:titlebar-theme', payload),
  setNativeTheme: mode => ipcRenderer.send('hermes:native-theme', mode),
  setTranslucency: payload => ipcRenderer.send('hermes:translucency', payload),
  setPreviewShortcutActive: active => ipcRenderer.send('hermes:previewShortcutActive', Boolean(active)),
  openExternal: url => ipcRenderer.invoke('hermes:openExternal', url),
  fetchLinkTitle: url => ipcRenderer.invoke('hermes:fetchLinkTitle', url),
  sanitizeWorkspaceCwd: cwd => ipcRenderer.invoke('hermes:workspace:sanitize', cwd),
  settings: {
    getDefaultProjectDir: () => ipcRenderer.invoke('hermes:setting:defaultProjectDir:get'),
    setDefaultProjectDir: dir => ipcRenderer.invoke('hermes:setting:defaultProjectDir:set', dir),
    pickDefaultProjectDir: () => ipcRenderer.invoke('hermes:setting:defaultProjectDir:pick')
  },
  revealLogs: () => ipcRenderer.invoke('hermes:logs:reveal'),
  getRecentLogs: () => ipcRenderer.invoke('hermes:logs:recent'),
  readDir: dirPath => ipcRenderer.invoke('hermes:fs:readDir', dirPath),
  gitRoot: startPath => ipcRenderer.invoke('hermes:fs:gitRoot', startPath),
  worktrees: cwds => ipcRenderer.invoke('hermes:fs:worktrees', cwds),
  terminal: {
    dispose: id => ipcRenderer.invoke('hermes:terminal:dispose', id),
    resize: (id, size) => ipcRenderer.invoke('hermes:terminal:resize', id, size),
    start: options => ipcRenderer.invoke('hermes:terminal:start', options),
    write: (id, data) => ipcRenderer.invoke('hermes:terminal:write', id, data),
    onData: (id, callback) => {
      const channel = `hermes:terminal:${id}:data`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, callback) => {
      const channel = `hermes:terminal:${id}:exit`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  onClosePreviewRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:close-preview-requested', listener)
    return () => ipcRenderer.removeListener('hermes:close-preview-requested', listener)
  },
  onOpenUpdatesRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-updates', listener)
    return () => ipcRenderer.removeListener('hermes:open-updates', listener)
  },
  onDeepLink: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:deep-link', listener)
    return () => ipcRenderer.removeListener('hermes:deep-link', listener)
  },
  signalDeepLinkReady: () => ipcRenderer.invoke('hermes:deep-link-ready'),
  onWindowStateChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:window-state-changed', listener)
    return () => ipcRenderer.removeListener('hermes:window-state-changed', listener)
  },
  onFocusSession: callback => {
    const listener = (_event, sessionId) => callback(sessionId)
    ipcRenderer.on('hermes:focus-session', listener)
    return () => ipcRenderer.removeListener('hermes:focus-session', listener)
  },
  onNotificationAction: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:notification-action', listener)
    return () => ipcRenderer.removeListener('hermes:notification-action', listener)
  },
  onPreviewFileChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:preview-file-changed', listener)
    return () => ipcRenderer.removeListener('hermes:preview-file-changed', listener)
  },
  onBackendExit: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:backend-exit', listener)
    return () => ipcRenderer.removeListener('hermes:backend-exit', listener)
  },
  onEnterpriseRuntimeRevoked: callback => {
    const listener = async (_event, payload) => {
      let ok = true
      try {
        await callback(payload)
      } catch {
        ok = false
      }
      ipcRenderer.send(WINDOW_CONNECTION_CHANNELS.ACK, {
        ok,
        revocationId: payload?.revocationId
      })
    }
    ipcRenderer.on(WINDOW_CONNECTION_CHANNELS.REVOKE, listener)
    ipcRenderer.send(WINDOW_CONNECTION_CHANNELS.READY)
    return () => {
      ipcRenderer.removeListener(WINDOW_CONNECTION_CHANNELS.REVOKE, listener)
      ipcRenderer.send(WINDOW_CONNECTION_CHANNELS.NOT_READY)
    }
  },
  onPowerResume: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:power-resume', listener)
    return () => ipcRenderer.removeListener('hermes:power-resume', listener)
  },
  onBootProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:boot-progress', listener)
    return () => ipcRenderer.removeListener('hermes:boot-progress', listener)
  },
  // First-launch bootstrap progress -- emitted by the install.ps1 stage
  // runner in main.cjs (apps/desktop/electron/bootstrap-runner.cjs).
  // Renderer's install overlay subscribes to live events and queries the
  // current snapshot via getBootstrapState() to recover after a devtools
  // reload mid-bootstrap.
  getBootstrapState: () => ipcRenderer.invoke('hermes:bootstrap:get'),
  resetBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:reset'),
  repairBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:repair'),
  cancelBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:cancel'),
  onBootstrapEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:bootstrap:event', listener)
    return () => ipcRenderer.removeListener('hermes:bootstrap:event', listener)
  },
  getVersion: () => ipcRenderer.invoke('hermes:version'),
  uninstall: {
    summary: () => ipcRenderer.invoke('hermes:uninstall:summary'),
    run: mode => ipcRenderer.invoke('hermes:uninstall:run', { mode })
  },
  updates: {
    check: () => ipcRenderer.invoke('hermes:updates:check'),
    apply: opts => ipcRenderer.invoke('hermes:updates:apply', opts),
    getBranch: () => ipcRenderer.invoke('hermes:updates:branch:get'),
    setBranch: name => ipcRenderer.invoke('hermes:updates:branch:set', name),
    onProgress: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:updates:progress', listener)
      return () => ipcRenderer.removeListener('hermes:updates:progress', listener)
    }
  },
  themes: {
    fetchMarketplace: id => ipcRenderer.invoke('hermes:vscode-theme:fetch', id),
    searchMarketplace: query => ipcRenderer.invoke('hermes:vscode-theme:search', query)
  }
})
