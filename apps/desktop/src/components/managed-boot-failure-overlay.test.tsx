import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnterprisePublicErrorEnvelope } from '@/global'
import { $desktopBoot, completeDesktopBoot, failDesktopBoot } from '@/store/boot'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $desktopOnboarding } from '@/store/onboarding'

import bootstrapErrors from '../../electron/enterprise-bootstrap-public-errors.json'

import { BootFailureOverlay } from './boot-failure-overlay'

const RUNTIME_STOP_MESSAGE = 'Hermes could not stop safely. Retry the stop before continuing.'

function errorEnvelope(errorCode: keyof typeof bootstrapErrors | 'enterprise_runtime_stop_failed'):
EnterprisePublicErrorEnvelope {
  if (errorCode === 'enterprise_runtime_stop_failed') {
    return {
      envelope: 'enterprise-public-error.v1',
      errorCode,
      httpStatus: null,
      lifecycleEpoch: 7,
      message: RUNTIME_STOP_MESSAGE,
      recoveryKind: 'retry-stop'
    }
  }
  const contract = bootstrapErrors[errorCode]
  return {
    envelope: 'enterprise-public-error.v1',
    errorCode,
    httpStatus: contract.httpStatuses[0],
    lifecycleEpoch: 7,
    message: contract.message,
    recoveryKind: contract.recoveryKind as EnterprisePublicErrorEnvelope['recoveryKind']
  }
}

function renderFailure(enterpriseError: EnterprisePublicErrorEnvelope, rawError = enterpriseError.message) {
  $desktopBoot.set({
    enterpriseError,
    enterpriseManaged: true,
    error: rawError,
    fakeMode: false,
    message: rawError,
    phase: 'backend.error',
    progress: 18,
    running: false,
    timestamp: Date.now(),
    visible: true
  })
  render(<BootFailureOverlay />)
}

const recoverPolicy = vi.fn(async () => ({ state: 'running' }))
const retryStop = vi.fn(async () => ({ state: 'running' }))
const resetBootstrap = vi.fn(async () => undefined)
const repairBootstrap = vi.fn(async () => undefined)
const applyConnectionConfig = vi.fn(async () => undefined)
const checkUpdate = vi.fn(async () => ({ supported: true }))

beforeEach(() => {
  clearNotifications()
  recoverPolicy.mockReset()
  retryStop.mockReset()
  resetBootstrap.mockClear()
  repairBootstrap.mockClear()
  applyConnectionConfig.mockClear()
  checkUpdate.mockClear()
  recoverPolicy.mockResolvedValue({ state: 'running' })
  retryStop.mockResolvedValue({ state: 'running' })
  $desktopOnboarding.set({
    configured: true,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false
  })
  ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
    applyConnectionConfig,
    enterprise: { managed: true, recoverPolicy, retryStop },
    getRecentLogs: vi.fn(async () => ({ lines: [] })),
    repairBootstrap,
    resetBootstrap,
    revealLogs: vi.fn(async () => ({ ok: true, path: 'safe-log' })),
    updates: { check: checkUpdate }
  }
})

afterEach(() => {
  cleanup()
  clearNotifications()
  vi.restoreAllMocks()
})

