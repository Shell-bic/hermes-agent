const { redactManagedText } = require('./managed-redaction.cjs')
const BOOTSTRAP_PUBLIC_ERRORS = require('./enterprise-bootstrap-public-errors.json')

const PUBLIC_ERROR_ENVELOPE = 'enterprise-public-error.v1'
const PUBLIC_RESULT_ENVELOPE = 'enterprise-public-result.v1'
const RECOVERY_KINDS = new Set([
  'none',
  'refresh-policy',
  'restart',
  'retry',
  'retry-stop',
  'sign-in',
  'upgrade',
  'wait'
])
const PUBLIC_ERROR_CODES = new Set([
  ...Object.keys(BOOTSTRAP_PUBLIC_ERRORS),
  'artifact_body_missing',
  'artifact_hash_mismatch',
  'artifact_length_mismatch',
  'artifact_length_missing',
  'artifact_metadata_invalid',
  'artifact_too_large',
  'client_operation_id_conflict',
  'desktop_active_role_required',
  'desktop_session_required',
  'enterprise_lifecycle_effect_denied',
  'enterprise_lifecycle_ipc_denied',
  'enterprise_operation_superseded',
  'enterprise_profile_not_managed',
  'enterprise_runtime_access_unavailable',
  'enterprise_runtime_stop_failed',
  'enterprise_skill_download_failed',
  'enterprise_skill_hub_disabled',
  'enterprise_skill_hub_untrusted_renderer',
  'enterprise_skill_install_busy',
  'enterprise_skill_install_failed',
  'enterprise_skill_install_recovery_failed',
  'enterprise_skill_install_recovery_unavailable',
  'enterprise_managed_user_invalid',
  'enterprise_untrusted_renderer',
  'gateway-offline',
  'gateway-timeout',
  'install_operation_reconciling',
  'install_operation_binding_mismatch',
  'install_operation_abort_unconfirmed',
  'install_operation_content_changed',
  'install_operation_content_mismatch',
  'install_operation_journal_invalid',
  'install_operation_not_authorized',
  'install_operation_not_found',
  'install_operation_expired',
  'install_operation_pending_limit',
  'install_operation_reconciliation_invalid',
  'install_operation_receipt_expired',
  'install_operation_receipt_invalid',
  'install_operation_receipt_required',
  'install_operation_response_invalid',
  'install_operation_target_invalid',
  'install_operation_user_mismatch',
  'local_backend_unavailable',
  'local_backend_request_failed',
  'local_install_response_invalid',
  'local_stage_response_invalid',
  'package_revision_changed',
  'request-canceled',
  'skill_name_conflict',
  'skill_install_receipt_ineligible',
  'skill_install_receipt_recovery_expired',
  'skill_install_receipt_unavailable',
  'skill_policy_denied',
  'skills_manage_required',
  'install_policy_changed',
  'update_not_supported'
])

const SAFE_MESSAGES = Object.freeze({
  ...Object.fromEntries(Object.entries(BOOTSTRAP_PUBLIC_ERRORS).map(([code, value]) => [code, value.message])),
  enterprise_lifecycle_effect_denied: 'Enterprise access changed while the operation was running.',
  enterprise_lifecycle_ipc_denied: 'Enterprise policy does not allow this operation right now.',
  enterprise_operation_superseded: 'Enterprise access changed while the operation was running.',
  enterprise_runtime_stop_failed: 'Hermes could not stop safely. Retry the stop before continuing.',
  desktop_active_role_required: 'Contact an administrator to assign an active enterprise role.',
  desktop_session_required: 'Sign in to your enterprise account and try again.',
  request_canceled: 'The operation was canceled because enterprise access changed.',
  'request-canceled': 'The operation was canceled because enterprise access changed.',
  enterprise_managed_user_invalid: 'The managed enterprise user identity is invalid.',
  enterprise_skill_install_recovery_failed: 'The enterprise skill installation could not be recovered safely.',
  enterprise_skill_install_recovery_unavailable: 'Secure enterprise skill recovery is unavailable.',
  install_operation_binding_mismatch: 'The enterprise skill authorization no longer matches this operation.',
  install_operation_abort_unconfirmed: 'Hermes could not confirm that the enterprise skill target is absent.',
  install_operation_content_changed: 'The staged enterprise skill content changed before installation completed.',
  install_operation_content_mismatch: 'The enterprise skill content does not match its authorization.',
  install_operation_journal_invalid: 'The local enterprise skill recovery record is invalid.',
  install_operation_not_authorized: 'The enterprise skill operation is not authorized for installation.',
  install_operation_not_found: 'The enterprise skill operation no longer exists.',
  install_operation_expired: 'The enterprise skill operation expired before installation completed.',
  install_operation_pending_limit: 'Too many enterprise skill installations are pending. Wait before retrying.',
  install_operation_reconciliation_invalid: 'The enterprise skill recovery state is invalid.',
  install_operation_receipt_expired: 'The enterprise skill installation receipt expired.',
  install_operation_receipt_invalid: 'The enterprise skill installation receipt is invalid.',
  install_operation_receipt_required: 'A signed enterprise skill installation receipt is required.',
  install_operation_response_invalid: 'The enterprise Gateway returned an invalid install operation.',
  install_operation_target_invalid: 'The local enterprise skill target is invalid.',
  install_operation_user_mismatch: 'The enterprise skill operation belongs to a different managed user.',
  install_operation_reconciling: 'The enterprise skill installation is being safely reconciled.',
  local_stage_response_invalid: 'The local enterprise skill staging result is invalid.',
  client_operation_id_conflict: 'The enterprise skill operation conflicts with an existing request.',
  install_policy_changed: 'Enterprise policy changed while this skill was being installed.',
  skill_install_receipt_ineligible: 'This enterprise skill operation cannot receive an installation receipt.',
  skill_install_receipt_recovery_expired: 'The enterprise skill receipt recovery window expired.',
  skill_install_receipt_unavailable: 'The enterprise Gateway could not issue an installation receipt.',
  skill_name_conflict: 'A local skill conflicts with this enterprise skill.',
  skill_policy_denied: 'Enterprise policy does not allow this skill to be installed.',
  skills_manage_required: 'Contact an administrator to grant enterprise skill management access.',
  update_not_supported: 'This enterprise skill cannot be updated by the current Desktop version.'
})

