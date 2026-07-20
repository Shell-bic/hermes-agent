import type { EnterprisePublicErrorEnvelope, EnterpriseRecoveryKind } from '@/global'

import bootstrapErrors from '../../electron/enterprise-bootstrap-public-errors.json'

const RECOVERY_KINDS = new Set<EnterpriseRecoveryKind>([
  'none',
  'refresh-policy',
  'restart',
  'retry',
  'retry-stop',
  'sign-in',
  'upgrade',
  'wait'
])

const RUNTIME_STOP_CONTRACT = Object.freeze({
  httpStatuses: [null],
  message: 'Hermes could not stop safely. Retry the stop before continuing.',
  recoveryKind: 'retry-stop'
})

function validStatus(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599)
}

export function enterprisePublicErrorFromUnknown(value: unknown): EnterprisePublicErrorEnvelope | null {
  const candidate = value as Partial<EnterprisePublicErrorEnvelope> | null

  if (
    candidate?.envelope !== 'enterprise-public-error.v1' ||
    typeof candidate.errorCode !== 'string' ||
    !validStatus(candidate.httpStatus) ||
    !Number.isSafeInteger(candidate.lifecycleEpoch) ||
    Number(candidate.lifecycleEpoch) < 0 ||
    typeof candidate.message !== 'string' ||
    !RECOVERY_KINDS.has(candidate.recoveryKind as EnterpriseRecoveryKind)
  ) {
    return null
  }

  const contract = candidate.errorCode === 'enterprise_runtime_stop_failed'
    ? RUNTIME_STOP_CONTRACT
    : bootstrapErrors[candidate.errorCode as keyof typeof bootstrapErrors]
  if (
    !contract ||
    candidate.recoveryKind !== contract.recoveryKind ||
    candidate.message !== contract.message ||
    !contract.httpStatuses.some(status => status === candidate.httpStatus)
  ) {
    return null
  }

  return {
    envelope: 'enterprise-public-error.v1',
    errorCode: candidate.errorCode,
    httpStatus: candidate.httpStatus,
    lifecycleEpoch: Number(candidate.lifecycleEpoch),
    message: contract.message,
    recoveryKind: contract.recoveryKind as EnterpriseRecoveryKind
  }
}