describe('managed bootstrap failure surface', () => {
  it('none errors show only fixed admin guidance and logs', () => {
    for (const code of ['enterprise_gateway_contract_too_old', 'enterprise_policy_payload_invalid'] as const) {
      renderFailure(errorEnvelope(code))
      expect(screen.getByText(bootstrapErrors[code].message)).toBeTruthy()
      expect(screen.getByText(/contact your administrator/i)).toBeTruthy()
      expect(screen.getByRole('button', { name: /open logs/i })).toBeTruthy()
      expect(screen.queryByText(/repair install/i)).toBeNull()
      expect(screen.queryByText(/use local gateway/i)).toBeNull()
      expect(screen.queryByText(/sign in/i)).toBeNull()
      cleanup()
    }
  })

  it('upgrade errors require an approved deployment and never call the original updater', () => {
    for (const code of ['enterprise_desktop_contract_too_old', 'desktop_bootstrap_contract_upgrade_required'] as const) {
      renderFailure(errorEnvelope(code))
      expect(screen.getAllByText(/deploy an approved Hermes Desktop version/i).length).toBeGreaterThan(0)
      expect(screen.getByRole('button', { name: /open logs/i })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /update/i })).toBeNull()
      expect(screen.queryByText(/repair install/i)).toBeNull()
      expect(screen.queryByText(/use local gateway/i)).toBeNull()
      cleanup()
    }
    expect(checkUpdate).not.toHaveBeenCalled()
  })

  it('refresh-policy uses the explicit managed IPC and reports a fixed safe failure', async () => {
    recoverPolicy.mockRejectedValueOnce(new Error('dsk_secret raw recovery failure'))
    renderFailure(errorEnvelope('desktop_active_role_required'))

    const button = screen.getByRole('button', { name: /refresh enterprise policy/i })
    fireEvent.click(button)
    await waitFor(() => expect(recoverPolicy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    expect($notifications.get()[0]).toMatchObject({
      kind: 'error',
      message: 'The managed recovery action did not complete. Open the logs and contact your administrator.',
      title: 'Enterprise recovery failed'
    })
    expect(JSON.stringify($notifications.get())).not.toContain('dsk_secret')
    expect(resetBootstrap).not.toHaveBeenCalled()
    expect(repairBootstrap).not.toHaveBeenCalled()
    expect(applyConnectionConfig).not.toHaveBeenCalled()
    expect(checkUpdate).not.toHaveBeenCalled()
  })

  it('retry-stop uses only the dedicated managed IPC and clears busy after failure', async () => {
    retryStop.mockRejectedValueOnce(new Error('private cleanup detail'))
    renderFailure(errorEnvelope('enterprise_runtime_stop_failed'))

    const button = screen.getByRole('button', { name: /retry safe stop/i })
    fireEvent.click(button)
    await waitFor(() => expect(retryStop).toHaveBeenCalledTimes(1))
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    expect($notifications.get()[0]?.title).toBe('Enterprise recovery failed')
    expect(resetBootstrap).not.toHaveBeenCalled()
    expect(repairBootstrap).not.toHaveBeenCalled()
    expect(applyConnectionConfig).not.toHaveBeenCalled()
    expect(checkUpdate).not.toHaveBeenCalled()
  })

  it('hostile or malformed envelopes fail closed without rendering raw details or actions', () => {
    const hostile = {
      ...errorEnvelope('enterprise_gateway_contract_too_old'),
      errorCode: 'hostile-code',
      message: 'dsk_secret raw payload',
      recoveryKind: 'refresh-policy'
    } as EnterprisePublicErrorEnvelope
    renderFailure(hostile, 'dsk_secret raw boot detail')

    expect(screen.getByText('Hermes Desktop could not start under enterprise management.')).toBeTruthy()
    expect(screen.queryByText(/dsk_secret/i)).toBeNull()
    expect(screen.getByRole('button', { name: /open logs/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /refresh enterprise policy/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /retry safe stop/i })).toBeNull()
    expect(screen.queryByText(/repair install/i)).toBeNull()
    expect(screen.queryByText(/use local gateway/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /update/i })).toBeNull()

    cleanup()
    $desktopBoot.set({
      enterpriseError: null,
      enterpriseManaged: true,
      error: 'dsk_secret missing envelope detail',
      fakeMode: false,
      message: 'dsk_secret missing envelope detail',
      phase: 'backend.error',
      progress: 18,
      running: false,
      timestamp: Date.now(),
      visible: true
    })
    render(<BootFailureOverlay />)
    expect(screen.getByText('Hermes Desktop could not start under enterprise management.')).toBeTruthy()
    expect(screen.queryByText(/dsk_secret/i)).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /open logs/i })).toBeTruthy()
  })

  it('machine-config managed boot remains fail-closed when the legacy preload flag is false', () => {
    ;(window.hermesDesktop.enterprise as { managed: boolean }).managed = false
    renderFailure(errorEnvelope('enterprise_gateway_contract_too_old'))

    expect(screen.getByText(bootstrapErrors.enterprise_gateway_contract_too_old.message)).toBeTruthy()
    expect(screen.queryByText(/repair install/i)).toBeNull()
    expect(screen.queryByText(/use local gateway/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /open logs/i })).toBeTruthy()
  })

  it('does not reuse a prior 403 action after recovery succeeds and a later ordinary failure occurs', async () => {
    renderFailure(errorEnvelope('desktop_active_role_required'))
    expect(screen.getByRole('button', { name: /refresh enterprise policy/i })).toBeTruthy()

    completeDesktopBoot()
    failDesktopBoot('ordinary backend failure')

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /refresh enterprise policy/i })).toBeNull()
    })
    expect(screen.getByText('Hermes Desktop could not start under enterprise management.')).toBeTruthy()
    expect(screen.queryByText('ordinary backend failure')).toBeNull()
    expect(screen.getByRole('button', { name: /open logs/i })).toBeTruthy()
  })
})
