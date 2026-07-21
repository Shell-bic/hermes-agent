const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const { app, BrowserWindow, session } = require('electron')
const { isAllowedWeComNavigation } = require('../../electron/enterprise-wecom-view.cjs')

const EXPECTED_ELECTRON_VERSION = '40.10.2'
const EXPECTED_BUNDLE_BYTES = 13_481
const EXPECTED_BUNDLE_SHA256 = 'c23ec8e6111fa227ee1583bd5737713782d210c37a03ddac08b40303577dc48f'
const TRANSACTION_ID = process.env.PB02_ELECTRON_PROBE_RUN_ID
const EXPECTED_STATE = 'pb02_electron_host_state_20260715'
const EXPECTED_SOURCE = 'hermes_pb02_probe'
const FIXTURE_SECRET = 'pb02_fixture_secret_never_persisted_20260715'
const requiredEnvironment = [
  'PB02_ELECTRON_PROBE_BUNDLE',
  'PB02_ELECTRON_PROBE_PFX',
  'PB02_ELECTRON_PROBE_PFX_PASSPHRASE',
  'PB02_ELECTRON_PROBE_PROFILE',
  'PB02_ELECTRON_PROBE_SESSION_DATA',
  'PB02_ELECTRON_PROBE_LOGS',
  'PB02_ELECTRON_PROBE_CRASH_DUMPS',
  'PB02_ELECTRON_PROBE_CACHE',
  'PB02_ELECTRON_PROBE_RUN_ID'
]

for (const name of requiredEnvironment) {
  if (!process.env[name]) throw new Error(`missing child probe environment: ${name}`)
}
assert.match(TRANSACTION_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)

app.setPath('userData', process.env.PB02_ELECTRON_PROBE_PROFILE)
app.setPath('sessionData', process.env.PB02_ELECTRON_PROBE_SESSION_DATA)
app.setPath('logs', process.env.PB02_ELECTRON_PROBE_LOGS)
app.setPath('crashDumps', process.env.PB02_ELECTRON_PROBE_CRASH_DUMPS)
app.setPath('cache', process.env.PB02_ELECTRON_PROBE_CACHE)
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
// This synthetic probe serves only loopback HTTPS and additionally installs
// per-session verification callbacks below; the exported dev certificate is
// not generally trusted for both loopback IP hostnames.
app.commandLine.appendSwitch('ignore-certificate-errors')
app.commandLine.appendSwitch('no-proxy-server')
app.commandLine.appendSwitch('use-angle', 'swiftshader-webgl')
// Mirrors the repository's development-only Windows compatibility path. Some
// managed Windows machines otherwise fail before the first sandboxed renderer
// paints with render-process-gone: launch-failed.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity')
  app.commandLine.appendSwitch('no-sandbox')
}
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  const hostname = new URL(url).hostname
  if (hostname === '127.0.0.1' || hostname === '127.0.0.2') {
    event.preventDefault()
    callback(true)
    return
  }
  callback(false)
})
// The matrix intentionally closes every window between isolated scenarios.
// Keep the test-only child alive until main() finishes the complete matrix.
app.on('window-all-closed', () => {})

const bundle = fs.readFileSync(process.env.PB02_ELECTRON_PROBE_BUNDLE)
assert.equal(bundle.length, EXPECTED_BUNDLE_BYTES)
assert.equal(crypto.createHash('sha256').update(bundle).digest('hex'), EXPECTED_BUNDLE_SHA256)

const harnessScript = fs.readFileSync(path.join(__dirname, 'harness.js'))
const frameScript = fs.readFileSync(path.join(__dirname, 'frame.js'))
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const rsaPublicKeySpki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const results = []
let server
let parentOrigin
let authOrigin

function securityHeaders(contentType, csp = null) {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'X-Content-Type-Options': 'nosniff'
  }
  if (csp) headers['Content-Security-Policy'] = csp
  return headers
}

function respond(response, status, headers, body = '') {
  response.writeHead(status, headers)
  response.end(body)
}

function harnessHtml() {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "connect-src 'self'",
    `child-src ${authOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
  const html = `<!doctype html><html lang="en" data-expected-state="${EXPECTED_STATE}" data-expected-auth-origin="${authOrigin}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PB-02 Electron host smoke</title><script src="/harness.js" defer></script><script src="/bot-poc/bot-auth-client.js" integrity="sha256-wj7I5hEfoifuFYO9VzdxN4LSEMN6A92sCLQDA1d9xI8=" defer></script></head><body><button id="bot-auth-start" type="button">Start</button><p id="bot-auth-status"></p></body></html>`
  return { csp, html }
}

