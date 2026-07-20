const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createEnterprisePublicError,
  enterprisePublicFailure,
  enterprisePublicResult,
  unwrapEnterprisePublicResult
} = require('./enterprise-public-error.cjs')

test('public recovery kinds are a closed fail-closed mapping', () => {
  const cases = [
    [{ status: 401 }, { state: 'running' }, 'sign-in'],
    [{ status: 403 }, { state: 'running' }, 'refresh-policy'],
    [{ status: 426 }, { state: 'running' }, 'upgrade'],
    [{ code: 'anything' }, { state: 'stop_failed' }, 'retry-stop'],
    [{ code: 'gateway-offline' }, { state: 'running' }, 'retry'],
    [{ code: 'unclassified_internal_failure' }, { state: 'running' }, 'none']
  ]

  for (const [error, lifecycle, expected] of cases) {
    assert.equal(createEnterprisePublicError(error, { lifecycle }).recoveryKind, expected)
  }
  assert.equal(createEnterprisePublicError({}, { maintenancePhase: 'held' }).recoveryKind, 'wait')
})

test('public errors keep captured operation epoch unless this operation caused a terminal transition', () => {
  const lifecycle = { lifecycleEpoch: 9, state: 'blocked' }
  assert.equal(
    createEnterprisePublicError(
      { status: 403 },
      {
        lifecycle,
        operationEpoch: 4
      }
    ).lifecycleEpoch,
    4
  )
  assert.equal(
    createEnterprisePublicError(
      { status: 403 },
      {
        lifecycle,
        operationEpoch: 4,
        useCurrentEpoch: true
      }
    ).lifecycleEpoch,
    9
  )
})

test('REST statusCode is preserved and trust failures never select policy recovery', () => {
  const rest = createEnterprisePublicError(
    { code: 'skill_policy_denied', statusCode: 403 },
    {
      lifecycle: { lifecycleEpoch: 1, state: 'running' }
    }
  )
  assert.equal(rest.httpStatus, 403)
  assert.equal(rest.recoveryKind, 'refresh-policy')

  const untrusted = createEnterprisePublicError(
    {
      code: 'enterprise_skill_hub_untrusted_renderer',
      status: 403
    },
    { lifecycle: { lifecycleEpoch: 1, state: 'running' } }
  )
  assert.equal(untrusted.recoveryKind, 'none')
})

test('D4 deterministic recovery codes preserve safe public identity and fixed messages', () => {
  const expectedMessages = {
    install_operation_binding_mismatch: 'The enterprise skill authorization no longer matches this operation.',
    install_operation_content_changed: 'The staged enterprise skill content changed before installation completed.',
    install_operation_receipt_invalid: 'The enterprise skill installation receipt is invalid.',
    install_operation_journal_invalid: 'The local enterprise skill recovery record is invalid.',
    install_operation_user_mismatch: 'The enterprise skill operation belongs to a different managed user.',
    skill_name_conflict: 'A local skill conflicts with this enterprise skill.'
  }
  for (const [code, message] of Object.entries(expectedMessages)) {
    const publicError = createEnterprisePublicError(
      Object.assign(new Error('private receipt token and local path'), { code, status: 409 }),
      { lifecycle: { lifecycleEpoch: 11, state: 'running' } }
    )
    assert.equal(publicError.errorCode, code)
    assert.equal(publicError.httpStatus, 409)
    assert.equal(publicError.lifecycleEpoch, 11)
    assert.equal(publicError.recoveryKind, 'none')
    assert.equal(publicError.message, message)
    assert.throws(
      () => unwrapEnterprisePublicResult(enterprisePublicFailure(publicError)),
      error =>
        error.errorCode === code &&
        error.httpStatus === 409 &&
        error.lifecycleEpoch === 11 &&
        error.recoveryKind === 'none' &&
        error.message === message
    )
  }
})

