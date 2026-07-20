const REDACTED = '[REDACTED]'

const ENTERPRISE_TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const ENTERPRISE_MANAGED_RENDERER_ARGUMENT = '--hermes-enterprise-managed=1'
const SECRET_TOKEN_RE = /\b(?:(?:gw_|adm_|dsk_)[A-Za-z0-9._~-]+|sk-[A-Za-z0-9._~-]+)/
const SENSITIVE_ENV_TEXT_RE = new RegExp(
  String.raw`(?:^|[\r\n\s"'\x60])(?:COMPANY_GATEWAY_TOKEN|HERMES_DASHBOARD_SESSION_TOKEN|DESKTOP_TOKEN|[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL))\s*[:=]\s*\S+`,
  'i'
)
const SENSITIVE_ENV_ASSIGNMENT_RE = new RegExp(
  String.raw`(^|[\r\n\s"'\x60])((?:COMPANY_GATEWAY_TOKEN|HERMES_DASHBOARD_SESSION_TOKEN|DESKTOP_TOKEN|[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL))\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)`,
  'gim'
)

// Keep this decision independent from renderer/user preferences. Once the
// desktop is launched for an enterprise runtime, ordinary UI configuration
// must not be able to turn output redaction off.
function isEnterpriseManagedEnv(env = process.env) {
  const explicitManaged = ENTERPRISE_TRUTHY.has(
    String(env.HERMES_ENTERPRISE_MANAGED || '')
      .trim()
      .toLowerCase()
  )
  const enterpriseDesktop = String(env.HERMES_ENTERPRISE_DESKTOP || '').trim() === '1'
  const gatewayUrl = String(env.HERMES_ENTERPRISE_GATEWAY_URL || env.HERMES_DESKTOP_ENTERPRISE_GATEWAY_URL || '').trim()

  return explicitManaged || enterpriseDesktop || gatewayUrl.length > 0
}

function isEnterpriseManagedRenderer(argv = process.argv, env = process.env) {
  return argv.includes(ENTERPRISE_MANAGED_RENDERER_ARGUMENT) || isEnterpriseManagedEnv(env)
}

function decodedLooksSensitive(decoded) {
  return SECRET_TOKEN_RE.test(decoded) || SENSITIVE_ENV_TEXT_RE.test(decoded)
}

function decodeUtf8(buffer) {
  const decoded = buffer.toString('utf8')

  return decoded.includes('\uFFFD') ? null : decoded
}

function decodeBase64Once(encoded) {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')

  if (normalized.length % 4 === 1) return null

  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const buffer = Buffer.from(padded, 'base64')
  const canonical = buffer.toString('base64').replace(/=+$/, '')

  return canonical === normalized ? decodeUtf8(buffer) : null
}

function redactEncodedSecrets(text) {
  let redacted = text.replace(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{16,}={0,2}(?![A-Za-z0-9+/_=-])/g, encoded => {
    const decoded = decodeBase64Once(encoded)

    return decoded && decodedLooksSensitive(decoded) ? REDACTED : encoded
  })

  redacted = redacted.replace(/(?<![A-Fa-f0-9])[A-Fa-f0-9]{24,}(?![A-Fa-f0-9])/g, encoded => {
    if (encoded.length % 2 !== 0) return encoded
    const decoded = decodeUtf8(Buffer.from(encoded, 'hex'))

    return decoded && decodedLooksSensitive(decoded) ? REDACTED : encoded
  })

  return redacted.replace(/(?<!%[A-Fa-f0-9]{2})(?:%[A-Fa-f0-9]{2}){8,}/g, encoded => {
    let decoded

    try {
      decoded = decodeURIComponent(encoded)
    } catch {
      return encoded
    }

    return decodedLooksSensitive(decoded) ? REDACTED : encoded
  })
}

function redactSensitiveText(value) {
  let text = String(value ?? '')

  text = redactEncodedSecrets(text)

  // Provider/runtime tokens used by the managed desktop and common provider
  // keys. Delimiters are intentionally excluded so surrounding diagnostics
  // remain useful.
  text = text.replace(/\b(?:gw_|adm_|dsk_)[A-Za-z0-9._~-]+/g, REDACTED)
  text = text.replace(/\bsk-[A-Za-z0-9._~-]+/g, REDACTED)

  text = text.replace(SENSITIVE_ENV_ASSIGNMENT_RE, (_match, prefix, key) => `${prefix}${key}${REDACTED}`)

  // URL/query-shaped credentials can be opaque and therefore need key-based
  // detection. This works both for standalone URLs and URLs embedded in logs.
  text = text.replace(
    /([?&](?:access[_-]?token|token|api[_-]?key|apikey|secret|credential)=)[^&#\s]+/gi,
    `$1${REDACTED}`
  )

  // Header/error text is another common route into desktop.log and toasts.
  text = text.replace(/(\bAuthorization\s*:\s*Bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)

  return text
}

function redactManagedText(value, managed = isEnterpriseManagedEnv()) {
  return managed ? redactSensitiveText(value) : String(value ?? '')
}

module.exports = {
  ENTERPRISE_MANAGED_RENDERER_ARGUMENT,
  REDACTED,
  isEnterpriseManagedEnv,
  isEnterpriseManagedRenderer,
  redactEncodedSecrets,
  redactManagedText,
  redactSensitiveText
}