function clientConfig() {
  const issuedAt = new Date().toISOString()
  return {
    transactionId: TRANSACTION_ID,
    source: EXPECTED_SOURCE,
    authOrigin,
    state: EXPECTED_STATE,
    stateDigest: crypto.createHash('sha256').update(EXPECTED_STATE).digest('base64url'),
    corpId: 'pb02_corp',
    owner: '22222222-2222-4222-8222-222222222222',
    audience: 'enterprise-gateway:wecom-personal-bot-poc',
    challenge: 'pb02_challenge_20260715',
    keyId: 'pb02-key',
    rsaPublicKeySpki,
    issuedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  }
}

async function readJson(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 256 * 1024) throw new Error('probe result exceeded size limit')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function startServer() {
  server = https.createServer({
    pfx: fs.readFileSync(process.env.PB02_ELECTRON_PROBE_PFX),
    passphrase: process.env.PB02_ELECTRON_PROBE_PFX_PASSPHRASE
  }, async (request, response) => {
    try {
      const requestUrl = new URL(request.url, `https://${request.headers.host}`)
      process.stderr.write(`PB02_ELECTRON_REQUEST method=${request.method} path=${requestUrl.pathname}\n`)
      const host = requestUrl.host
      if (host !== new URL(parentOrigin).host && host !== new URL(authOrigin).host) {
        respond(response, 421, securityHeaders('text/plain; charset=utf-8'))
        return
      }

      if (host === new URL(parentOrigin).host && request.method === 'GET' && requestUrl.pathname === `/wecom/bot-poc/${TRANSACTION_ID}`) {
        const page = harnessHtml()
        process.stderr.write('PB02_ELECTRON_RESPONSE kind=page status=200\n')
        respond(response, 200, securityHeaders('text/html; charset=utf-8', page.csp), page.html)
        return
      }
      if (host === new URL(parentOrigin).host && request.method === 'GET' && requestUrl.pathname === '/harness.js') {
        respond(response, 200, securityHeaders('text/javascript; charset=utf-8'), harnessScript)
        return
      }
      if (host === new URL(parentOrigin).host && request.method === 'GET' && requestUrl.pathname === '/bot-poc/bot-auth-client.js') {
        respond(response, 200, securityHeaders('text/javascript; charset=utf-8'), bundle)
        return
      }
      if (host === new URL(parentOrigin).host && request.method === 'GET' && requestUrl.pathname === `/wecom/bot-poc/${TRANSACTION_ID}/config`) {
        if (requestUrl.searchParams.get('state') !== EXPECTED_STATE) {
          respond(response, 404, securityHeaders('application/json; charset=utf-8'), '{}')
          return
        }
        respond(response, 200, securityHeaders('application/json; charset=utf-8'), JSON.stringify(clientConfig()))
        return
      }
      if (host === new URL(parentOrigin).host && request.method === 'POST' && requestUrl.pathname === `/wecom/bot-poc/${TRANSACTION_ID}/result`) {
        if (request.headers['x-wecom-bot-poc-state'] !== EXPECTED_STATE) {
          respond(response, 403, securityHeaders('application/json; charset=utf-8'), '{}')
          return
        }
        const body = await readJson(request)
        assert.equal(JSON.stringify(body).includes(FIXTURE_SECRET), false, 'plaintext Bot secret reached the result endpoint')
        process.stderr.write(`PB02_ELECTRON_RESULT status=${body?.status || 'unknown'} error=${body?.errorCode || 'none'}\n`)
        results.push(body)
        respond(response, 204, securityHeaders('application/json; charset=utf-8'))
        return
      }
      if (request.method === 'GET' && requestUrl.pathname === '/frame.html') {
        const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><script src="/frame.js" defer></script></head><body>frame</body></html>'
        respond(response, 200, securityHeaders('text/html; charset=utf-8', "default-src 'none'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"), html)
        return
      }
      if (host === new URL(parentOrigin).host && request.method === 'GET' && requestUrl.pathname === '/navigation-probe.html') {
        const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><a id="main-navigation" href="https://evil.invalid/main-navigation">navigation probe</a></body></html>'
        respond(response, 200, securityHeaders('text/html; charset=utf-8', "default-src 'none'; child-src https:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"), html)
        return
      }
      if (request.method === 'GET' && requestUrl.pathname === '/frame.js') {
        respond(response, 200, securityHeaders('text/javascript; charset=utf-8'), frameScript)
        return
      }
      if (host === new URL(authOrigin).host && request.method === 'GET' && requestUrl.pathname === '/ai/qc/gen') {
        respond(response, 200, securityHeaders('text/html; charset=utf-8', "default-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"), '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>auth popup</body></html>')
        return
      }
      if (host === new URL(authOrigin).host && request.method === 'GET' && requestUrl.pathname === '/redirect-start') {
        respond(response, 302, { ...securityHeaders('text/plain; charset=utf-8'), Location: 'https://evil.invalid/redirected' })
        return
      }
      respond(response, 404, securityHeaders('text/plain; charset=utf-8'))
    } catch (error) {
      respond(response, 500, securityHeaders('text/plain; charset=utf-8'), 'probe request failed')
      process.stderr.write(`${error?.stack || error}\n`)
    }
  })
  server.on('tlsClientError', error => {
    process.stderr.write(`PB02_ELECTRON_TLS_ERROR code=${error?.code || 'unknown'}\n`)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => resolve())
  })
}

