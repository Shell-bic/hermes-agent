const crypto = require('node:crypto')

const MESSAGING_CHANNEL_POLICY_VERSION = 'messaging-channel-policy.v1'
const MESSAGING_CHANNEL_POLICY_CAPABILITIES = Object.freeze([MESSAGING_CHANNEL_POLICY_VERSION])
const MESSAGING_CHANNEL_SOURCE_BY_SURFACE = Object.freeze({
  'wecom-personal': 'wecom'
})
const POLICY_FIELDS = Object.freeze([
  'contractVersion',
  'hideUnlisted',
  'visibleChannelIds',
  'userManageableChannelIds',
  'allowedChannelIds',
  'policyHash',
  'requiredClientCapabilities'
])
const POLICY_FIELD_SET = new Set(POLICY_FIELDS)
const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const CAPABILITY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const POLICY_HASH_PATTERN = /^[a-f0-9]{64}$/
const MAX_CHANNEL_IDS = 64
const MAX_CLIENT_CAPABILITIES = 32

class MessagingChannelPolicyError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MessagingChannelPolicyError'
    this.code = code
  }
}

function policyError(code, message) {
  return new MessagingChannelPolicyError(code, message)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizedIdentifiers(value, { field, maximum, pattern }) {
  if (!Array.isArray(value)) {
    throw policyError('policy_array_invalid', `${field} must be an array.`)
  }
  if (value.length > maximum) {
    throw policyError('policy_array_too_large', `${field} exceeds its contract limit.`)
  }

  const seen = new Set()
  const result = []
  for (const item of value) {
    if (typeof item !== 'string' || !pattern.test(item) || seen.has(item)) {
      throw policyError('policy_identifier_invalid', `${field} contains an invalid or duplicate identifier.`)
    }
    seen.add(item)
    result.push(item)
  }

  return result.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function canonicalPolicyPayload(policy) {
  return {
    contractVersion: policy.contractVersion,
    hideUnlisted: policy.hideUnlisted,
    visibleChannelIds: [...policy.visibleChannelIds].sort(),
    userManageableChannelIds: [...policy.userManageableChannelIds].sort(),
    allowedChannelIds: [...policy.allowedChannelIds].sort(),
    requiredClientCapabilities: [...policy.requiredClientCapabilities].sort()
  }
}

function computeMessagingChannelPolicyHash(policy) {
  const payload = JSON.stringify(canonicalPolicyPayload(policy))

  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex')
}

function parseMessagingChannelPolicy(value) {
  if (!isRecord(value)) {
    throw policyError('policy_missing', 'The managed messaging channel policy is missing.')
  }

  const keys = Object.keys(value)
  if (keys.length !== POLICY_FIELDS.length || keys.some(key => !POLICY_FIELD_SET.has(key))) {
    throw policyError('policy_fields_invalid', 'The messaging channel policy has missing or unknown fields.')
  }
  if (value.contractVersion !== MESSAGING_CHANNEL_POLICY_VERSION) {
    throw policyError('policy_contract_version_unknown', 'The messaging channel policy version is unsupported.')
  }
  if (typeof value.hideUnlisted !== 'boolean') {
    throw policyError('policy_hide_unlisted_invalid', 'hideUnlisted must be a boolean.')
  }

  const policy = {
    contractVersion: value.contractVersion,
    hideUnlisted: value.hideUnlisted,
    visibleChannelIds: normalizedIdentifiers(value.visibleChannelIds, {
      field: 'visibleChannelIds',
      maximum: MAX_CHANNEL_IDS,
      pattern: CHANNEL_ID_PATTERN
    }),
    userManageableChannelIds: normalizedIdentifiers(value.userManageableChannelIds, {
      field: 'userManageableChannelIds',
      maximum: MAX_CHANNEL_IDS,
      pattern: CHANNEL_ID_PATTERN
    }),
    allowedChannelIds: normalizedIdentifiers(value.allowedChannelIds, {
      field: 'allowedChannelIds',
      maximum: MAX_CHANNEL_IDS,
      pattern: CHANNEL_ID_PATTERN
    }),
    policyHash: typeof value.policyHash === 'string' ? value.policyHash : '',
    requiredClientCapabilities: normalizedIdentifiers(value.requiredClientCapabilities, {
      field: 'requiredClientCapabilities',
      maximum: MAX_CLIENT_CAPABILITIES,
      pattern: CAPABILITY_ID_PATTERN
    })
  }
  const visible = new Set(policy.visibleChannelIds)
  if (policy.userManageableChannelIds.some(channelId => !visible.has(channelId))) {
    throw policyError('policy_manageable_channel_not_visible', 'User-manageable channels must be visible.')
  }
  if (policy.allowedChannelIds.some(channelId => !visible.has(channelId))) {
    throw policyError('policy_allowed_channel_not_visible', 'Allowed channels must be visible.')
  }
  if (!policy.requiredClientCapabilities.includes(MESSAGING_CHANNEL_POLICY_VERSION)) {
    throw policyError('policy_required_capability_missing', 'The policy must require the v1 Desktop capability.')
  }
  if (!POLICY_HASH_PATTERN.test(policy.policyHash)) {
    throw policyError('policy_hash_invalid', 'The messaging channel policy hash is malformed.')
  }

  const expectedHash = computeMessagingChannelPolicyHash(policy)
  const suppliedHash = Buffer.from(policy.policyHash, 'ascii')
  const expectedHashBytes = Buffer.from(expectedHash, 'ascii')
  if (suppliedHash.length !== expectedHashBytes.length || !crypto.timingSafeEqual(suppliedHash, expectedHashBytes)) {
    throw policyError('policy_hash_mismatch', 'The messaging channel policy hash does not match its canonical payload.')
  }

  return policy
}

function fullCatalogDecision() {
  return {
    mode: 'unmanaged',
    status: 'full-catalog',
    reason: null,
    policy: null,
    hideUnlisted: false,
    visibleChannelIds: null,
    userManageableChannelIds: null,
    allowedChannelIds: null
  }
}

function failClosedDecision(reason) {
  return {
    mode: 'managed',
    status: 'fail-closed',
    reason,
    policy: null,
    hideUnlisted: true,
    visibleChannelIds: [],
    userManageableChannelIds: [],
    allowedChannelIds: []
  }
}

function appliedDecision(policy) {
  return {
    mode: 'managed',
    status: 'applied',
    reason: null,
    policy,
    hideUnlisted: policy.hideUnlisted,
    visibleChannelIds: policy.visibleChannelIds,
    userManageableChannelIds: policy.userManageableChannelIds,
    allowedChannelIds: policy.allowedChannelIds
  }
}

function resolveMessagingChannelPolicy({
  bootstrap = null,
  clientCapabilities = MESSAGING_CHANNEL_POLICY_CAPABILITIES,
  manifest = null,
  mode = null,
  requireDualSnapshot = true
} = {}) {
  const hasBootstrapDocument = isRecord(bootstrap)
  const hasManifestDocument = isRecord(manifest)
  const explicitModes = [mode, bootstrap?.mode, manifest?.mode].filter(value => value !== null && value !== undefined)
  if (explicitModes.some(value => value !== 'managed' && value !== 'unmanaged')) {
    return failClosedDecision('mode_unknown')
  }
  if (explicitModes.includes('managed') && explicitModes.includes('unmanaged')) {
    return failClosedDecision('policy_mode_mismatch')
  }

  const effectiveMode = explicitModes[0] || 'managed'
  if (effectiveMode === 'unmanaged') {
    return fullCatalogDecision()
  }

  const bootstrapSource = bootstrap?.messagingChannelPolicy
  const manifestSource = manifest?.messagingChannelPolicy
  if (requireDualSnapshot &&
      (!hasBootstrapDocument || !hasManifestDocument || !bootstrapSource || !manifestSource)) {
    return failClosedDecision('policy_snapshot_incomplete')
  }
  if (!bootstrapSource && !manifestSource) {
    return failClosedDecision('policy_missing')
  }

  let bootstrapPolicy = null
  let manifestPolicy = null
  try {
    if (bootstrapSource) bootstrapPolicy = parseMessagingChannelPolicy(bootstrapSource)
    if (manifestSource) manifestPolicy = parseMessagingChannelPolicy(manifestSource)
  } catch (error) {
    return failClosedDecision(error instanceof MessagingChannelPolicyError ? error.code : 'policy_invalid')
  }

  if (bootstrapPolicy && manifestPolicy && bootstrapPolicy.policyHash !== manifestPolicy.policyHash) {
    return failClosedDecision('policy_snapshot_mismatch')
  }

  const policy = manifestPolicy || bootstrapPolicy
  const capabilities = Array.isArray(clientCapabilities)
    ? new Set(clientCapabilities.filter(capability => typeof capability === 'string'))
    : new Set()
  if (policy.requiredClientCapabilities.some(capability => !capabilities.has(capability))) {
    return failClosedDecision('client_capability_missing')
  }

  return appliedDecision(policy)
}

module.exports = {
  MAX_CHANNEL_IDS,
  MAX_CLIENT_CAPABILITIES,
  MESSAGING_CHANNEL_POLICY_CAPABILITIES,
  MESSAGING_CHANNEL_POLICY_VERSION,
  MESSAGING_CHANNEL_SOURCE_BY_SURFACE,
  MessagingChannelPolicyError,
  computeMessagingChannelPolicyHash,
  parseMessagingChannelPolicy,
  resolveMessagingChannelPolicy
}
