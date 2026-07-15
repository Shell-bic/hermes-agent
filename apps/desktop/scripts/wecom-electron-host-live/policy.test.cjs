const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { validateStart } = require('./protocol.cjs')
const {
  isAllowedMainHistorySanitization,
  isAllowedMainNavigation,
  isAllowedOfficialPopup,
  isAllowedPopupNavigation,
  rendererFailureCode,
  shouldBlockRedirect
} = require('./policy.cjs')

const transactionId = '22222222-2222-4222-8222-222222222222'
const state = 'A'.repeat(43)
const start = validateStart({
  protocolVersion: 1,
  command: 'start',
  runId: '11111111-1111-4111-8111-111111111111',
  authorizationUrl: `https://gateway.example.test/wecom/bot-poc/${transactionId}?state=${state}`,
  gatewayOrigin: 'https://gateway.example.test',
  profileRoot: path.join(os.tmpdir(), `pb02-policy-${Date.now()}-${Math.random()}`)
})
const popup = `https://work.weixin.qq.com/ai/qc/gen?source=provisioned.source&state=${state}&timestamp=1784088000000`

test('main window allows only the exact Gateway origin and initial authorization path', () => {
  assert.equal(isAllowedMainNavigation(start.authorizationUrl, start), true)
  assert.equal(isAllowedMainNavigation(`https://gateway.example.test${start.authorizationPath}`, start), false)
  assert.equal(isAllowedMainNavigation(`https://gateway.example.test${start.authorizationPath}?state=wrong`, start), false)
  assert.equal(isAllowedMainNavigation('https://gateway.example.test/other', start), false)
  assert.equal(isAllowedMainNavigation(`https://evil.example/${start.authorizationPath}`, start), false)
  assert.equal(isAllowedMainNavigation(`http://gateway.example.test${start.authorizationPath}`, start), false)
})

test('main history permits exactly one reviewed state-scrubbing transition after the exact initial load', () => {
  const sanitized = `https://gateway.example.test${start.authorizationPath}`
  const ready = { isMainFrame: true, initialLoadCompleted: true, alreadySanitized: false, previousUrl: start.authorizationUrl }
  assert.equal(isAllowedMainHistorySanitization(sanitized, start, ready), true)
  assert.equal(isAllowedMainHistorySanitization(sanitized, start, { ...ready, initialLoadCompleted: false }), false)
  assert.equal(isAllowedMainHistorySanitization(sanitized, start, { ...ready, alreadySanitized: true }), false)
  assert.equal(isAllowedMainHistorySanitization(sanitized, start, { ...ready, isMainFrame: false }), false)
  assert.equal(isAllowedMainHistorySanitization(`${sanitized}?state=${state}`, start, ready), false)
  assert.equal(isAllowedMainHistorySanitization('https://gateway.example.test/other', start, ready), false)
  assert.equal(isAllowedMainHistorySanitization(`https://evil.example${start.authorizationPath}`, start, ready), false)
  assert.equal(isAllowedMainNavigation(sanitized, start), false, 'real navigation to the scrubbed URL remains blocked')
})

test('official popup requires exact origin, path, keys and matching state', () => {
  assert.equal(isAllowedOfficialPopup(popup, start), true)
  assert.equal(isAllowedOfficialPopup(popup.replace('work.weixin.qq.com', 'evil.example'), start), false)
  assert.equal(isAllowedOfficialPopup(popup.replace('/ai/qc/gen', '/ai/qc/other'), start), false)
  assert.equal(isAllowedOfficialPopup(popup.replace(state, 'B'.repeat(43)), start), false)
  assert.equal(isAllowedOfficialPopup(`${popup}&extra=1`, start), false)
})

test('popup navigation remains on the accepted official path and all redirects fail closed', () => {
  assert.equal(isAllowedPopupNavigation(popup, popup), true)
  assert.equal(isAllowedPopupNavigation('https://work.weixin.qq.com/ai/qc/gen', popup), false)
  assert.equal(isAllowedPopupNavigation('https://work.weixin.qq.com/ai/qc/redirected', popup), false)
  assert.equal(isAllowedPopupNavigation('https://other.weixin.qq.com/ai/qc/gen', popup), false)
  assert.equal(shouldBlockRedirect(popup, start), true)
})

test('renderer termination has a stable context-specific code across initial-load races', () => {
  assert.equal(rendererFailureCode(false, 'gateway_load_failed'), 'gateway_load_failed')
  assert.equal(rendererFailureCode(false, 'gateway_load_failed', true), 'gateway_load_failed')
  assert.equal(rendererFailureCode(false, 'popup_load_failed'), 'popup_load_failed')
  assert.equal(rendererFailureCode(false, 'popup_load_failed', true), 'popup_load_failed')
  assert.equal(rendererFailureCode(true, 'gateway_load_failed'), 'renderer_crashed')
  assert.equal(rendererFailureCode(true, 'popup_load_failed', true), 'renderer_unresponsive')
})
