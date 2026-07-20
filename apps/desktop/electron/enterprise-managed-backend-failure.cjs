const { createEnterprisePublicError } = require('./enterprise-public-error.cjs')

const FAILURE_CODES = Object.freeze({
  exit: 'enterprise_backend_exited',
  start: 'enterprise_backend_start_failed'
})

function errorFromEnterprisePublicError(enterpriseError) {
  const error = Object.assign(new Error(enterpriseError.message), enterpriseError)
  error.stack = `${error.name}: ${enterpriseError.message}`
  return error
}

function fixedManagedFailure(kind, lifecycle) {
  const normalizedKind = kind === 'start' ? 'start' : 'exit'
  const enterpriseError = createEnterprisePublicError(
    { code: FAILURE_CODES[normalizedKind] },
    { lifecycle, useCurrentEpoch: true }
  )
  const error = errorFromEnterprisePublicError(enterpriseError)

  return Object.freeze({
    bootUpdate: Object.freeze({
      enterpriseError,
      error: enterpriseError.message,
      message: enterpriseError.message,
      phase: 'backend.error',
      running: false
    }),
    enterpriseError,
    error,
    exitPayload: Object.freeze({
      code: null,
      signal: null,
      error: enterpriseError.message,
      enterpriseError
    }),
    logMessage: `[enterprise-backend] ${normalizedKind === 'start' ? 'start failed' : 'exited'}`
  })
}

function normalizeManagedBootProgress(update, { enabled, lifecycle } = {}) {
  if (!enabled || (update?.error == null && update?.phase !== 'backend.error')) return update

  const enterpriseError = createEnterprisePublicError(
    update.enterpriseError || { code: 'enterprise_operation_failed' },
    { lifecycle, useCurrentEpoch: true }
  )

  return {
    ...update,
    enterpriseError,
    error: enterpriseError.message,
    message: enterpriseError.message
  }
}

function normalizeManagedBackendExit(payload, { enabled, lifecycle } = {}) {
  if (!enabled) return payload

  const source = payload?.enterpriseError?.errorCode === FAILURE_CODES.start ? 'start' : 'exit'
  return fixedManagedFailure(source, lifecycle).exitPayload
}

module.exports = {
  errorFromEnterprisePublicError,
  FAILURE_CODES,
  fixedManagedFailure,
  normalizeManagedBackendExit,
  normalizeManagedBootProgress
}
