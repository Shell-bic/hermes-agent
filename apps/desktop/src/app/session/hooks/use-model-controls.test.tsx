import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getGlobalModelInfo } from '@/hermes'
import { $enterprise, INITIAL_ENTERPRISE_STATE } from '@/store/enterprise'
import {
  $activeSessionId,
  $currentModel,
  $currentProvider,
  $sessions,
  setCurrentModel,
  setCurrentProvider,
  setSessions
} from '@/store/session'

import { useModelControls } from './use-model-controls'

const setGlobalModel = vi.fn()
const notifyError = vi.fn()

vi.mock('@/hermes', () => ({
  getGlobalModelInfo: vi.fn(),
  setGlobalModel: (...args: Parameters<typeof setGlobalModel>) => setGlobalModel(...args)
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      desktop: {
        modelSwitchFailed: 'Model switch failed'
      }
    }
  })
}))

vi.mock('@/store/notifications', () => ({
  notifyError: (...args: Parameters<typeof notifyError>) => notifyError(...args)
}))

type Controls = ReturnType<typeof useModelControls>

function Harness({
  activeSessionId,
  onReady,
  requestGateway
}: {
  activeSessionId: string | null
  onReady: (controls: Controls) => void
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}) {
  const controls = useModelControls({
    activeSessionId,
    queryClient: new QueryClient(),
    requestGateway
  })

  onReady(controls)

  return null
}