function normalizedCode(error) {
  const value = String(error?.errorCode || error?.code || 'enterprise_operation_failed')
    .trim()
    .toLowerCase()
  return PUBLIC_ERROR_CODES.has(value) ? value : 'enterprise_operation_failed'
}

function normalizedStatus(error) {
  const value = Number(error?.httpStatus ?? error?.status ?? error?.statusCode)
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
}

function validHttpStatus(value) {
  return value === null || (Number.isInteger(value) && value >= 100 && value <= 599)
}

function deterministicRecoveryKind(code, status) {
  if (code === 'enterprise_runtime_stop_failed') return 'retry-stop'
  if (BOOTSTRAP_PUBLIC_ERRORS[code]) return BOOTSTRAP_PUBLIC_ERRORS[code].recoveryKind
  if (
    code === 'enterprise_skill_hub_untrusted_renderer' ||
    code === 'enterprise_skill_hub_disabled' ||
    code === 'enterprise_runtime_access_unavailable' ||
    code === 'enterprise_profile_not_managed' ||
    code === 'enterprise_untrusted_renderer' ||
    code === 'request-canceled' ||
    code === 'enterprise_operation_superseded' ||
    code === 'local_backend_request_failed'
  ) return 'none'
  if (status === 401 || code === 'desktop_session_required') return 'sign-in'
  if (status === 426) return 'upgrade'
  if (code === 'install_operation_reconciling' || code === 'install_operation_pending_limit') return 'wait'
  if (
    status === 403 ||
    code === 'desktop_active_role_required' ||
    code === 'skills_manage_required' ||
    code === 'skill_policy_denied' ||
    code === 'install_policy_changed'
  ) return 'refresh-policy'
  if (
    code === 'install_operation_expired' ||
    code === 'skill_install_receipt_recovery_expired' ||
    code === 'skill_install_receipt_unavailable'
  ) return 'retry'
  if (status >= 500 || code === 'gateway-offline' || code === 'gateway-timeout') return 'retry'
  return null
}

function recoveryKindFor({ code, lifecycleState, maintenancePhase, status }) {
  if (code === 'enterprise_runtime_stop_failed' || lifecycleState === 'stop_failed') return 'retry-stop'
  if (BOOTSTRAP_PUBLIC_ERRORS[code]) return BOOTSTRAP_PUBLIC_ERRORS[code].recoveryKind
  if (
    code === 'enterprise_skill_hub_untrusted_renderer' ||
    code === 'enterprise_skill_hub_disabled' ||
    code === 'enterprise_runtime_access_unavailable' ||
    code === 'enterprise_profile_not_managed' ||
    code === 'enterprise_untrusted_renderer' ||
    code === 'request-canceled' ||
    code === 'enterprise_operation_superseded' ||
    code === 'local_backend_request_failed'
  )
    return 'none'
  if (maintenancePhase === 'active' || maintenancePhase === 'held') return 'wait'
  if (lifecycleState === 'unauthenticated' || status === 401 || code === 'desktop_session_required') return 'sign-in'
  if (status === 426) return 'upgrade'
  if (code === 'install_operation_reconciling' || code === 'install_operation_pending_limit') return 'wait'
  if (
    lifecycleState === 'blocked' ||
    status === 403 ||
    code === 'desktop_active_role_required' ||
    code === 'skills_manage_required' ||
    code === 'skill_policy_denied' ||
    code === 'install_policy_changed'
  ) return 'refresh-policy'
  if (
    code === 'install_operation_expired' ||
    code === 'skill_install_receipt_recovery_expired' ||
    code === 'skill_install_receipt_unavailable'
  ) return 'retry'
  if (status >= 500 || code === 'gateway-offline' || code === 'gateway-timeout') return 'retry'
  return 'none'
}