test('Gateway D4 stable codes keep fixed public messages and recovery actions', () => {
  const cases = [
    ['desktop_active_role_required', 403, 'refresh-policy', 'Contact an administrator to assign an active enterprise role.'],
    ['skills_manage_required', 403, 'refresh-policy', 'Contact an administrator to grant enterprise skill management access.'],
    ['client_operation_id_conflict', 409, 'none', 'The enterprise skill operation conflicts with an existing request.'],
    ['install_operation_reconciliation_invalid', 409, 'none', 'The enterprise skill recovery state is invalid.'],
    ['install_operation_pending_limit', 429, 'wait', 'Too many enterprise skill installations are pending. Wait before retrying.'],
    ['install_policy_changed', 409, 'refresh-policy', 'Enterprise policy changed while this skill was being installed.'],
    ['install_operation_expired', 409, 'retry', 'The enterprise skill operation expired before installation completed.'],
    ['skill_install_receipt_unavailable', 503, 'retry', 'The enterprise Gateway could not issue an installation receipt.'],
    ['skill_install_receipt_ineligible', 409, 'none', 'This enterprise skill operation cannot receive an installation receipt.'],
    ['skill_install_receipt_recovery_expired', 410, 'retry', 'The enterprise skill receipt recovery window expired.']
  ]

  for (const [code, status, recoveryKind, message] of cases) {
    const publicError = createEnterprisePublicError(
      Object.assign(new Error('private token dsk_secret C:\\Users\\Alice\\skill.zip'), { code, status }),
      { lifecycle: { lifecycleEpoch: 12, state: 'running' } }
    )
    assert.deepEqual(
      {
        code: publicError.errorCode,
        message: publicError.message,
        recoveryKind: publicError.recoveryKind,
        status: publicError.httpStatus
      },
      { code, message, recoveryKind, status }
    )
    assert.throws(
      () => unwrapEnterprisePublicResult(enterprisePublicFailure(publicError)),
      error =>
        error.errorCode === code &&
        error.httpStatus === status &&
        error.recoveryKind === recoveryKind &&
        error.message === message
    )
  }
})

test('G4 bootstrap errors use the shared fail-closed public contract', () => {
  const contract = require('./enterprise-bootstrap-public-errors.json')
  for (const [code, expected] of Object.entries(contract)) {
    const publicError = createEnterprisePublicError(
      Object.assign(new Error('dsk_secret raw payload and header value 999'), { code }),
      { lifecycle: { lifecycleEpoch: 17, state: 'blocked' }, useCurrentEpoch: true }
    )
    assert.deepEqual(
      {
        errorCode: publicError.errorCode,
        lifecycleEpoch: publicError.lifecycleEpoch,
        message: publicError.message,
        recoveryKind: publicError.recoveryKind
      },
      {
        errorCode: code,
        lifecycleEpoch: 17,
        message: expected.message,
        recoveryKind: expected.recoveryKind
      }
    )
    assert.equal(JSON.stringify(publicError).includes('dsk_secret'), false)
    assert.equal(JSON.stringify(publicError).includes('999'), false)
  }
})

test('D4 stop failure normalizes bootstrap errors to one deterministic retry-stop envelope', () => {
  const publicError = createEnterprisePublicError(
    Object.assign(new Error('private cleanup path C:\\Users\\Alice'), { code: 'enterprise_gateway_contract_too_old' }),
    { lifecycle: { lifecycleEpoch: 18, state: 'stop_failed' }, useCurrentEpoch: true }
  )
  assert.equal(publicError.errorCode, 'enterprise_runtime_stop_failed')
  assert.equal(publicError.httpStatus, null)
  assert.equal(publicError.recoveryKind, 'retry-stop')
  assert.equal(JSON.stringify(publicError).includes('Alice'), false)
  assert.throws(
    () => unwrapEnterprisePublicResult(enterprisePublicFailure(publicError)),
    error => error.errorCode === 'enterprise_runtime_stop_failed' && error.recoveryKind === 'retry-stop'
  )

  for (const recoveryKind of ['none', 'sign-in', 'refresh-policy', 'retry', 'upgrade']) {
    assert.throws(
      () => unwrapEnterprisePublicResult(enterprisePublicFailure({ ...publicError, recoveryKind })),
      error => error.errorCode === 'enterprise_operation_failed' && error.recoveryKind === 'none'
    )
  }
})

