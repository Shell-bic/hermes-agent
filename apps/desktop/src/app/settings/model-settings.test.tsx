import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { $enterprise, INITIAL_ENTERPRISE_STATE } from '@/store/enterprise'
import { $sessions, setSessions } from '@/store/session'

// Radix Select calls scrollIntoView on its items when the content opens; jsdom
// doesn't implement it (nor hasPointerCapture / releasePointerCapture), so stub
// them to let the dropdown open in tests.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const getGlobalModelInfo = vi.fn()
const getGlobalModelOptions = vi.fn()
const getAuxiliaryModels = vi.fn()
const setModelAssignment = vi.fn()
const getRecommendedDefaultModel = vi.fn()
const setEnvVar = vi.fn()
const getHermesConfigRecord = vi.fn()
const saveHermesConfig = vi.fn()
const startManualProviderOAuth = vi.fn()
const enterpriseLogout = vi.fn()

vi.mock('@/hermes', () => ({
  getGlobalModelInfo: () => getGlobalModelInfo(),
  getGlobalModelOptions: () => getGlobalModelOptions(),
  getAuxiliaryModels: () => getAuxiliaryModels(),
  setModelAssignment: (body: unknown) => setModelAssignment(body),
  getRecommendedDefaultModel: (slug: string) => getRecommendedDefaultModel(slug),
  setEnvVar: (key: string, value: string) => setEnvVar(key, value),
  getHermesConfigRecord: () => getHermesConfigRecord(),
  saveHermesConfig: (config: unknown) => saveHermesConfig(config)
}))

vi.mock('@/store/onboarding', () => ({
  startManualProviderOAuth: (slug: string) => startManualProviderOAuth(slug)
}))

beforeEach(() => {
  $enterprise.set(INITIAL_ENTERPRISE_STATE)
  setSessions([])
  ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
    enterprise: {
      logout: enterpriseLogout
    }
  }
  getGlobalModelInfo.mockResolvedValue({ provider: 'nous', model: 'hermes-4' })
  getGlobalModelOptions.mockResolvedValue({
    providers: [
      {
        name: 'Nous',
        slug: 'nous',
        models: ['hermes-4', 'hermes-4-mini'],
        authenticated: true,
        capabilities: { 'hermes-4': { reasoning: true, fast: true } }
      },
      // An unconfigured api_key provider — surfaced by the full-universe payload.
      { name: 'DeepSeek', slug: 'deepseek', models: [], authenticated: false, auth_type: 'api_key', key_env: 'DEEPSEEK_API_KEY' }
    ]
  })
  getAuxiliaryModels.mockResolvedValue({
    main: { provider: 'nous', model: 'hermes-4' },
    tasks: [{ task: 'vision', provider: 'auto', model: '', base_url: '' }]
  })
  setModelAssignment.mockResolvedValue({ provider: 'nous', model: 'hermes-4', gateway_tools: [] })
  getRecommendedDefaultModel.mockResolvedValue({ provider: 'deepseek', model: 'deepseek-chat', free_tier: null })
  setEnvVar.mockResolvedValue({ ok: true })
  getHermesConfigRecord.mockResolvedValue({ agent: { reasoning_effort: 'medium', service_tier: 'normal' } })
  saveHermesConfig.mockResolvedValue({ ok: true })
  enterpriseLogout.mockResolvedValue({ ...INITIAL_ENTERPRISE_STATE, enabled: true, status: 'unauthenticated' })
})

afterEach(() => {
  cleanup()
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
  vi.clearAllMocks()
})

async function renderModelSettings() {
  const { ModelSettings } = await import('./model-settings')

  return render(<ModelSettings />)
}

