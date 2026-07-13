const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { REDACTED, isEnterpriseManagedEnv, redactManagedText } = require('./managed-redaction.cjs')

const FAKE_SECRETS = [
  'gw_FAKE_gateway_1234567890',
  'adm_FAKE_admin_1234567890',
  'dsk_FAKE_desktop_1234567890',
  'sk-FAKE-provider-1234567890'
]

test('managed mode is enabled by every immutable enterprise launch signal', () => {
  assert.equal(isEnterpriseManagedEnv({ HERMES_ENTERPRISE_MANAGED: 'true' }), true)
  assert.equal(isEnterpriseManagedEnv({ HERMES_ENTERPRISE_DESKTOP: '1' }), true)
  assert.equal(isEnterpriseManagedEnv({ HERMES_ENTERPRISE_GATEWAY_URL: 'https://gateway.invalid' }), true)
  assert.equal(isEnterpriseManagedEnv({ HERMES_DESKTOP_ENTERPRISE_GATEWAY_URL: 'https://gateway.invalid' }), true)
  assert.equal(isEnterpriseManagedEnv({ HERMES_ENTERPRISE_MANAGED: '0' }), false)
  assert.equal(isEnterpriseManagedEnv({}), false)
})

test('managed redactor removes complete fake tokens and URL query credentials', () => {
  const input = [
    ...FAKE_SECRETS,
    'https://gateway.invalid/v1/chat?token=opaque-value-123&mode=test',
    'https://gateway.invalid/v1/chat?mode=test&api_key=query-secret-456',
    'Authorization: Bearer bearer-secret-789',
    'OPENAI_API_KEY=plain-env-secret-012'
  ].join('\n')

  const output = redactManagedText(input, true)

  for (const secret of FAKE_SECRETS) {
    assert.equal(output.includes(secret), false)
  }
  assert.equal(output.includes('opaque-value-123'), false)
  assert.equal(output.includes('query-secret-456'), false)
  assert.equal(output.includes('bearer-secret-789'), false)
  assert.equal(output.includes('plain-env-secret-012'), false)
  assert.match(output, /token=\[REDACTED\]/)
  assert.match(output, /api_key=\[REDACTED\]/)
  assert.ok(output.split(REDACTED).length > FAKE_SECRETS.length)
})

test('desktop sinks and preload bridge wire the managed redactor at their final output boundaries', () => {
  const electronDir = __dirname
  const main = fs.readFileSync(path.join(electronDir, 'main.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(electronDir, 'preload.cjs'), 'utf8')

  assert.match(main, /function rememberLog\(chunk\)[\s\S]{0,160}redactManagedText\(chunk, ENTERPRISE_MANAGED_OUTPUTS\)/)
  assert.match(main, /title: redactManagedText\(payload\?\.title \|\| 'Hermes', ENTERPRISE_MANAGED_OUTPUTS\)/)
  assert.match(main, /body: redactManagedText\(payload\?\.body \|\| '', ENTERPRISE_MANAGED_OUTPUTS\)/)
  assert.match(preload, /managed: ENTERPRISE_MANAGED_OUTPUTS/)
  assert.match(preload, /redactSensitiveText: value => redactManagedText\(value, ENTERPRISE_MANAGED_OUTPUTS\)/)
})

test('managed redactor removes one-layer encoded fake tokens and sensitive env text', () => {
  const token = FAKE_SECRETS[0]
  const sensitiveEnv = 'OPENAI_API_KEY=only-a-fake-test-value'
  const representations = [
    Buffer.from(token).toString('base64'),
    Buffer.from(token).toString('base64url'),
    Buffer.from(token).toString('base64url').replace(/=+$/, ''),
    Buffer.from(token).toString('hex'),
    [...Buffer.from(token)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join(''),
    Buffer.from(sensitiveEnv).toString('base64')
  ]
  const output = redactManagedText(representations.join('\n'), true)

  for (const encoded of representations) {
    assert.equal(output.includes(encoded), false)
  }
  assert.equal(output.split(REDACTED).length, representations.length + 1)
})

test('encoded public text is preserved in managed mode and encoded secrets are preserved outside it', () => {
  const publicBase64 = Buffer.from('ordinary desktop diagnostic text').toString('base64')
  const encodedSecret = Buffer.from(FAKE_SECRETS[1]).toString('base64url')

  assert.equal(redactManagedText(publicBase64, true), publicBase64)
  assert.equal(redactManagedText(encodedSecret, false), encodedSecret)
})

test('non-managed redactor preserves output byte-for-byte', () => {
  const input = `${FAKE_SECRETS.join(' ')} https://gateway.invalid/?token=opaque-value`

  assert.equal(redactManagedText(input, false), input)
})