test('public envelope redacts raw response bodies, tokens, URLs, and local paths and preserves reject semantics', () => {
  const raw = Object.assign(
    new Error(
      '403 https://gateway.example/private?token=dsk_secret C:\\Users\\Alice\\enterprise\\artifact.zip body={"secret":"value"}'
    ),
    { code: 'gateway-error', status: 403 }
  )
  const publicError = createEnterprisePublicError(raw, {
    lifecycle: { lifecycleEpoch: 3, state: 'running' }
  })
  const serialized = JSON.stringify(publicError)

  assert.equal(serialized.includes('dsk_secret'), false)
  assert.equal(serialized.includes('gateway.example'), false)
  assert.equal(serialized.includes('Alice'), false)
  assert.equal(serialized.includes('value'), false)
  assert.throws(
    () => unwrapEnterprisePublicResult(enterprisePublicFailure(publicError)),
    error => error.errorCode === 'enterprise_operation_failed' && error.lifecycleEpoch === 3
  )
  assert.deepEqual(unwrapEnterprisePublicResult(enterprisePublicResult({ ok: 'business-value' })), {
    ok: 'business-value'
  })
})

test('attacker-controlled codes and malformed envelopes cannot select recovery actions or resolve as data', () => {
  const injected = createEnterprisePublicError(
    { code: 'please_policy_upgrade', status: 409 },
    {
      lifecycle: { lifecycleEpoch: 2, state: 'running' }
    }
  )
  assert.equal(injected.errorCode, 'enterprise_operation_failed')
  assert.equal(injected.recoveryKind, 'none')

  for (const malformed of [null, {}, { envelope: 'enterprise-public-result.v2', ok: true, value: 'secret' }]) {
    assert.throws(
      () => unwrapEnterprisePublicResult(malformed),
      error => error.errorCode === 'enterprise_operation_failed' && error.recoveryKind === 'none'
    )
  }

  const forged = enterprisePublicFailure({
    envelope: 'enterprise-public-error.v1',
    errorCode: 'skill_policy_denied',
    httpStatus: 403,
    lifecycleEpoch: 1,
    message: 'dsk_secret raw-body C:\\Users\\Alice',
    recoveryKind: 'refresh-policy'
  })
  assert.throws(() => unwrapEnterprisePublicResult(forged), error => {
    assert.equal(error.message.includes('dsk_secret'), false)
    assert.equal(error.message.includes('Alice'), false)
    assert.equal(error.message, 'Enterprise policy does not allow this skill to be installed.')
    return true
  })

  for (const httpStatus of [99, 600, 999]) {
    assert.throws(() => unwrapEnterprisePublicResult(enterprisePublicFailure({
      ...forged.error,
      httpStatus
    })), error => error.errorCode === 'enterprise_operation_failed')
  }

  for (const contradictory of [
    { errorCode: 'enterprise_untrusted_renderer', httpStatus: 403, recoveryKind: 'sign-in' },
    { errorCode: 'enterprise_profile_not_managed', httpStatus: 403, recoveryKind: 'upgrade' },
    { errorCode: 'request-canceled', httpStatus: null, recoveryKind: 'retry' },
    { errorCode: 'enterprise_operation_superseded', httpStatus: null, recoveryKind: 'refresh-policy' },
    { errorCode: 'gateway-timeout', httpStatus: null, recoveryKind: 'none' },
    { errorCode: 'enterprise_operation_failed', httpStatus: 426, recoveryKind: 'sign-in' }
  ]) {
    assert.throws(() => unwrapEnterprisePublicResult(enterprisePublicFailure({
      ...forged.error,
      ...contradictory
    })), error => error.errorCode === 'enterprise_operation_failed' && error.recoveryKind === 'none')
  }
})
