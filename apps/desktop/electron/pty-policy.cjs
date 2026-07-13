'use strict'

const ENTERPRISE_MANAGED_ENV = 'HERMES_ENTERPRISE_MANAGED'
const ENTERPRISE_MANAGED_PTY_ERROR = 'PTY disabled by enterprise managed policy.'
const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on'])

function isEnterpriseManaged(env = process.env) {
  return TRUTHY_VALUES.has(String(env?.[ENTERPRISE_MANAGED_ENV] || '').trim().toLowerCase())
}

function requirePtyAllowed(env = process.env) {
  if (!isEnterpriseManaged(env)) {
    return
  }

  const error = new Error(ENTERPRISE_MANAGED_PTY_ERROR)
  error.code = 'enterprise-managed-pty-disabled'
  throw error
}

module.exports = {
  ENTERPRISE_MANAGED_PTY_ERROR,
  isEnterpriseManaged,
  requirePtyAllowed
}