function exactKeys(searchParams, expected) {
  return [...searchParams.keys()].sort().join(',') === [...expected].sort().join(',')
}

function isExpectedPopupUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.origin !== authOrigin || parsed.pathname !== '/ai/qc/gen' || parsed.hash) return false
    if (!exactKeys(parsed.searchParams, ['source', 'state', 'timestamp'])) return false
    return parsed.searchParams.get('source') === EXPECTED_SOURCE &&
      parsed.searchParams.get('state') === EXPECTED_STATE &&
      /^\d{10,16}$/u.test(parsed.searchParams.get('timestamp') || '')
  } catch {
    return false
  }
}

function navigationEventUrl(event, detailsOrLegacyUrl) {
  if (typeof detailsOrLegacyUrl === 'string') return detailsOrLegacyUrl
  if (typeof detailsOrLegacyUrl?.url === 'string') return detailsOrLegacyUrl.url
  return typeof event?.url === 'string' ? event.url : ''
}

function wireNavigation(webContents, allow, blocked) {
  const deny = (kind, event, legacyUrl) => {
    const url = navigationEventUrl(event, legacyUrl)
    if (allow(url)) return
    event.preventDefault()
    blocked.push({ kind, url })
  }
  webContents.on('will-navigate', (event, url) => deny('will-navigate', event, url))
  webContents.on('will-redirect', (event, url) => deny('will-redirect', event, url))
  webContents.on('will-frame-navigate', (event, url) => deny('will-frame-navigate', event, url))
}

function waitForResult(startIndex, timeoutMs = 4_000) {
  if (results.length > startIndex) return Promise.resolve(results[startIndex])
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (results.length > startIndex) {
        clearInterval(timer)
        resolve(results[startIndex])
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('result endpoint was not reached'))
      }
    }, 10)
  })
}

function waitForCondition(predicate, failureMessage, timeoutMs = 2_000) {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(failureMessage))
      }
    }, 10)
  })
}

function postMessageScript(data, targetOrigin, count = 1) {
  const serialized = JSON.stringify(data)
  return `(async () => {
    const dispatch = async () => {
      const channel = new MessageChannel();
      const done = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('dispatch timed out')), 2000);
        channel.port1.onmessage = event => {
          clearTimeout(timeout);
          channel.port1.close();
          if (event.data !== 'dispatched') reject(new Error('invalid dispatch acknowledgement'));
          else resolve();
        };
        channel.port1.start();
      });
      opener.postMessage(${serialized}, ${JSON.stringify(targetOrigin)}, [channel.port2]);
      return done;
    };
    ${count === 2 ? 'const first = dispatch(); const second = dispatch(); await Promise.all([first, second]);' : 'await dispatch();'}
    return true;
  })()`
}

