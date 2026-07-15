const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  MESSAGING_CHANNEL_POLICY_CAPABILITIES,
  MESSAGING_CHANNEL_SOURCE_BY_SURFACE,
  computeMessagingChannelPolicyHash,
  parseMessagingChannelPolicy,
  resolveMessagingChannelPolicy
} = require('./messaging-channel-policy.cjs')

const CONTRACT_ROOT = path.resolve(__dirname, '../../../contracts/wecom-personal-bot/v1')

function fixture(kind, fileName) {
  return JSON.parse(fs.readFileSync(path.join(CONTRACT_ROOT, 'fixtures', kind, fileName), 'utf8'))
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex')
}

test('Desktop mirror is sourced from the Gateway authority manifest and every byte matches its SHA-256', () => {
  const source = fixturePath('source-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(source, 'utf8'))
  assert.equal(manifest.authorityRepository, 'enterprise-gateway')
  assert.equal(manifest.authorityPath, 'contracts/wecom-personal-bot/v1')

  const actualFiles = []
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile()) actualFiles.push(path.relative(CONTRACT_ROOT, fullPath).split(path.sep).join('/'))
    }
  }
  walk(CONTRACT_ROOT)
  actualFiles.sort()
  assert.deepEqual(actualFiles.filter(file => file !== 'source-manifest.json'), Object.keys(manifest.files).sort())

  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    assert.equal(sha256(fs.readFileSync(path.join(CONTRACT_ROOT, ...relativePath.split('/')))), expectedHash)
  }
})

test('managed bootstrap and runtime manifest resolve one canonical policy snapshot', () => {
  const bootstrap = fixture('valid', 'managed-bootstrap.json')
  const manifest = fixture('valid', 'managed-runtime-manifest.json')
  const decision = resolveMessagingChannelPolicy({ bootstrap, manifest })

  assert.equal(decision.status, 'applied')
  assert.equal(decision.policy.policyHash, '22ba0b6a8fc41e499a3c70aedd5844d2071751c72d7ee98512f18d60b52c354d')
  assert.equal(computeMessagingChannelPolicyHash(decision.policy), decision.policy.policyHash)
  assert.deepEqual(decision.visibleChannelIds, ['wecom-personal'])
  assert.deepEqual(decision.allowedChannelIds, ['wecom-personal'])
  assert.equal(MESSAGING_CHANNEL_SOURCE_BY_SURFACE['wecom-personal'], 'wecom')
})

test('policyHash is calculated from the normalized payload without recursively hashing policyHash', () => {
  const raw = fixture('valid', 'managed-bootstrap.json').messagingChannelPolicy
  const policy = parseMessagingChannelPolicy(raw)

  assert.equal(computeMessagingChannelPolicyHash({ ...policy, policyHash: '0'.repeat(64) }), policy.policyHash)
})

test('unmanaged missing policy preserves the complete upstream catalog', () => {
  const decision = resolveMessagingChannelPolicy({ bootstrap: fixture('valid', 'unmanaged-compatibility.json') })

  assert.deepEqual(decision, {
    mode: 'unmanaged',
    status: 'full-catalog',
    reason: null,
    policy: null,
    hideUnlisted: false,
    visibleChannelIds: null,
    userManageableChannelIds: null,
    allowedChannelIds: null
  })
})

test('manifest cannot downgrade a managed bootstrap to unmanaged mode', () => {
  const bootstrap = fixture('valid', 'managed-bootstrap.json')
  const decision = resolveMessagingChannelPolicy({
    bootstrap,
    manifest: { mode: 'unmanaged', messagingChannelPolicy: null }
  })

  assert.equal(decision.status, 'fail-closed')
  assert.equal(decision.reason, 'policy_mode_mismatch')
})

for (const [name, bootstrap, manifest] of [
  [
    'bootstrap-only policy in a dual-document response',
    fixture('valid', 'managed-bootstrap.json'),
    {}
  ],
  [
    'manifest-only policy in a dual-document response',
    { mode: 'managed' },
    fixture('valid', 'managed-runtime-manifest.json')
  ]
]) {
  test(`${name} fails closed as an incomplete snapshot`, () => {
    const decision = resolveMessagingChannelPolicy({ bootstrap, manifest })

    assert.equal(decision.status, 'fail-closed')
    assert.equal(decision.reason, 'policy_snapshot_incomplete')
    assert.deepEqual(decision.allowedChannelIds, [])
  })
}

