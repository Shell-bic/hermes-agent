const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  BOT_BINDING_VERSION,
  BOT_TRANSACTION_VERSION,
  MAX_AUTHORIZATION_URL_LENGTH,
  MAX_CAPABILITIES,
  MAX_DISPLAY_NAME_LENGTH,
  MESSAGING_CHANNEL_POLICY_CAPABILITY,
  parseRfc3339DateTime,
  validateCreateWeComBotTransactionRequest,
  validateWeComBotBinding,
  validateWeComBotTransaction
} = require('./wecom-personal-bot-contract.cjs')

const CONTRACT_ROOT = path.resolve(__dirname, '../../../contracts/wecom-personal-bot/v1')
const INVALID_DATE_TIMES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'wecom-personal-bot-invalid-datetimes.json'), 'utf8')
)

function fixture(kind, fileName) {
  return JSON.parse(fs.readFileSync(path.join(CONTRACT_ROOT, 'fixtures', kind, fileName), 'utf8'))
}

function schema(fileName) {
  return JSON.parse(fs.readFileSync(path.join(CONTRACT_ROOT, 'schemas', fileName), 'utf8'))
}

test('Desktop validators consume the shared valid request, transaction, and binding fixtures', () => {
  assert.doesNotThrow(() => validateCreateWeComBotTransactionRequest(fixture('valid', 'transaction-request.json')))
  assert.doesNotThrow(() => validateWeComBotTransaction(fixture('valid', 'transaction-pending.json')))
  assert.doesNotThrow(() => validateWeComBotBinding(fixture('valid', 'binding-pending-owner-verification.json')))
  assert.doesNotThrow(() => validateWeComBotBinding(fixture('valid', 'binding-connected.json')))
})

test('Desktop-hosted runtime accepts verified connected bindings while the local Bot process is offline', () => {
  const binding = {
    ...fixture('valid', 'binding-connected.json'),
    connectionStatus: 'offline'
  }

  assert.throws(() => validateWeComBotBinding(binding), error => error?.code === 'binding_connected_state_invalid')
  assert.doesNotThrow(() => validateWeComBotBinding(binding, { allowDesktopHostedOffline: true }))
})

for (const fileName of [
  'transaction-request-wrong-version.json',
  'transaction-request-empty-capabilities.json',
  'transaction-request-missing-capability.json'
]) {
  test(`Desktop rejects shared invalid request fixture ${fileName}`, () => {
    assert.throws(() => validateCreateWeComBotTransactionRequest(fixture('invalid', fileName)))
  })
}

for (const fileName of [
  'transaction-unknown-status.json',
  'transaction-http-url.json',
  'transaction-userinfo-url.json',
  'transaction-authorization-url-too-long.json',
  'transaction-empty-guid.json'
]) {
  test(`Desktop rejects shared invalid transaction fixture ${fileName}`, () => {
    assert.throws(() => validateWeComBotTransaction(fixture('invalid', fileName)))
  })
}

for (const fileName of ['binding-unknown-status.json', 'binding-display-name-too-long.json', 'binding-empty-guid.json']) {
  test(`Desktop rejects shared invalid binding fixture ${fileName}`, () => {
    assert.throws(() => validateWeComBotBinding(fixture('invalid', fileName)))
  })
}

test('Desktop runtime constants stay aligned with the shared schemas', () => {
  const request = schema('wecom-bot-transaction-request.schema.json')
  const transaction = schema('wecom-bot-transaction.schema.json')
  const binding = schema('wecom-bot-binding.schema.json')

  assert.equal(request.properties.contractVersion.const, BOT_TRANSACTION_VERSION)
  assert.equal(request.properties.clientCapabilities.maxItems, MAX_CAPABILITIES)
  assert.equal(request.properties.clientCapabilities.contains.const, MESSAGING_CHANNEL_POLICY_CAPABILITY)
  assert.equal(transaction.properties.contractVersion.const, BOT_TRANSACTION_VERSION)
  assert.equal(transaction.properties.authorizationUrl.maxLength, MAX_AUTHORIZATION_URL_LENGTH)
  assert.equal(binding.properties.contractVersion.const, BOT_BINDING_VERSION)
  assert.equal(binding.properties.displayName.maxLength, MAX_DISPLAY_NAME_LENGTH)
})

test('main-only contract parser accepts RFC3339 timestamps with Z or an explicit offset', () => {
  assert.notEqual(parseRfc3339DateTime('2024-02-29T09:10:00.123456Z'), null)
  assert.notEqual(parseRfc3339DateTime('2026-07-15T17:10:00+08:00'), null)

  const transaction = fixture('valid', 'transaction-pending.json')
  assert.doesNotThrow(() => validateWeComBotTransaction({
    ...transaction,
    expiresAt: '2026-07-15T17:10:00+08:00'
  }))
})

for (const invalidDateTime of INVALID_DATE_TIMES) {
  test(`main-only parser rejects ${invalidDateTime.name} date-time`, () => {
    const transaction = fixture('valid', 'transaction-pending.json')
    const binding = fixture('valid', 'binding-connected.json')

    assert.equal(parseRfc3339DateTime(invalidDateTime.value), null)
    assert.throws(() => validateWeComBotTransaction({ ...transaction, expiresAt: invalidDateTime.value }))
    assert.throws(() => validateWeComBotBinding({ ...binding, createdAt: invalidDateTime.value }))
    assert.throws(() => validateWeComBotBinding({ ...binding, updatedAt: invalidDateTime.value }))
    assert.throws(() => validateWeComBotBinding({ ...binding, lastConnectedAt: invalidDateTime.value }))
  })
}