async function createScenario() {
  const blocked = []
  const partition = `pb02-electron-${crypto.randomUUID()}`
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition,
      sandbox: true,
      webSecurity: true
    }
  })
  win.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    let safeTarget = 'invalid'
    try {
      const parsed = new URL(validatedUrl)
      safeTarget = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
    } catch {}
    process.stderr.write(`PB02_ELECTRON_LOAD_ERROR code=${code} main=${isMainFrame} target=${safeTarget} description=${JSON.stringify(description)}\n`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    process.stderr.write(`PB02_ELECTRON_RENDERER_GONE reason=${details.reason} code=${details.exitCode}\n`)
  })
  win.webContents.session.setCertificateVerifyProc((request, callback) => {
    callback(request.hostname === '127.0.0.1' || request.hostname === '127.0.0.2' ? 0 : -3)
  })
  const parentRules = new Map([
    [new URL(parentOrigin).host, [{ exact: `/wecom/bot-poc/${TRANSACTION_ID}` }]],
    [new URL(authOrigin).host, [{ exact: '/frame.html' }]]
  ])
  let popupResolve
  const popupPromise = new Promise(resolve => (popupResolve = resolve))
  win.webContents.setWindowOpenHandler(details => {
    const accepted = isExpectedPopupUrl(details.url)
    process.stderr.write(`PB02_ELECTRON_WINDOW_OPEN accepted=${accepted}\n`)
    if (!accepted) {
      blocked.push({ kind: 'window-open', url: details.url })
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          partition,
          sandbox: true,
          webSecurity: true
        }
      }
    }
  })
  win.webContents.on('did-create-window', popup => {
    const popupBlocked = []
    wireNavigation(popup.webContents, isExpectedPopupUrl, popupBlocked)
    popup.webContents.setWindowOpenHandler(details => {
      popupBlocked.push({ kind: 'window-open', url: details.url })
      return { action: 'deny' }
    })
    popupResolve({ popup, blocked: popupBlocked })
  })
  const initialUrl = `${parentOrigin}/wecom/bot-poc/${TRANSACTION_ID}?state=${encodeURIComponent(EXPECTED_STATE)}`
  const domReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('parent document did not become ready')), 4_000)
    win.webContents.once('dom-ready', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
  const load = win.loadURL(initialUrl)
  await domReady
  await load.catch(async error => {
    const loadedPath = await win.webContents.executeJavaScript('location.pathname')
    if (error?.code !== 'ERR_FAILED' || loadedPath !== `/wecom/bot-poc/${TRANSACTION_ID}`) throw error
  })
  wireNavigation(win.webContents, url => isAllowedWeComNavigation(url, parentRules), blocked)
  await win.webContents.executeJavaScript('window.pb02Probe.clickStart()')
  const popup = await new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      const details = await win.webContents.executeJavaScript('({ openCalls: window.pb02Probe.observations.openCalls, openError: window.pb02Probe.observations.openError })').catch(() => ({}))
      reject(new Error(`auth popup was not created (openCalls=${details.openCalls ?? 'unknown'}, openError=${details.openError ?? 'none'})`))
    }, 4_000)
    popupPromise.then(value => {
      clearTimeout(timeout)
      resolve(value)
    }, error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
  await new Promise((resolve, reject) => {
    if (!popup.popup.webContents.isLoading()) resolve()
    else {
      popup.popup.webContents.once('did-finish-load', resolve)
      popup.popup.webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`${code}: ${description}`)))
    }
  })
  return { blocked, partition, popup, win }
}

async function destroyScenario(scenario) {
  try {
    if (!scenario.popup.popup.isDestroyed()) scenario.popup.popup.destroy()
    if (!scenario.win.isDestroyed()) scenario.win.destroy()
  } finally {
    const isolated = session.fromPartition(scenario.partition)
    await isolated.clearStorageData()
    await isolated.clearCache()
  }
}

function successMessage(state = EXPECTED_STATE) {
  return {
    probe: 'pb02-electron-host-smoke',
    type: 'AUTH_SUCCESS',
    payload: { botid: 'pb02-bot', secret: FIXTURE_SECRET, ...(state === undefined ? {} : { state }) }
  }
}

function successMessageWithoutState() {
  return {
    probe: 'pb02-electron-host-smoke',
    type: 'AUTH_SUCCESS',
    payload: { botid: 'pb02-bot', secret: FIXTURE_SECRET }
  }
}

async function observations(scenario) {
  return scenario.win.webContents.executeJavaScript('structuredClone(window.pb02Probe.observations)')
}

async function scenarioCorrect() {
  const start = results.length
  const scenario = await createScenario()
  try {
    await scenario.popup.popup.webContents.executeJavaScript(postMessageScript(successMessage(), parentOrigin))
    const result = await waitForResult(start)
    assert.equal(result.status, 'authorized')
    assert.equal(result.errorCode, null)
    assert.equal(result.envelope.version, 'wecom-bot-poc-envelope.v1')
    assert.equal(results.length, start + 1)
    assert.deepEqual(await observations(scenario), {
      openCalls: 1,
      openError: null,
      reached: [{ origin: authOrigin, type: 'AUTH_SUCCESS' }],
      securityViolations: []
    })
  } finally {
    await destroyScenario(scenario)
  }
}