test('single-document managed parsing requires explicit opt-in', () => {
  const bootstrap = fixture('valid', 'managed-bootstrap.json')
  const manifest = fixture('valid', 'managed-runtime-manifest.json')
  const bootstrapDefault = resolveMessagingChannelPolicy({ bootstrap })
  const manifestDefault = resolveMessagingChannelPolicy({ manifest })
  const bootstrapOnly = resolveMessagingChannelPolicy({ bootstrap, requireDualSnapshot: false })
  const manifestOnly = resolveMessagingChannelPolicy({ manifest, requireDualSnapshot: false })

  assert.equal(bootstrapDefault.reason, 'policy_snapshot_incomplete')
  assert.equal(manifestDefault.reason, 'policy_snapshot_incomplete')
  assert.equal(bootstrapOnly.status, 'applied')
  assert.equal(manifestOnly.status, 'applied')
})

test('managed missing policy and absent client capability fail closed with empty channel access', () => {
  const missing = resolveMessagingChannelPolicy({
    bootstrap: fixture('invalid', 'managed-missing-policy.json'),
    requireDualSnapshot: false
  })
  const valid = fixture('valid', 'managed-bootstrap.json')
  const oldClient = resolveMessagingChannelPolicy({
    bootstrap: valid,
    clientCapabilities: [],
    requireDualSnapshot: false
  })

  for (const decision of [missing, oldClient]) {
    assert.equal(decision.status, 'fail-closed')
    assert.deepEqual(decision.visibleChannelIds, [])
    assert.deepEqual(decision.userManageableChannelIds, [])
    assert.deepEqual(decision.allowedChannelIds, [])
  }
  assert.equal(missing.reason, 'policy_missing')
  assert.equal(oldClient.reason, 'client_capability_missing')
  assert.deepEqual(MESSAGING_CHANNEL_POLICY_CAPABILITIES, ['messaging-channel-policy.v1'])
})

for (const fileName of [
  'policy-missing-version.json',
  'policy-future-version.json',
  'policy-unknown-field.json',
  'policy-null-channel-array.json',
  'policy-duplicate-channel-id.json',
  'policy-invalid-channel-id.json',
  'policy-oversized-array.json',
  'policy-manageable-not-visible.json',
  'policy-allowed-outside-visible.json',
  'policy-client-capability-missing.json',
  'policy-hash-mismatch.json'
]) {
  test(`${fileName} fails closed`, () => {
    const decision = resolveMessagingChannelPolicy({
      bootstrap: { mode: 'managed', messagingChannelPolicy: fixture('invalid', fileName) },
      requireDualSnapshot: false
    })

    assert.equal(decision.status, 'fail-closed')
    assert.deepEqual(decision.visibleChannelIds, [])
    assert.deepEqual(decision.allowedChannelIds, [])
  })
}

test('bootstrap and runtime manifest policy hash mismatch fails closed', () => {
  const bootstrap = fixture('valid', 'managed-bootstrap.json')
  const emptyPolicy = {
    contractVersion: 'messaging-channel-policy.v1',
    hideUnlisted: true,
    visibleChannelIds: [],
    userManageableChannelIds: [],
    allowedChannelIds: [],
    policyHash: '',
    requiredClientCapabilities: ['messaging-channel-policy.v1']
  }
  emptyPolicy.policyHash = computeMessagingChannelPolicyHash(emptyPolicy)
  const decision = resolveMessagingChannelPolicy({
    bootstrap,
    manifest: { messagingChannelPolicy: emptyPolicy }
  })

  assert.equal(decision.status, 'fail-closed')
  assert.equal(decision.reason, 'policy_snapshot_mismatch')
})

function fixturePath(...segments) {
  return path.join(CONTRACT_ROOT, ...segments)
}