describe('ModelSettings', () => {
  it('loads the current main model and lists the full provider universe', async () => {
    await renderModelSettings()

    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalled())
    await waitFor(() => expect(getGlobalModelOptions).toHaveBeenCalled())

    // Open the provider Select — every provider from the full payload should be
    // listed, including the unconfigured one with its "set up" hint.
    const triggers = await screen.findAllByRole('combobox')
    fireEvent.click(triggers[0])

    // "Nous" shows in both the trigger and the open list; the unconfigured
    // provider is the unique signal of the full universe.
    expect((await screen.findAllByText('Nous')).length).toBeGreaterThan(0)
    expect(await screen.findByText(/DeepSeek/)).toBeTruthy()
  })

  it('shows enterprise model policy as read-only without loading Hermes model APIs', async () => {
    $enterprise.set({
      ...INITIAL_ENTERPRISE_STATE,
      authenticated: true,
      enabled: true,
      status: 'authenticated',
      allowedModels: ['kimi-k2'],
      currentModel: 'kimi-k2',
      defaultModel: 'kimi-k2',
      policyVersion: 'v1',
      providerRuntime: {
        presetKey: 'kimi-openai-compatible',
        presetVersion: '1.0.0',
        supportLevel: 'implemented-auto-verified',
        executionMode: 'shadow',
        endpointMode: 'translate',
        protocolKey: 'chat_completions',
        publicGatewayEndpoint: '/v1/chat/completions',
        effectivePolicyHash: 'a'.repeat(64),
        runtimeHash: 'b'.repeat(64),
        warnings: [{ code: 'provider_preset_legacy_fallback', safeSummary: 'Safe compatibility fallback.' }]
      },
      capabilities: { reasoning: true, context: 128000 },
      runtimeDefaults: { serviceTier: 'fast' },
      auxiliaryPolicy: { compression: 'follow-main' },
      modelProfiles: [
        {
          id: 'profile-1',
          name: 'Kimi K2',
          displayName: '企业 Kimi K2',
          model: 'kimi-k2',
          apiFormat: 'openai-chat',
          isDefault: true
        }
      ],
      currentModelProfileId: 'profile-1'
    })

    await renderModelSettings()

    expect(await screen.findByText('企业模型配置')).toBeTruthy()
    expect((await screen.findAllByText('企业 Kimi K2')).length).toBeGreaterThan(0)
    expect(screen.getByText('ProviderRuntime')).toBeTruthy()
    expect(screen.getByText('kimi-openai-compatible@1.0.0')).toBeTruthy()
    expect(screen.getByText('shadow')).toBeTruthy()
    expect(screen.getByText('translate')).toBeTruthy()
    expect(screen.getByText('implemented-auto-verified')).toBeTruthy()
    expect(screen.getByText('chat_completions')).toBeTruthy()
    expect(screen.getByText('/v1/chat/completions')).toBeTruthy()
    expect(screen.getByText(/effective a{12}/)).toBeTruthy()
    expect(screen.getByText('Safe compatibility fallback.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    expect(getGlobalModelInfo).not.toHaveBeenCalled()
    expect(getGlobalModelOptions).not.toHaveBeenCalled()
    expect(getAuxiliaryModels).not.toHaveBeenCalled()
  })

  it('logs out from the enterprise account after confirmation', async () => {
    let resolveLogout: (value: unknown) => void = () => undefined
    enterpriseLogout.mockReturnValueOnce(
      new Promise(resolve => {
        resolveLogout = resolve
      })
    )
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    $enterprise.set({
      ...INITIAL_ENTERPRISE_STATE,
      authenticated: true,
      enabled: true,
      status: 'authenticated',
      currentModel: 'kimi-k2',
      defaultModel: 'kimi-k2',
      lockedSurfaces: ['models'],
      modelProfiles: [],
      user: { userName: 'view' }
    })

    await renderModelSettings()
    setSessions(() => [{ id: 'other-user-session', title: 'Other user session' } as never])

    expect(await screen.findByText('view')).toBeTruthy()
    const logoutButton = await screen.findByRole('button', { name: '退出企业账号' })
    fireEvent.click(logoutButton)

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('确定退出吗'))
    expect(enterpriseLogout).toHaveBeenCalledTimes(1)
    expect((await screen.findByRole('button', { name: /退出中/ }) as HTMLButtonElement).disabled).toBe(true)

    resolveLogout({ ...INITIAL_ENTERPRISE_STATE, enabled: true, status: 'unauthenticated' })
    await waitFor(() => expect($enterprise.get().authenticated).toBe(false))
    expect($sessions.get()).toEqual([])
  })

  it('does not log out when the enterprise sign-out confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    $enterprise.set({
      ...INITIAL_ENTERPRISE_STATE,
      authenticated: true,
      enabled: true,
      status: 'authenticated',
      currentModel: 'kimi-k2',
      defaultModel: 'kimi-k2',
      lockedSurfaces: ['models'],
      modelProfiles: [],
      user: { userName: 'view' }
    })

    await renderModelSettings()
    fireEvent.click(await screen.findByRole('button', { name: '退出企业账号' }))

    expect(enterpriseLogout).not.toHaveBeenCalled()
    expect($enterprise.get().authenticated).toBe(true)
  })

  it('activates an unconfigured api_key provider inline by saving its key', async () => {
    await renderModelSettings()

    await waitFor(() => expect(getGlobalModelOptions).toHaveBeenCalled())

    // Open the provider Select and pick the unconfigured provider.
    const triggers = screen.getAllByRole('combobox')
    fireEvent.click(triggers[0])
    const deepseekOption = await screen.findByText(/DeepSeek/)
    fireEvent.click(deepseekOption)

    // The inline key input appears for an api_key provider that needs setup.
    const keyInput = await screen.findByPlaceholderText(/Paste DEEPSEEK_API_KEY/)
    fireEvent.change(keyInput, { target: { value: 'sk-test-123' } })

    const activate = await screen.findByRole('button', { name: /Activate/ })
    fireEvent.click(activate)

    await waitFor(() => expect(setEnvVar).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-test-123'))
  })

  it('writes the profile default speed (service_tier) when the fast switch is toggled', async () => {
    await renderModelSettings()
    await waitFor(() => expect(getHermesConfigRecord).toHaveBeenCalled())

    const fastSwitch = await screen.findByRole('switch')
    fireEvent.click(fastSwitch)

    await waitFor(() =>
      expect(saveHermesConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agent: expect.objectContaining({ service_tier: 'fast' }) })
      )
    )
  })

  it('hides the reasoning/speed defaults when the main model reports no capabilities', async () => {
    getGlobalModelOptions.mockResolvedValueOnce({
      providers: [{ name: 'Nous', slug: 'nous', models: ['hermes-4'], authenticated: true, capabilities: { 'hermes-4': { reasoning: false, fast: false } } }]
    })

    await renderModelSettings()
    await waitFor(() => expect(getHermesConfigRecord).toHaveBeenCalled())

    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('renders the auxiliary task rows', async () => {
    await renderModelSettings()

    expect(await screen.findByText('Vision')).toBeTruthy()
    expect(screen.getAllByText('auto · use main model').length).toBeGreaterThan(0)
  })

  it('assigns an auxiliary task to the main model via setModelAssignment', async () => {
    await renderModelSettings()

    // One "Set to main" button per task slot; the first is Vision.
    const setToMainButtons = await screen.findAllByRole('button', { name: 'Set to main' })
    fireEvent.click(setToMainButtons[0])

    await waitFor(() =>
      expect(setModelAssignment).toHaveBeenCalledWith({
        model: 'hermes-4',
        provider: 'nous',
        scope: 'auxiliary',
        task: 'vision'
      })
    )
  })

  it('warns when a main switch leaves auxiliary tasks pinned to another provider', async () => {
    setModelAssignment.mockResolvedValueOnce({
      provider: 'openrouter',
      model: 'anthropic/claude-opus-4.7',
      gateway_tools: [],
      stale_aux: [{ task: 'compression', provider: 'nous', model: 'hermes-4' }]
    })

    await renderModelSettings()
    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalled())

    const applyButton = await screen.findByRole('button', { name: 'Apply' })
    fireEvent.click(applyButton)

    // The switch-time notice names the pinned provider and offers a reset.
    expect(await screen.findByText(/still run on/)).toBeTruthy()
    expect(screen.getByText('nous')).toBeTruthy()
  })

  it('shows a persistent banner when a loaded aux slot mismatches the main provider', async () => {
    getAuxiliaryModels.mockResolvedValueOnce({
      main: { provider: 'nous', model: 'hermes-4' },
      tasks: [{ task: 'curator', provider: 'openrouter', model: 'anthropic/claude-opus-4.7', base_url: '' }]
    })

    await renderModelSettings()

    // Banner present on load, no switch required.
    expect(await screen.findByText(/still run on/)).toBeTruthy()
  })
})