async function scenarioWrongOrigin() {
  const start = results.length
  const scenario = await createScenario()
  try {
    await scenario.win.webContents.executeJavaScript(`window.pb02Probe.dispatchWrongOriginWithRealPopup(${JSON.stringify(successMessage())})`)
    assert.equal(results.length, start)
    assert.deepEqual((await observations(scenario)).reached, [])
  } finally {
    await destroyScenario(scenario)
  }
}

async function scenarioWrongSource() {
  const start = results.length
  const scenario = await createScenario()
  try {
    await scenario.win.webContents.executeJavaScript(`window.pb02Probe.dispatchViaFrame(window.pb02Probe.expectedAuthOrigin, ${JSON.stringify(successMessage())})`)
    assert.equal(results.length, start)
    assert.deepEqual((await observations(scenario)).reached, [])
  } finally {
    await destroyScenario(scenario)
  }
}

async function scenarioState(name, state) {
  const start = results.length
  const scenario = await createScenario()
  try {
    await scenario.popup.popup.webContents.executeJavaScript(postMessageScript(successMessage(state), parentOrigin))
    const result = await waitForResult(start)
    assert.equal(result.status, 'error', name)
    assert.equal(result.errorCode, 'sdk_state_mismatch', name)
    assert.equal(result.envelope, null, name)
    assert.deepEqual((await observations(scenario)).reached, [])
  } finally {
    await destroyScenario(scenario)
  }
}

async function scenarioDuplicate() {
  const start = results.length
  const scenario = await createScenario()
  try {
    await scenario.popup.popup.webContents.executeJavaScript(postMessageScript(successMessage(), parentOrigin, 2))
    const result = await waitForResult(start)
    assert.equal(result.status, 'authorized')
    assert.equal(results.length, start + 1)
    assert.deepEqual((await observations(scenario)).reached, [{ origin: authOrigin, type: 'AUTH_SUCCESS' }])
  } finally {
    await destroyScenario(scenario)
  }
}

async function scenarioHostPolicy() {
  const scenario = await createScenario()
  try {
    const csp = await scenario.win.webContents.executeJavaScript('window.pb02Probe.verifyCsp()')
    assert.equal(csp.inlineScriptRan, false)
    assert.equal(csp.evalBlocked, true)
    assert.equal(csp.externalConnectBlocked, true)
    assert.equal(csp.directives.some(directive => directive.startsWith('script-src')), true)
    assert.equal(csp.directives.includes('connect-src'), true)

    assert.equal(await scenario.win.webContents.executeJavaScript("window.pb02Probe.attemptWindow('https://evil.invalid/escape')"), true)
    assert.equal(await scenario.popup.popup.webContents.executeJavaScript("window.open('https://evil.invalid/nested') === null"), true)
    assert.equal(scenario.blocked.some(item => item.kind === 'window-open'), true)
    assert.equal(scenario.popup.blocked.some(item => item.kind === 'window-open'), true)

    const authRules = new Map([[new URL(authOrigin).host, [{ exact: '/ai/qc/gen' }]]])
    assert.equal(isAllowedWeComNavigation(`${authOrigin}/ai/qc/gen`, authRules), true)
    assert.equal(isAllowedWeComNavigation(`${authOrigin}/ai/qc/gen.evil`, authRules), false)
    assert.equal(isAllowedWeComNavigation(`${authOrigin.replace('https:', 'http:')}/ai/qc/gen`, authRules), false)
  } finally {
    await destroyScenario(scenario)
  }
}

async function createPolicyWindow() {
  const blocked = []
  const partition = `pb02-electron-policy-${crypto.randomUUID()}`
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition,
      sandbox: true,
      webSecurity: true
    }
  })
  win.webContents.session.setCertificateVerifyProc((request, callback) => {
    callback(request.hostname === '127.0.0.1' || request.hostname === '127.0.0.2' ? 0 : -3)
  })
  return { blocked, partition, win }
}

async function destroyPolicyWindow(scenario) {
  if (!scenario.win.isDestroyed()) scenario.win.destroy()
  const isolated = session.fromPartition(scenario.partition)
  await isolated.clearStorageData()
  await isolated.clearCache()
}

