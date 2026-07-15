const BOT_TRANSACTION_VERSION = 'wecom-bot-transaction.v1'
const BOT_BINDING_VERSION = 'wecom-bot-binding.v1'
const MESSAGING_CHANNEL_POLICY_CAPABILITY = 'messaging-channel-policy.v1'
const MAX_CAPABILITIES = 32
const MAX_AUTHORIZATION_URL_LENGTH = 2048
const MAX_DISPLAY_NAME_LENGTH = 128
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const BOT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RFC3339_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/
const TRANSACTION_STATUSES = new Set(['pending', 'authorized', 'redeeming', 'completed', 'denied', 'expired', 'canceled', 'error'])
const BINDING_STATUSES = new Set(['pending-owner-verification', 'connecting', 'connected', 'disconnected', 'suspended', 'revoked'])
const CONNECTION_STATUSES = new Set(['offline', 'connecting', 'online', 'error'])

class WeComPersonalBotContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WeComPersonalBotContractError'
    this.code = code
  }
}

function invalid(code, message) {
  throw new WeComPersonalBotContractError(code, message)
}

function requireExactFields(value, fields, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code, 'The contract value must be an object.')
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    invalid(code, 'The contract has missing or unknown fields.')
  }
}

function validateCapabilities(value, missingCode) {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) invalid('transaction_request_capabilities_invalid', 'Client capabilities are invalid.')
  const seen = new Set()
  for (const capability of value) {
    if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability) || seen.has(capability)) {
      invalid('transaction_request_capabilities_invalid', 'Client capabilities are invalid.')
    }
    seen.add(capability)
  }
  if (!seen.has(MESSAGING_CHANNEL_POLICY_CAPABILITY)) invalid(missingCode, 'The messaging policy capability is required.')
}

function validateCreateWeComBotTransactionRequest(value) {
  requireExactFields(value, ['contractVersion', 'clientCapabilities'], 'transaction_request_fields_invalid')
  if (value.contractVersion !== BOT_TRANSACTION_VERSION) invalid('transaction_request_contract_version_unknown', 'The transaction request version is unsupported.')
  validateCapabilities(value.clientCapabilities, 'transaction_request_capability_missing')
  return value
}

function parseRfc3339DateTime(value) {
  if (typeof value !== 'string') return null
  const match = RFC3339_DATE_TIME_PATTERN.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const fractionMilliseconds = Number((match[7] || '').slice(0, 3).padEnd(3, '0'))
  const offsetHour = match[8].toLowerCase() === 'z' ? 0 : Number(match[10])
  const offsetMinute = match[8].toLowerCase() === 'z' ? 0 : Number(match[11])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return null
  }

  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, fractionMilliseconds)
  const offsetSign = match[8].toLowerCase() === 'z' || match[9] === '+' ? 1 : -1
  const offsetMilliseconds = offsetSign * ((offsetHour * 60) + offsetMinute) * 60_000
  return date.getTime() - offsetMilliseconds
}

function validOptionalErrorCode(value) {
  return value === null || (typeof value === 'string' && ERROR_CODE_PATTERN.test(value))
}

function safeAuthorizationUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_AUTHORIZATION_URL_LENGTH) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password
  } catch {
    return false
  }
}

function validateWeComBotTransaction(value) {
  requireExactFields(value, ['contractVersion', 'transactionId', 'status', 'authorizationUrl', 'expiresAt', 'errorCode'], 'transaction_fields_invalid')
  if (value.contractVersion !== BOT_TRANSACTION_VERSION) invalid('transaction_contract_version_unknown', 'The transaction version is unsupported.')
  if (typeof value.transactionId !== 'string' || !UUID_PATTERN.test(value.transactionId) || !TRANSACTION_STATUSES.has(value.status)) {
    invalid('transaction_status_invalid', 'The transaction id or status is invalid.')
  }
  if ((value.status === 'pending' && value.authorizationUrl === null) ||
      (value.authorizationUrl !== null && !safeAuthorizationUrl(value.authorizationUrl))) {
    invalid('transaction_authorization_url_invalid', 'The authorization URL must be safe HTTPS.')
  }
  if (parseRfc3339DateTime(value.expiresAt) === null || !validOptionalErrorCode(value.errorCode)) invalid('transaction_fields_invalid', 'The transaction metadata is invalid.')
  return value
}

function validateWeComBotBinding(value) {
  requireExactFields(value, [
    'contractVersion', 'bindingId', 'botId', 'displayName', 'status', 'connectionStatus',
    'ownerVerificationRequired', 'createdAt', 'updatedAt', 'lastConnectedAt', 'errorCode'
  ], 'binding_fields_invalid')
  if (value.contractVersion !== BOT_BINDING_VERSION) invalid('binding_contract_version_unknown', 'The binding version is unsupported.')
  if (typeof value.bindingId !== 'string' || !UUID_PATTERN.test(value.bindingId) || typeof value.botId !== 'string' || !BOT_ID_PATTERN.test(value.botId)) {
    invalid('binding_identity_invalid', 'The binding id or bot id is invalid.')
  }
  if (value.displayName !== null && (typeof value.displayName !== 'string' || value.displayName.length > MAX_DISPLAY_NAME_LENGTH)) {
    invalid('binding_display_name_invalid', 'The binding display name exceeds its contract limit.')
  }
  if (!BINDING_STATUSES.has(value.status) || !CONNECTION_STATUSES.has(value.connectionStatus)) invalid('binding_status_invalid', 'The binding status is invalid.')
  if (typeof value.ownerVerificationRequired !== 'boolean') invalid('binding_fields_invalid', 'Owner verification must be a boolean.')
  if (value.status === 'pending-owner-verification' && !value.ownerVerificationRequired) invalid('binding_owner_verification_invalid', 'A pending binding requires owner verification.')
  if (value.status === 'connected' && (value.ownerVerificationRequired || value.connectionStatus !== 'online')) invalid('binding_connected_state_invalid', 'A connected binding must be verified and online.')
  const createdAt = parseRfc3339DateTime(value.createdAt)
  const updatedAt = parseRfc3339DateTime(value.updatedAt)
  const lastConnectedAt = value.lastConnectedAt === null ? null : parseRfc3339DateTime(value.lastConnectedAt)
  if (createdAt === null || updatedAt === null || updatedAt < createdAt ||
      (value.lastConnectedAt !== null && lastConnectedAt === null) || !validOptionalErrorCode(value.errorCode)) {
    invalid('binding_fields_invalid', 'The binding metadata is invalid.')
  }
  return value
}

module.exports = {
  BOT_BINDING_VERSION,
  BOT_TRANSACTION_VERSION,
  MAX_AUTHORIZATION_URL_LENGTH,
  MAX_CAPABILITIES,
  MAX_DISPLAY_NAME_LENGTH,
  MESSAGING_CHANNEL_POLICY_CAPABILITY,
  WeComPersonalBotContractError,
  parseRfc3339DateTime,
  validateCreateWeComBotTransactionRequest,
  validateWeComBotBinding,
  validateWeComBotTransaction
}
