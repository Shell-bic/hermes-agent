import { atom } from 'nanostores'

import type { EnterpriseDesktopLoginInput, EnterpriseDesktopState, EnterpriseUiPolicy } from '@/global'
import {
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setConnection,
  setCronSessions,
  setCurrentUsage,
  setGatewayState,
  setMessagingPlatformTotals,
  setMessagingSessions,
  setMessagingTruncated,
  setMessages,
  setResumeExhaustedSessionId,
  setResumeFailedSessionId,
  setSelectedStoredSessionId,
  setSessionProfileTotals,
  setSessions,
  setSessionsLoading,
  setSessionsTotal,
  setWorkingSessionIds
} from '@/store/session'

export const INITIAL_ENTERPRISE_STATE: EnterpriseDesktopState = {
  allowedModels: [],
  authenticated: false,
  auxiliaryPolicy: {},
  capabilities: {},
  currentModel: null,
  currentModelProfileId: null,
  defaultModel: null,
  enabled: false,
  lockedSurfaces: [],
  modelProfiles: [],
  policyVersion: null,
  role: null,
  runtimeDefaults: {},
  status: 'loading',
  user: null
}

export const ENTERPRISE_UI_POLICY_DEFAULT: EnterpriseUiPolicy = {
  defaultLocale: 'zh',
  allowLanguageChange: true,
  lockedLocale: false
}

export const $enterprise = atom<EnterpriseDesktopState>(INITIAL_ENTERPRISE_STATE)

function applyEnterpriseState(state: EnterpriseDesktopState | null | undefined): EnterpriseDesktopState {
  const base = state || {
    ...INITIAL_ENTERPRISE_STATE,
    status: 'disabled' as const
  }
  const next = base.enabled && !base.uiPolicy
    ? {
        ...base,
        uiPolicy: ENTERPRISE_UI_POLICY_DEFAULT
      }
    : base

  $enterprise.set(next)

  return next
}

function clearEnterpriseRuntimeSessionState(): void {
  setConnection(null)
  setGatewayState('idle')
  setSessions([])
  setSessionsTotal(0)
  setCronSessions([])
  setMessagingSessions([])
  setMessagingPlatformTotals({})
  setMessagingTruncated(false)
  setSessionProfileTotals({})
  setSessionsLoading(false)
  setWorkingSessionIds([])
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  setMessages([])
  setResumeFailedSessionId(null)
  setResumeExhaustedSessionId(null)
  setBusy(false)
  setAwaitingResponse(false)
  setCurrentUsage({ calls: 0, input: 0, output: 0, total: 0 })
}

export async function refreshEnterpriseState(): Promise<EnterpriseDesktopState> {
  const bridge = window.hermesDesktop?.enterprise

  if (!bridge) {
    return applyEnterpriseState({ ...INITIAL_ENTERPRISE_STATE, status: 'disabled' })
  }

  try {
    return applyEnterpriseState(await bridge.status())
  } catch (error) {
    return applyEnterpriseState({
      ...INITIAL_ENTERPRISE_STATE,
      enabled: true,
      error: error instanceof Error ? error.message : String(error),
      status: 'error'
    })
  }
}

export async function loginEnterprise(input: EnterpriseDesktopLoginInput): Promise<EnterpriseDesktopState> {
  const state = await window.hermesDesktop.enterprise.login(input)

  return applyEnterpriseState(state)
}

export async function logoutEnterprise(): Promise<EnterpriseDesktopState> {
  const state = await window.hermesDesktop.enterprise.logout()
  clearEnterpriseRuntimeSessionState()

  return applyEnterpriseState(state)
}

export async function selectEnterpriseModel(model: string): Promise<EnterpriseDesktopState> {
  const state = await window.hermesDesktop.enterprise.selectModel(model)

  return applyEnterpriseState(state)
}