async function scenarioNavigationEvents() {
  const navigation = await createPolicyWindow()
  try {
    const mainUrl = `${parentOrigin}/navigation-probe.html`
    navigation.win.webContents.on('will-navigate', (event, detailsOrLegacyUrl) => {
      const url = navigationEventUrl(event, detailsOrLegacyUrl)
      if (url === mainUrl) return
      event.preventDefault()
      navigation.blocked.push({ kind: 'will-navigate', url })
    })
    await navigation.win.loadURL(mainUrl)
    await navigation.win.webContents.executeJavaScript("document.getElementById('main-navigation').click()")
    await waitForCondition(
      () => navigation.blocked.some(item => item.kind === 'will-navigate'),
      'will-navigate event was not observed'
    )
    const event = navigation.blocked.find(item => item.kind === 'will-navigate')
    assert.equal(event.url, 'https://evil.invalid/main-navigation')
    assert.equal(navigation.win.webContents.getURL(), mainUrl)
  } finally {
    await destroyPolicyWindow(navigation)
  }

  const redirect = await createPolicyWindow()
  try {
    wireNavigation(redirect.win.webContents, url => url === `${authOrigin}/redirect-start`, redirect.blocked)
    await redirect.win.loadURL(`${authOrigin}/redirect-start`).catch(error => {
      if (!['ERR_ABORTED', 'ERR_FAILED'].includes(error?.code)) throw error
    })
    assert.equal(redirect.blocked.some(item => item.kind === 'will-redirect' && item.url === 'https://evil.invalid/redirected'), true)
  } finally {
    await destroyPolicyWindow(redirect)
  }

  const frame = await createPolicyWindow()
  try {
    const mainUrl = `${parentOrigin}/navigation-probe.html`
    wireNavigation(frame.win.webContents, url => url === mainUrl, frame.blocked)
    await frame.win.loadURL(mainUrl)
    await frame.win.webContents.executeJavaScript(`new Promise(resolve => {
      const element = document.createElement('iframe');
      element.src = 'https://evil.invalid/frame-navigation';
      document.body.append(element);
      setTimeout(resolve, 250);
    })`)
    assert.equal(frame.blocked.some(item => item.kind === 'will-frame-navigate' && item.url === 'https://evil.invalid/frame-navigation'), true)
  } finally {
    await destroyPolicyWindow(frame)
  }
}

async function runScenario(name, action) {
  process.stderr.write(`PB02_ELECTRON_SCENARIO name=${name} status=begin\n`)
  await action()
  process.stderr.write(`PB02_ELECTRON_SCENARIO name=${name} status=pass\n`)
}

async function main() {
  assert.equal(process.versions.electron, EXPECTED_ELECTRON_VERSION)
  await app.whenReady()
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    callback(request.hostname === '127.0.0.1' || request.hostname === '127.0.0.2' ? 0 : -3)
  })
  await startServer()
  const port = server.address().port
  parentOrigin = `https://127.0.0.1:${port}`
  authOrigin = `https://127.0.0.2:${port}`

  await runScenario('navigation-events', scenarioNavigationEvents)
  await runScenario('correct', scenarioCorrect)
  await runScenario('wrong-origin', scenarioWrongOrigin)
  await runScenario('wrong-source', scenarioWrongSource)
  await runScenario('missing-state', async () => {
    const missingState = await createScenario()
    try {
      const start = results.length
      await missingState.popup.popup.webContents.executeJavaScript(postMessageScript(successMessageWithoutState(), parentOrigin))
      const result = await waitForResult(start)
      assert.equal(result.status, 'error')
      assert.equal(result.errorCode, 'sdk_state_mismatch')
      assert.equal(result.envelope, null)
      assert.deepEqual((await observations(missingState)).reached, [])
    } finally {
      await destroyScenario(missingState)
    }
  })
  await runScenario('mismatched-state', () => scenarioState('mismatched-state', 'pb02_wrong_state_20260715'))
  await runScenario('duplicate-terminal', scenarioDuplicate)
  await runScenario('host-policy', scenarioHostPolicy)
  process.stdout.write(`PB02_ELECTRON_CHILD_RESULT=PASS scenarios=8 electron=${process.versions.electron}\n`)
}

main().then(async () => {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
  app.quit()
}).catch(async error => {
  process.stderr.write(`PB02_ELECTRON_CHILD_RESULT=FAIL reason=${JSON.stringify(error?.stack || error?.message || 'unknown error')}\n`)
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  if (server) {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
  app.exit(1)
})