function safeMessage({ code, lifecycleState, recoveryKind, status }) {
  if (SAFE_MESSAGES[code]) return SAFE_MESSAGES[code]
  if (lifecycleState === 'stop_failed') return 'Hermes could not stop safely. Retry the stop before continuing.'
  if (recoveryKind === 'sign-in') return 'Sign in to your enterprise account and try again.'
  if (recoveryKind === 'upgrade') return 'Update Hermes Desktop before continuing.'
  if (recoveryKind === 'wait') return 'Hermes maintenance is still in progress. Wait before retrying.'
  if (recoveryKind === 'retry-stop') return 'Hermes could not stop safely. Retry the stop before continuing.'
  if (recoveryKind === 'restart') return 'Restart Hermes Desktop before continuing.'
  if (recoveryKind === 'refresh-policy') return 'Enterprise policy does not allow this operation right now.'
  if (status && status >= 500) return 'The enterprise service is temporarily unavailable. Try again.'
  return 'The enterprise operation failed. Try again.'
}

function createEnterprisePublicError(error, options = {}) {
  const lifecycle = options.lifecycle || null
  const lifecycleState = String(lifecycle?.state || options.lifecycleState || '')
  const originalCode = normalizedCode(error)
  const code = lifecycleState === 'stop_failed' ? 'enterprise_runtime_stop_failed' : originalCode
  const status = normalizedStatus(error)
  const maintenancePhase = String(options.maintenancePhase || '')
  const recoveryKind = recoveryKindFor({ code, lifecycleState, maintenancePhase, status })
  const lifecycleEpoch = resolveLifecycleEpoch(error, options, lifecycle)

  return Object.freeze({
    envelope: PUBLIC_ERROR_ENVELOPE,
    errorCode: code,
    httpStatus: status,
    lifecycleEpoch,
    message: redactManagedText(safeMessage({ code, lifecycleState, recoveryKind, status }), true),
    recoveryKind
  })
}

function resolveLifecycleEpoch(error, options, lifecycle) {
  if (options.useCurrentEpoch === true && Number.isSafeInteger(lifecycle?.lifecycleEpoch)) {
    return lifecycle.lifecycleEpoch
  }
  for (const value of [
    options.operationEpoch,
    error?.lifecycleEpoch,
    lifecycle?.lifecycleEpoch,
    options.lifecycleEpoch
  ]) {
    if (Number.isSafeInteger(value) && value >= 0) return value
  }
  return 0
}

function enterprisePublicResult(value) {
  return Object.freeze({ envelope: PUBLIC_RESULT_ENVELOPE, ok: true, value })
}

function enterprisePublicFailure(error) {
  return Object.freeze({ envelope: PUBLIC_RESULT_ENVELOPE, error, ok: false })
}

function unwrapEnterprisePublicError(value) {
  const expectedRecoveryKind = deterministicRecoveryKind(value?.errorCode, value?.httpStatus)
  if (
    value?.envelope !== PUBLIC_ERROR_ENVELOPE ||
    (!PUBLIC_ERROR_CODES.has(value.errorCode) && value.errorCode !== 'enterprise_operation_failed') ||
    !RECOVERY_KINDS.has(value.recoveryKind) ||
    !Number.isSafeInteger(value.lifecycleEpoch) || value.lifecycleEpoch < 0 ||
    !validHttpStatus(value.httpStatus) ||
    typeof value.message !== 'string' ||
    (expectedRecoveryKind !== null && value.recoveryKind !== expectedRecoveryKind)
  ) {
    const malformed = new Error('The enterprise operation failed.')
    malformed.code = 'enterprise_operation_failed'
    malformed.errorCode = 'enterprise_operation_failed'
    malformed.httpStatus = null
    malformed.lifecycleEpoch = 0
    malformed.recoveryKind = 'none'
    malformed.status = null
    throw malformed
  }
  const error = new Error(safeMessage({
    code: value.errorCode,
    lifecycleState: '',
    recoveryKind: value.recoveryKind,
    status: value.httpStatus
  }))
  error.envelope = PUBLIC_ERROR_ENVELOPE
  error.code = value.errorCode
  error.errorCode = value.errorCode
  error.httpStatus = value.httpStatus
  error.lifecycleEpoch = value.lifecycleEpoch
  error.recoveryKind = value.recoveryKind
  error.status = value.httpStatus
  throw error
}

function unwrapEnterprisePublicResult(value) {
  if (value?.envelope !== PUBLIC_RESULT_ENVELOPE || typeof value.ok !== 'boolean') {
    return unwrapEnterprisePublicError(null)
  }
  if (value.ok === true) return value.value
  return unwrapEnterprisePublicError(value.error)
}

module.exports = {
  createEnterprisePublicError,
  enterprisePublicFailure,
  enterprisePublicResult,
  PUBLIC_ERROR_ENVELOPE,
  PUBLIC_RESULT_ENVELOPE,
  deterministicRecoveryKind,
  recoveryKindFor,
  unwrapEnterprisePublicError,
  unwrapEnterprisePublicResult
}