describe('useModelControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $activeSessionId.set(null)
    $enterprise.set(INITIAL_ENTERPRISE_STATE)
    setSessions([])
    setCurrentModel('')
    setCurrentProvider('')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'hermesDesktop')
    $activeSessionId.set(null)
    $enterprise.set(INITIAL_ENTERPRISE_STATE)
    setSessions([])
    setCurrentModel('')
    setCurrentProvider('')
  })

  it('applies the global model when there is no active runtime session', async () => {
    vi.mocked(getGlobalModelInfo).mockResolvedValue({
      model: 'openai/gpt-5.5',
      provider: 'openai-codex'
    })

    const { result } = renderHook(() =>
      useModelControls({
        activeSessionId: null,
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    await result.current.refreshCurrentModel()

    expect($currentModel.get()).toBe('openai/gpt-5.5')
    expect($currentProvider.get()).toBe('openai-codex')
  })

  it('does not clobber the active session footer state with global model info', async () => {
    setCurrentModel('deepseek/deepseek-v4-pro')
    setCurrentProvider('deepseek')
    $activeSessionId.set('runtime-1')
    vi.mocked(getGlobalModelInfo).mockResolvedValue({
      model: 'openai/gpt-5.5',
      provider: 'openai-codex'
    })

    const { result } = renderHook(() =>
      useModelControls({
        activeSessionId: 'runtime-1',
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    await result.current.refreshCurrentModel()

    expect($currentModel.get()).toBe('deepseek/deepseek-v4-pro')
    expect($currentProvider.get()).toBe('deepseek')
  })

  it('routes active-session picker changes through config.set with an explicit provider', async () => {
    const requestGateway = vi.fn(async () => ({ key: 'model', value: 'claude-sonnet-4.6' }) as never)
    let controls!: Controls

    render(
      <Harness
        activeSessionId="session-1"
        onReady={value => (controls = value)}
        requestGateway={requestGateway}
      />
    )

    await expect(
      controls.selectModel({
        model: 'claude-sonnet-4.6',
        provider: 'anthropic'
      })
    ).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith('config.set', {
      session_id: 'session-1',
      key: 'model',
      value: 'claude-sonnet-4.6 --provider anthropic'
    })
    expect(requestGateway).not.toHaveBeenCalledWith('slash.exec', expect.anything())
  })

  it('stores a no-session pick as UI state with no gateway or global write', async () => {
    const requestGateway = vi.fn()
    let controls!: Controls

    render(
      <Harness
        activeSessionId={null}
        onReady={value => (controls = value)}
        requestGateway={requestGateway}
      />
    )

    await expect(
      controls.selectModel({
        model: 'claude-sonnet-4.6',
        provider: 'anthropic'
      })
    ).resolves.toBe(true)

    // The pick is plain UI state; session.create ships it later. Nothing touches
    // the gateway or the profile default here.
    expect($currentModel.get()).toBe('claude-sonnet-4.6')
    expect($currentProvider.get()).toBe('anthropic')
    expect(requestGateway).not.toHaveBeenCalled()
    expect(setGlobalModel).not.toHaveBeenCalled()
  })

  it('seeds an empty composer model from global but never clobbers a pick', async () => {
    vi.mocked(getGlobalModelInfo).mockResolvedValue({ model: 'openai/gpt-5.5', provider: 'openai-codex' })

    const { result } = renderHook(() =>
      useModelControls({
        activeSessionId: null,
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    // Empty → seeds the default.
    await result.current.refreshCurrentModel()
    expect($currentModel.get()).toBe('openai/gpt-5.5')

    // A user pick must survive the lifecycle refreshes that fire on boot / fresh
    // draft / session events.
    setCurrentModel('anthropic/claude-sonnet-4.6')
    setCurrentProvider('anthropic')
    await result.current.refreshCurrentModel()
    expect($currentModel.get()).toBe('anthropic/claude-sonnet-4.6')

    // A profile swap forces a reseed to the new profile's default.
    await result.current.refreshCurrentModel(true)
    expect($currentModel.get()).toBe('openai/gpt-5.5')
  })

  it('seeds enterprise managed drafts from the enterprise model state without reading global model info', async () => {
    $enterprise.set({
      ...INITIAL_ENTERPRISE_STATE,
      allowedModels: ['enterprise/current', 'enterprise/default'],
      authenticated: true,
      currentModel: 'enterprise/current',
      defaultModel: 'enterprise/default',
      enabled: true,
      status: 'authenticated'
    })

    const { result } = renderHook(() =>
      useModelControls({
        activeSessionId: null,
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    await result.current.refreshCurrentModel()

    expect($currentModel.get()).toBe('enterprise/current')
    expect($currentProvider.get()).toBe('company-gateway')
    expect(getGlobalModelInfo).not.toHaveBeenCalled()
  })

  it('stores enterprise managed no-session picker changes as UI state without manifest refresh or session clearing', async () => {
    const requestGateway = vi.fn()
    const selectModel = vi.fn()

    $enterprise.set({
      ...INITIAL_ENTERPRISE_STATE,
      allowedModels: ['enterprise/next'],
      authenticated: true,
      currentModel: 'enterprise/current',
      defaultModel: 'enterprise/next',
      enabled: true,
      status: 'authenticated'
    })
    setSessions([{ id: 'stored-session' } as never])
    window.hermesDesktop = {
      enterprise: {
        selectModel
      }
    } as unknown as typeof window.hermesDesktop

    let controls!: Controls

    render(
      <Harness
        activeSessionId={null}
        onReady={value => (controls = value)}
        requestGateway={requestGateway}
      />
    )

    await expect(
      controls.selectModel({
        model: 'enterprise/next',
        provider: 'company-gateway'
      })
    ).resolves.toBe(true)

    expect(selectModel).not.toHaveBeenCalled()
    expect(requestGateway).not.toHaveBeenCalled()
    expect($sessions.get()).toHaveLength(1)
    expect($currentModel.get()).toBe('enterprise/next')
    expect($currentProvider.get()).toBe('company-gateway')
  })

  it('routes enterprise managed active-session picker changes through config.set only', async () => {
    const requestGateway = vi.fn(async () => ({ key: 'model', value: 'enterprise/next' }) as never)
    const selectModel = vi.fn()

    $enterprise.set({
      ...INITIAL_ENTERPRISE_STATE,
      allowedModels: ['enterprise/next'],
      authenticated: true,
      currentModel: 'enterprise/current',
      defaultModel: 'enterprise/next',
      enabled: true,
      status: 'authenticated'
    })
    $activeSessionId.set('session-1')
    setSessions([{ id: 'stored-session' } as never])
    window.hermesDesktop = {
      enterprise: {
        selectModel
      }
    } as unknown as typeof window.hermesDesktop

    let controls!: Controls

    render(
      <Harness
        activeSessionId="session-1"
        onReady={value => (controls = value)}
        requestGateway={requestGateway}
      />
    )

    await expect(
      controls.selectModel({
        model: 'enterprise/next',
        provider: 'company-gateway'
      })
    ).resolves.toBe(true)

    expect(selectModel).not.toHaveBeenCalled()
    expect(requestGateway).toHaveBeenCalledWith('config.set', {
      session_id: 'session-1',
      key: 'model',
      value: 'enterprise/next --provider company-gateway'
    })
    expect($activeSessionId.get()).toBe('session-1')
    expect($sessions.get()).toHaveLength(1)
    expect($currentModel.get()).toBe('enterprise/next')
    expect($currentProvider.get()).toBe('company-gateway')
  })

  it('routes enterprise managed profile picks with the selected profile token', async () => {
    const requestGateway = vi.fn(async () => ({ key: 'model', value: 'glm-5.2' }) as never)

    $enterprise.set({
      ...INITIAL_ENTERPRISE_STATE,
      allowedModels: ['glm-5.2'],
      authenticated: true,
      currentModel: 'glm-5.2',
      currentModelProfileId: 'profile-a',
      defaultModel: 'glm-5.2',
      enabled: true,
      modelProfiles: [
        { id: 'profile-a', model: 'glm-5.2', name: 'GLM Anthropic' },
        { id: 'profile-b', model: 'glm-5.2', name: 'GLM OpenAI Compatible' }
      ],
      status: 'authenticated'
    })
    $activeSessionId.set('session-1')

    let controls!: Controls

    render(
      <Harness
        activeSessionId="session-1"
        onReady={value => (controls = value)}
        requestGateway={requestGateway}
      />
    )

    await expect(
      controls.selectModel({
        model: 'enterprise-profile:profile-b',
        provider: 'company-gateway'
      })
    ).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith('config.set', {
      session_id: 'session-1',
      key: 'model',
      value: 'enterprise-profile:profile-b --provider company-gateway'
    })
    expect($currentModel.get()).toBe('glm-5.2')
    expect($currentProvider.get()).toBe('company-gateway')
    expect($enterprise.get().currentModelProfileId).toBe('profile-b')
  })

  it('rejects enterprise managed picker changes for unauthorized models', async () => {
    const requestGateway = vi.fn()
    const selectModel = vi.fn()

    $enterprise.set({
      ...INITIAL_ENTERPRISE_STATE,
      allowedModels: ['enterprise/allowed'],
      authenticated: true,
      currentModel: 'enterprise/allowed',
      defaultModel: 'enterprise/allowed',
      enabled: true,
      status: 'authenticated'
    })
    window.hermesDesktop = {
      enterprise: {
        selectModel
      }
    } as unknown as typeof window.hermesDesktop

    let controls!: Controls

    render(
      <Harness
        activeSessionId="session-1"
        onReady={value => (controls = value)}
        requestGateway={requestGateway}
      />
    )

    await expect(
      controls.selectModel({
        model: 'personal/model',
        provider: 'openai'
      })
    ).resolves.toBe(false)

    expect(selectModel).not.toHaveBeenCalled()
    expect(requestGateway).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), 'Model switch failed')
  })
})
