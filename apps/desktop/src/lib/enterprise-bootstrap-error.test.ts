import { describe, expect, it } from 'vitest'

import bootstrapErrors from '../../electron/enterprise-bootstrap-public-errors.json'

import { enterprisePublicErrorFromUnknown } from './enterprise-bootstrap-error'

function envelope(
  errorCode: string,
  recoveryKind: string,
  httpStatus: number | null = null,
  message = 'safe'
) {
  return {
    envelope: 'enterprise-public-error.v1',
    errorCode,
    httpStatus,
    lifecycleEpoch: 4,
    message,
    recoveryKind
  }
}

describe('enterprise bootstrap public error contract', () => {
  it('consumes every shared bootstrap mapping and rejects forged recovery actions', () => {
    for (const [errorCode, contract] of Object.entries(bootstrapErrors)) {
      const httpStatus = contract.httpStatuses[0]
      expect(enterprisePublicErrorFromUnknown(
        envelope(errorCode, contract.recoveryKind, httpStatus, contract.message)
      )?.errorCode).toBe(errorCode)
      for (const forged of ['sign-in', 'refresh-policy', 'retry', 'retry-stop', 'upgrade']) {
        if (forged !== contract.recoveryKind) {
          expect(enterprisePublicErrorFromUnknown(
            envelope(errorCode, forged, httpStatus, contract.message)
          )).toBeNull()
        }
      }
    }
  })

  it('rejects unknown codes, unsafe messages, invalid status, and invalid epochs', () => {
    const contract = bootstrapErrors.enterprise_gateway_contract_too_old
    const valid = envelope(
      'enterprise_gateway_contract_too_old',
      contract.recoveryKind,
      null,
      contract.message
    )
    expect(enterprisePublicErrorFromUnknown({ ...valid, errorCode: 'hostile-code' })).toBeNull()
    expect(enterprisePublicErrorFromUnknown({ ...valid, message: 'dsk_secret raw payload' })).toBeNull()
    expect(enterprisePublicErrorFromUnknown({ ...valid, httpStatus: 403 })).toBeNull()
    expect(enterprisePublicErrorFromUnknown({ ...valid, httpStatus: 999 })).toBeNull()
    expect(enterprisePublicErrorFromUnknown({ ...valid, lifecycleEpoch: -1 })).toBeNull()
    expect(enterprisePublicErrorFromUnknown({ ...valid, lifecycleEpoch: '4' })).toBeNull()
  })

  it('accepts retry-stop only for the normalized runtime stop failure', () => {
    const message = RUNTIME_STOP_MESSAGE
    expect(enterprisePublicErrorFromUnknown(
      envelope('enterprise_runtime_stop_failed', 'retry-stop', null, message)
    )).not.toBeNull()
    expect(enterprisePublicErrorFromUnknown(
      envelope('enterprise_runtime_stop_failed', 'retry', null, message)
    )).toBeNull()
    expect(enterprisePublicErrorFromUnknown(
      envelope('enterprise_runtime_stop_failed', 'retry-stop', 403, message)
    )).toBeNull()
  })
})

const RUNTIME_STOP_MESSAGE = 'Hermes could not stop safely. Retry the stop before continuing.'
