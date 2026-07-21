const assert = require('node:assert/strict')
const test = require('node:test')

const { expectedState, isExpectedOfficialPopup, parseSecureUrl } = require('./enterprise-wecom-bot-view.cjs')

test('product bot view pins the exact official popup source state and timestamp shape', () => {
  const state = 'abcdefghijklmnop'
  const popup = `https://work.weixin.qq.com/ai/qc/gen?source=owner-hermesbot&state=${state}&timestamp=1721037600000`
  assert.equal(isExpectedOfficialPopup(popup, state), true)
  assert.equal(isExpectedOfficialPopup(popup.replace(state, 'different-state-1'), state), false)
  assert.equal(isExpectedOfficialPopup(`${popup}&next=https://evil.invalid`, state), false)
})

test('authorization page requires credential-free HTTPS and a nontrivial state', () => {
  assert.equal(expectedState('https://auth.example/wecom/bot/tx?state=abcdefghijklmnop'), 'abcdefghijklmnop')
  assert.throws(() => parseSecureUrl('http://auth.example/wecom/bot/tx'), /HTTPS/)
  assert.throws(() => parseSecureUrl('https://user:password@auth.example/wecom/bot/tx'), /credential-free/)
})
