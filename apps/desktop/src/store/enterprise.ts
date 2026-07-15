import { atom } from 'nanostores'

import type {
  EnterpriseDesktopLoginInput,
  EnterpriseDesktopState,
  EnterpriseLoginMethod,
  EnterpriseLoginState,
  EnterpriseMessagingChannelPolicyDecision,
  EnterpriseUiPolicy,
  EnterpriseWeComBounds
} from '@/global'
import {
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setConnection,
  setCronSessions,
  setCurrentUsage,
  setGatewayState,
  setMessages,
  setMessagingPlatformTotals,
  setMessagingSessions,
  setMessagingTruncated,
  setResumeExhaustedSessionId,
  setResumeFailedSessionId,
  setSelectedStoredSessionId,
  setSessionProfileTotals,
  setSessions,
  setSessionsLoading,
  setSessionsTotal,
  setWorkingSessionIds
} from '@/store/session'

const MANAGED_MESSAGING_CHANNELS_FAIL_CLOSED: EnterpriseMessagingChannelPolicyDecision = {
  allowedChannelIds: [],
  hideUnlisted: true,
  mode: 'managed',
  policy: null,
  reason: 'policy_missing',
  status: 'fail-closed',
  userManageableChannelIds: [],
  visibleChannelIds: []
}

const UNMANAGED_MESSAGING_CHANNELS_FULL_CATALOG: EnterpriseMessagingChannelPolicyDecision = {
  allowedChannelIds: null,
  hideUnlisted: false,
  mode: 'unmanaged',
  policy: null,
  reason: null,
  status: 'full-catalog',
  userManageableChannelIds: null,
  visibleChannelIds: null
}

export const INITIAL_ENTERPRISE_STATE: EnterpriseDesktopState = {
  allowedModels: [],
  authenticated: false,
  apiMode: null,
  auxiliaryPolicy: {},
  capabilities: {},
  currentModel: null,
  currentModelProfileId: null,
  defaultModel: null,
  enabled: false,
  generatedAt: null,
  lockedSurfaces: [],
  messagingChannelPolicy: UNMANAGED_MESSAGING_CHANNELS_FULL_CATALOG,
  modelRuntimeHash: null,
  modelProfiles: [],
  policyHash: null,
  policyVersion: null,
  providerRuntime: null,
  protocolSnapshot: null,
  role: null,
  runtimeDefaults: {},
  runtimeLimits: {},
  status: 'loading',
  toolPolicySnapshot: null,
  user: null
}

export const ENTERPRISE_UI_POLICY_DEFAULT: EnterpriseUiPolicy = {
  defaultLocale: 'zh',
  allowLanguageChange: true,
  lockedLocale: false
}

export const $enterprise = atom<EnterpriseDesktopState>(INITIAL_ENTERPRISE_STATE)

export const INITIAL_ENTERPRISE_LOGIN_STATE: EnterpriseLoginState = {
  defaultMethod: null,
  enterpriseDisplayName: null,
  errorCode: null,
  expiresAt: null,
  methods: [],
  selectedMethod: null,
  status: 'idle',
  user: null
}

export const $enterpriseLogin = atom<EnterpriseLoginState>(INITIAL_ENTERPRISE_LOGIN_STATE)

function applyEnterpriseLoginState(state: EnterpriseLoginState): EnterpriseLoginState {
  $enterpriseLogin.set(state)

  return state
}

function unavailableLoginState(): EnterpriseLoginState {
  return {
    ...INITIAL_ENTERPRISE_LOGIN_STATE,
    errorCode: 'gateway-offline',
    status: 'gateway-offline'
  }
}

export async function initializeEnterpriseLogin(): Promise<EnterpriseLoginState> {
  const bridge = window.hermesDesktop?.enterprise

  if (!bridge) {
    return applyEnterpriseLoginState(unavailableLoginState())
  }

  try {
    return applyEnterpriseLoginState(await bridge.loginMethods())
  } catch {
    return applyEnterpriseLoginState(unavailableLoginState())
  }
}

export function subscribeEnterpriseLogin(): () => void {
  const bridge = window.hermesDesktop?.enterprise

  if (!bridge?.onLoginState) {
    return () => undefined
  }

  return bridge.onLoginState(state => applyEnterpriseLoginState(state))
}

export async function selectEnterpriseLoginMethod(method: EnterpriseLoginMethod): Promise<EnterpriseLoginState> {
  return applyEnterpriseLoginState(await window.hermesDesktop.enterprise.selectLoginMethod(method))
}

export async function refreshEnterpriseWeCom(): Promise<EnterpriseLoginState> {
  return applyEnterpriseLoginState(await window.hermesDesktop.enterprise.refreshWeCom())
}

export async function cancelEnterpriseWeCom(): Promise<EnterpriseLoginState> {
  return applyEnterpriseLoginState(await window.hermesDesktop.enterprise.cancelWeCom())
}

export async function setEnterpriseWeComBounds(bounds: EnterpriseWeComBounds): Promise<void> {
  await window.hermesDesktop.enterprise.setWeComBounds(bounds)
}

function applyEnterpriseState(state: EnterpriseDesktopState | null | undefined): EnterpriseDesktopState {
  const base = state || {
    ...INITIAL_ENTERPRISE_STATE,
    status: 'disabled' as const
  }

  const withMessagingPolicy = base.messagingChannelPolicy
    ? base
    : {
        ...base,
        messagingChannelPolicy: base.enabled
          ? MANAGED_MESSAGING_CHANNELS_FAIL_CLOSED
          : UNMANAGED_MESSAGING_CHANNELS_FULL_CATALOG
      }

  const next = withMessagingPolicy.enabled && !withMessagingPolicy.uiPolicy
    ? {
        ...withMessagingPolicy,
        uiPolicy: ENTERPRISE_UI_POLICY_DEFAULT
      }
    : withMessagingPolicy

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
  $enterpriseLogin.set(INITIAL_ENTERPRISE_LOGIN_STATE)

  return applyEnterpriseState(state)
}

export function setEnterpriseRuntimeModelSelection(model: string, profileId?: string | null): void {
  const state = $enterprise.get()

  if (!state.enabled) {
    return
  }

  applyEnterpriseState({
    ...state,
    currentModel: model || state.currentModel,
    currentModelProfileId: profileId || null
  })
}

export async function selectEnterpriseModel(model: string): Promise<EnterpriseDesktopState> {
  const state = await window.hermesDesktop.enterprise.selectModel(model)
  clearEnterpriseRuntimeSessionState()

  return applyEnterpriseState(state)
}
