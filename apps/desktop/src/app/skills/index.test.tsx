import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'
import { $enterprise, INITIAL_ENTERPRISE_STATE } from '@/store/enterprise'

const getSkills = vi.fn()
const getSkillContent = vi.fn()
const getToolsets = vi.fn()
const toggleSkill = vi.fn()
const toggleToolset = vi.fn()
const getToolsetConfig = vi.fn()
const selectToolsetProvider = vi.fn()
const listEnterpriseSkills = vi.fn()
const detailEnterpriseSkill = vi.fn()
const installEnterpriseSkill = vi.fn()
const refreshEnterprisePolicyBridge = vi.fn()
const enterpriseLifecycleStatus = vi.fn()
const require = createRequire(import.meta.url)
const {
  createEnterprisePublicError,
  enterprisePublicFailure,
  unwrapEnterprisePublicResult
} = require('../../../electron/enterprise-public-error.cjs')
const { createEnterpriseSkillHubIpcHandler } = require('../../../electron/enterprise-skill-hub-ipc.cjs')

function actualPreloadBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
): typeof window.hermesDesktop {
  const preloadPath = resolve(process.cwd(), 'electron/preload.cjs')
  let exposed: typeof window.hermesDesktop | null = null
  const preloadRequire = (identifier: string) => {
    if (identifier === 'electron') {
      return {
        contextBridge: {
          exposeInMainWorld: (name: string, value: typeof window.hermesDesktop) => {
            if (name === 'hermesDesktop') {exposed = value}
          }
        },
        ipcRenderer: {
          invoke,
          on: () => undefined,
          removeListener: () => undefined,
          send: () => undefined,
          sendSync: (channel: string, value?: unknown) => {
            if (channel === 'hermes:managed-output-redaction:enabled') return false
            if (channel === 'hermes:managed-output-redaction:redact') return value
            return undefined
          }
        },
        webUtils: { getPathForFile: () => '' }
      }
    }
    return require(identifier.startsWith('.') ? resolve(dirname(preloadPath), identifier) : identifier)
  }

  runInNewContext(readFileSync(preloadPath, 'utf8'), {
    Buffer,
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    process,
    require: preloadRequire,
    setTimeout
  }, { filename: preloadPath })
  if (!exposed) throw new Error('Preload did not expose hermesDesktop.')
  return exposed
}

function rendererEnterpriseError(code: string, status: number, lifecycleEpoch: number): Error {
  const envelope = enterprisePublicFailure(createEnterprisePublicError(
    Object.assign(new Error('private gateway response'), { code, status }),
    { lifecycle: { lifecycleEpoch, state: 'running' } }
  ))
  try {
    unwrapEnterprisePublicResult(envelope)
  } catch (error) {
    return error as Error
  }
  throw new Error('Expected enterprise public failure.')
}

vi.mock('@/hermes', () => ({
  getSkillContent: (name: string) => getSkillContent(name),
  getSkills: () => getSkills(),
  getToolsets: () => getToolsets(),
  toggleSkill: (name: string, enabled: boolean) => toggleSkill(name, enabled),
  toggleToolset: (name: string, enabled: boolean) => toggleToolset(name, enabled),
  getToolsetConfig: (name: string) => getToolsetConfig(name),
  selectToolsetProvider: (toolset: string, provider: string) => selectToolsetProvider(toolset, provider),
  deleteEnvVar: vi.fn(),
  revealEnvVar: vi.fn(),
  setEnvVar: vi.fn()
}))

// Notifications hit nanostores/timers we don't care about here.
vi.mock('@/store/notifications', () => ({
  dismissNotification: vi.fn(),
  notify: vi.fn(),
  notifyError: vi.fn()
}))

function toolset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'web',
    label: 'Web Search',
    description: 'web_search, web_extract',
    enabled: true,
    available: true,
    configured: true,
    tools: ['web_search', 'web_extract'],
    ...overrides
  }
}

function skill(overrides: Record<string, unknown> = {}) {
  return {
    name: 'terminal',
    category: 'system',
    description: 'Local terminal',
    enabled: true,
    ...overrides
  }
}

function managedEnterpriseState(overrides: Record<string, unknown> = {}) {
  return {
    ...INITIAL_ENTERPRISE_STATE,
    authenticated: true,
    enabled: true,
    status: 'authenticated' as const,
    toolPolicySnapshot: {
      skills: [],
      toolSets: [],
      tools: [],
      mcpServers: [],
      capabilityFlags: {},
      policyVersion: 'pv-tools',
      policyHash: 'hash-tools',
      generatedAt: '2026-07-06T12:00:00Z'
    },
    ...overrides
  }
}

function renderSkills(tab: 'enterprise' | 'skills' | 'toolsets' = 'toolsets', locale: Locale = 'en') {
  return import('./index').then(({ SkillsView }) =>
    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MemoryRouter initialEntries={[`/skills?tab=${tab}`]}>
          <SkillsView />
        </MemoryRouter>
      </I18nProvider>
    )
  )
}

beforeEach(() => {
  listEnterpriseSkills.mockReset()
  detailEnterpriseSkill.mockReset()
  installEnterpriseSkill.mockReset()
  refreshEnterprisePolicyBridge.mockReset()
  enterpriseLifecycleStatus.mockReset()
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      enterprise: {
        refreshPolicy: () => refreshEnterprisePolicyBridge(),
        lifecycleStatus: () => enterpriseLifecycleStatus(),
        skillHub: {
          detail: (key: string) => detailEnterpriseSkill(key),
          install: (payload: unknown) => installEnterpriseSkill(payload),
          list: (query: unknown) => listEnterpriseSkills(query)
        }
      }
    }
  })
  $enterprise.set(INITIAL_ENTERPRISE_STATE)
  getSkills.mockResolvedValue([])
  getSkillContent.mockResolvedValue({
    content: '# Terminal\n\nUse for safe local shell diagnostics.',
    name: 'terminal',
    path: 'terminal/SKILL.md'
  })
  getToolsets.mockResolvedValue([toolset()])
  toggleSkill.mockResolvedValue({ ok: true, name: 'terminal', enabled: true })
  toggleToolset.mockResolvedValue({ ok: true, name: 'web', enabled: false })
  getToolsetConfig.mockResolvedValue({ has_category: false, active_provider: null, providers: [] })
  listEnterpriseSkills.mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 })
  detailEnterpriseSkill.mockResolvedValue(null)
  installEnterpriseSkill.mockResolvedValue(null)
  refreshEnterprisePolicyBridge.mockResolvedValue(managedEnterpriseState({
    policyRefreshStatus: 'current',
    policyStale: false
  }))
  enterpriseLifecycleStatus.mockResolvedValue({
    authEpoch: 0,
    lifecycleEpoch: 0,
    reasonCode: 'ready',
    state: 'running'
  })
})

afterEach(() => {
  cleanup()
  $enterprise.set(INITIAL_ENTERPRISE_STATE)
  vi.clearAllMocks()
})

describe('SkillsView toolset management', () => {
  it('hides Enterprise Discovery outside enterprise mode', async () => {
    await renderSkills('skills')

    await screen.findByText('Guidance')
    expect(screen.queryByText('Enterprise Discovery')).toBeNull()
    expect(listEnterpriseSkills).not.toHaveBeenCalled()
  })

  it('shows a sign-in prompt without invoking Skill Hub for an unauthenticated enterprise user', async () => {
    $enterprise.set({ ...INITIAL_ENTERPRISE_STATE, enabled: true, status: 'unauthenticated' })
    await renderSkills('enterprise')

    expect(await screen.findByText('Enterprise sign-in required')).toBeTruthy()
    expect(screen.getByText('Enterprise Discovery')).toBeTruthy()
    expect(listEnterpriseSkills).not.toHaveBeenCalled()
  })

  it('renders a fixed safe list error when the bridge rejects a hostile ordinary Error', async () => {
    const hostile = Object.assign(
      new Error('token=dsk_list_secret https://gateway.invalid/private C:\\Users\\Alice\\catalog.json'),
      { code: 'hostile_list_code', status: 503 }
    )
    listEnterpriseSkills.mockRejectedValue(hostile)
    $enterprise.set(managedEnterpriseState())

    await renderSkills('enterprise')

    expect(await screen.findByText('Enterprise Skill Hub request failed safely.')).toBeTruthy()
    expect(screen.queryByText(/dsk_list_secret|gateway\.invalid|Alice|hostile_list_code/)).toBeNull()
  })

  it('renders and notifies a fixed safe install error when the bridge rejects a hostile ordinary Error', async () => {
    const item = {
      artifactSha256: '7'.repeat(64), artifactSizeBytes: 100, category: 'general', currentRevision: 1,
      declaredVersion: null, description: 'Hostile rejection workflow', fileCount: 1,
      installedArtifactSha256: null, installedRevision: null, installState: 'not-installed',
      key: 'hostile-skill', name: 'hostile-skill', policyReason: null,
      policyStatus: 'available', publishedAt: null
    }
    listEnterpriseSkills.mockResolvedValue({ items: [item], page: 1, pageSize: 100, total: 1 })
    installEnterpriseSkill.mockRejectedValue(Object.assign(
      new Error('dsk_install_secret https://gateway.invalid/raw C:\\Users\\Alice\\artifact.zip'),
      { code: 'hostile_install_code', errorCode: 'skill_policy_denied', recoveryKind: 'refresh-policy' }
    ))
    $enterprise.set(managedEnterpriseState())
    const notifications = await import('@/store/notifications')

    await renderSkills('enterprise')
    fireEvent.click(await screen.findByRole('button', { name: 'Install hostile-skill' }))

    expect(await screen.findByText('Enterprise Skill Hub request failed safely.')).toBeTruthy()
    expect(screen.getByText(/enterprise_operation_failed/)).toBeTruthy()
    await waitFor(() => expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'warning',
      message: 'Enterprise Skill Hub request failed safely.'
    })))
    const rendered = document.body.textContent || ''
    const notified = JSON.stringify(vi.mocked(notifications.notify).mock.calls)
    for (const secret of ['dsk_install_secret', 'gateway.invalid', 'Alice', 'hostile_install_code']) {
      expect(rendered).not.toContain(secret)
      expect(notified).not.toContain(secret)
    }
  })

  it('keeps the real IPC public result safe through actual preload unwrap and Renderer', async () => {
    const item = {
      artifactSha256: '8'.repeat(64), artifactSizeBytes: 100, category: 'general', currentRevision: 1,
      declaredVersion: null, description: 'IPC preload workflow', fileCount: 1,
      installedArtifactSha256: null, installedRevision: null, installState: 'not-installed',
      key: 'ipc-skill', name: 'ipc-skill', policyReason: null,
      policyStatus: 'available', publishedAt: null
    }
    const lifecycle = {
      getSnapshot: () => ({ lifecycleEpoch: 4, state: 'running' }),
      revoke: vi.fn()
    }
    const handler = createEnterpriseSkillHubIpcHandler({
      assertTrusted: () => undefined,
      getLifecycle: () => lifecycle,
      isEnabled: () => true
    })
    const invoked: string[] = []
    const bridge = actualPreloadBridge(async channel => {
      invoked.push(channel)
      if (channel === 'hermes:enterprise:skill-hub:list') {
        return handler.run({}, async () => ({ items: [item], page: 1, pageSize: 100, total: 1 }))
      }
      if (channel === 'hermes:enterprise:skill-hub:install') {
        return handler.run({}, async () => {
          throw Object.assign(
            new Error('dsk_ipc_secret https://gateway.invalid/private C:\\Users\\Alice\\receipt.jwt'),
            { code: 'skill_name_conflict', status: 409 }
          )
        })
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: bridge })
    $enterprise.set(managedEnterpriseState())
    const notifications = await import('@/store/notifications')

    await renderSkills('enterprise')
    fireEvent.click(await screen.findByRole('button', { name: 'Install ipc-skill' }))

    expect(await screen.findByText('A local skill conflicts with this enterprise skill.')).toBeTruthy()
    expect(screen.getByText(/skill_name_conflict/)).toBeTruthy()
    await waitFor(() => expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'warning',
      message: 'A local skill conflicts with this enterprise skill.'
    })))
    expect(invoked).toContain('hermes:enterprise:skill-hub:list')
    expect(invoked).toContain('hermes:enterprise:skill-hub:install')
    const exposed = `${document.body.textContent}${JSON.stringify(vi.mocked(notifications.notify).mock.calls)}`
    for (const secret of ['dsk_ipc_secret', 'gateway.invalid', 'Alice', 'receipt.jwt']) {
      expect(exposed).not.toContain(secret)
    }
  })

  it('loads enterprise detail through the narrow Skill Hub bridge', async () => {
    const item = {
      artifactSha256: 'c'.repeat(64), artifactSizeBytes: 12, category: 'finance', currentRevision: 1,
      declaredVersion: '1.0.0', description: 'Detailed enterprise workflow', fileCount: 2,
      installedArtifactSha256: null, installedRevision: null, installState: 'not-installed', key: 'detail-skill',
      name: 'detail-skill', policyReason: null, policyStatus: 'available', publishedAt: null
    }

    listEnterpriseSkills.mockResolvedValue({ items: [item], page: 1, pageSize: 100, total: 1 })
    detailEnterpriseSkill.mockResolvedValue(item)
    $enterprise.set(managedEnterpriseState())

    await renderSkills('enterprise')
    fireEvent.click(await screen.findByRole('button', { name: 'Show details for detail-skill' }))
    await waitFor(() => expect(detailEnterpriseSkill).toHaveBeenCalledWith('detail-skill'))
    expect(screen.getAllByText('Detailed enterprise workflow').length).toBeGreaterThanOrEqual(1)
  })

  it('refreshes enterprise policy through the narrow bridge and exposes last-known-good status', async () => {
    $enterprise.set(managedEnterpriseState({ policyRefreshStatus: 'current', policyStale: false }))
    refreshEnterprisePolicyBridge.mockResolvedValue(managedEnterpriseState({
      policyRefreshError: 'Enterprise policy refresh failed (HTTP 503).',
      policyRefreshStatus: 'stale',
      policyStale: true
    }))

    await renderSkills('enterprise')
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh enterprise policy' }))

    await waitFor(() => expect(refreshEnterprisePolicyBridge).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Using last-known-good enterprise policy')).toBeTruthy()
    expect(screen.getByText('Enterprise policy refresh failed (HTTP 503).')).toBeTruthy()
  })

  it('reports a successful policy refresh without reloading ordinary capabilities', async () => {
    $enterprise.set(managedEnterpriseState({ policyRefreshStatus: 'current', policyStale: false }))
    getSkills.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('ordinary skills reload failed'))
    getToolsets.mockResolvedValueOnce([toolset()]).mockRejectedValueOnce(new Error('ordinary toolsets reload failed'))
    const notifications = await import('@/store/notifications')

    await renderSkills('enterprise')
    await waitFor(() => expect(getSkills).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh enterprise policy' }))

    await waitFor(() => expect(refreshEnterprisePolicyBridge).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listEnterpriseSkills).toHaveBeenCalledTimes(2))
    expect(getSkills).toHaveBeenCalledTimes(1)
    expect(getToolsets).toHaveBeenCalledTimes(1)
    expect(notifications.notifyError).not.toHaveBeenCalled()
    expect(notifications.notify).toHaveBeenCalledWith({
      kind: 'success',
      message: 'Skill availability has been updated.',
      title: 'Enterprise policy is current'
    })
  })

  it('filters enterprise discovery by search and category', async () => {
    const item = (name: string, category: string) => ({
      artifactSha256: 'd'.repeat(64),
      artifactSizeBytes: 12,
      category,
      currentRevision: 1,
      declaredVersion: null,
      description: `${name} workflow`,
      fileCount: 1,
      installedArtifactSha256: null,
      installedRevision: null,
      installState: 'not-installed',
      key: name,
      name,
      policyReason: null,
      policyStatus: 'available',
      publishedAt: null
    })

    listEnterpriseSkills.mockResolvedValue({
      items: [item('invoice-alpha', 'finance'), item('support-beta', 'service')],
      page: 1,
      pageSize: 100,
      total: 2
    })
    $enterprise.set(managedEnterpriseState())

    await renderSkills('enterprise')
    expect(await screen.findByText('invoice-alpha')).toBeTruthy()
    const search = screen.getByPlaceholderText('Search enterprise skills...')

    fireEvent.change(search, { target: { value: 'support' } })
    expect(screen.queryByText('invoice-alpha')).toBeNull()
    expect(screen.getByText('support-beta')).toBeTruthy()

    fireEvent.change(search, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /finance1/ }))
    expect(screen.getByText('invoice-alpha')).toBeTruthy()
    expect(screen.queryByText('support-beta')).toBeNull()
  })

  it('lists enterprise skills, disables policy-denied installs, and refreshes both lists after install', async () => {
    const available = {
      artifactSha256: 'a'.repeat(64),
      artifactSizeBytes: 120,
      category: 'finance',
      currentRevision: 2,
      declaredVersion: '1.0.0',
      description: 'Review invoices',
      fileCount: 3,
      installedArtifactSha256: null,
      installedRevision: null,
      installState: 'not-installed',
      key: 'invoice-review',
      name: 'invoice-review',
      policyReason: null,
      policyStatus: 'available',
      publishedAt: '2026-07-13T08:00:00Z'
    }

    const restricted = {
      ...available,
      key: 'restricted-skill',
      name: 'restricted-skill',
      policyReason: 'Admin approval required',
      policyStatus: 'restricted'
    }

    const blocked = {
      ...available,
      key: 'blocked-skill',
      name: 'blocked-skill',
      policyReason: 'Blocked by company policy',
      policyStatus: 'blocked'
    }

    const recommended = {
      ...available,
      key: 'recommended-skill',
      name: 'recommended-skill',
      policyReason: 'Recommended by your company',
      policyStatus: 'recommended'
    }

    listEnterpriseSkills
      .mockResolvedValueOnce({ items: [available, recommended, restricted, blocked], page: 1, pageSize: 100, total: 4 })
      .mockResolvedValueOnce({
        items: [
          {
            ...available,
            installState: 'installed',
            installedArtifactSha256: available.artifactSha256,
            installedRevision: 2
          },
          recommended,
          restricted,
          blocked
        ],
        page: 1,
        pageSize: 100,
        total: 4
      })

    const installedItem = {
      ...available,
      installState: 'installed',
      installedArtifactSha256: available.artifactSha256,
      installedRevision: 2
    }

    installEnterpriseSkill.mockResolvedValue({ installed: {}, item: installedItem })
    $enterprise.set(managedEnterpriseState())

    await renderSkills('enterprise')

    expect(await screen.findByText('invoice-review')).toBeTruthy()
    const install = screen.getByRole('button', { name: 'Install invoice-review' })
    expect(screen.getByRole('button', { name: 'Install recommended-skill' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'Install restricted-skill' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Install blocked-skill' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Admin approval required')).toBeTruthy()
    expect(screen.getByText('Blocked by company policy')).toBeTruthy()

    fireEvent.click(install)
    await waitFor(() => expect(installEnterpriseSkill).toHaveBeenCalledWith({ key: 'invoice-review', revision: 2 }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Installed invoice-review' })).toBeTruthy())
    expect(listEnterpriseSkills).toHaveBeenCalledTimes(2)
    expect(getSkills.mock.calls.length).toBeGreaterThan(1)
  })

  it('keeps a committed install successful when refresh fails and offers a retry', async () => {
    const available = {
      artifactSha256: 'e'.repeat(64),
      artifactSizeBytes: 120,
      category: 'finance',
      currentRevision: 1,
      declaredVersion: '1.0.0',
      description: 'Review travel expenses',
      fileCount: 2,
      installedArtifactSha256: null,
      installedRevision: null,
      installState: 'not-installed',
      key: 'expense-review',
      name: 'expense-review',
      policyReason: null,
      policyStatus: 'available',
      publishedAt: null
    }

    const installed = {
      ...available,
      installState: 'installed',
      installedArtifactSha256: available.artifactSha256,
      installedRevision: 1
    }

    const refreshError = new Error('Gateway refresh is temporarily unavailable.')

    listEnterpriseSkills
      .mockResolvedValueOnce({ items: [available], page: 1, pageSize: 100, total: 1 })
      .mockRejectedValueOnce(refreshError)
      .mockResolvedValueOnce({ items: [installed], page: 1, pageSize: 100, total: 1 })
    installEnterpriseSkill.mockResolvedValue({ installed: {}, item: installed })
    $enterprise.set(managedEnterpriseState())
    const notifications = await import('@/store/notifications')

    await renderSkills('enterprise')
    fireEvent.click(await screen.findByRole('button', { name: 'Install expense-review' }))

    expect(await screen.findByRole('button', { name: 'Installed expense-review' })).toBeTruthy()
    await waitFor(() => {
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'warning',
          message: 'Enterprise Skill Hub request failed safely.',
          title: 'Enterprise skills failed to load'
        })
      )
    })
    expect(notifications.notifyError).not.toHaveBeenCalled()

    const warning = vi.mocked(notifications.notify).mock.calls
      .map(([input]) => input)
      .find(input => input.kind === 'warning')

    expect(warning?.action?.label).toBe('Refresh skills')
    warning?.action?.onClick()

    await waitFor(() => expect(listEnterpriseSkills).toHaveBeenCalledTimes(3))
    expect(notifications.dismissNotification).toHaveBeenCalledWith('enterprise-skill-refresh:expense-review')
  })

  it('shows update-not-supported and readable conflict errors', async () => {
    const base = {
      artifactSha256: 'b'.repeat(64),
      artifactSizeBytes: 100,
      category: 'general',
      currentRevision: 3,
      declaredVersion: null,
      description: 'Enterprise workflow',
      fileCount: 1,
      installedArtifactSha256: null,
      installedRevision: null,
      installState: 'not-installed',
      key: 'conflict-skill',
      name: 'conflict-skill',
      policyReason: null,
      policyStatus: 'available',
      publishedAt: null
    }

    listEnterpriseSkills.mockResolvedValue({
      items: [base, { ...base, key: 'newer-skill', name: 'newer-skill', installState: 'update-not-supported' }],
      page: 1,
      pageSize: 100,
      total: 2
    })
    installEnterpriseSkill.mockRejectedValue(rendererEnterpriseError('skill_name_conflict', 409, 0))
    $enterprise.set(managedEnterpriseState())

    await renderSkills('enterprise')
    expect(await screen.findByText('New version')).toBeTruthy()
    expect(screen.getByText('Updates are not supported in this release.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Install conflict-skill' }))
    expect(await screen.findByText('A local skill conflicts with this enterprise skill.')).toBeTruthy()
  })

  it('renders structured recovery fields and de-duplicates one current-epoch recovery action', async () => {
    const available = {
      artifactSha256: 'f'.repeat(64), artifactSizeBytes: 100, category: 'general', currentRevision: 1,
      declaredVersion: null, description: 'Recoverable workflow', fileCount: 1,
      installedArtifactSha256: null, installedRevision: null, installState: 'not-installed',
      key: 'recoverable-skill', name: 'recoverable-skill', policyReason: null,
      policyStatus: 'available', publishedAt: null
    }
    const installed = {
      ...available,
      installedArtifactSha256: available.artifactSha256,
      installedRevision: 1,
      installState: 'installed'
    }
    let finishRecovery: (value: unknown) => void = () => undefined
    const recovery = new Promise(resolve => { finishRecovery = resolve })
    listEnterpriseSkills
      .mockResolvedValueOnce({ items: [available], page: 1, pageSize: 100, total: 1 })
      .mockResolvedValue({ items: [installed], page: 1, pageSize: 100, total: 1 })
    installEnterpriseSkill
      .mockRejectedValueOnce(rendererEnterpriseError('install_operation_reconciling', 202, 7))
      .mockImplementationOnce(() => recovery)
    enterpriseLifecycleStatus.mockResolvedValue({
      authEpoch: 0, lifecycleEpoch: 7, reasonCode: 'ready', state: 'running'
    })
    $enterprise.set(managedEnterpriseState())

    await renderSkills('enterprise')
    fireEvent.click(await screen.findByRole('button', { name: 'Install recoverable-skill' }))
    const structured = await screen.findByText(/install_operation_reconciling/)
    expect(structured.parentElement?.dataset.errorCode).toBe('install_operation_reconciling')
    expect(structured.parentElement?.dataset.httpStatus).toBe('202')
    expect(structured.parentElement?.dataset.recoveryKind).toBe('wait')
    expect(structured.parentElement?.dataset.lifecycleEpoch).toBe('7')

    const recover = screen.getByRole('button', { name: 'Refresh skills recoverable-skill' })
    fireEvent.click(recover)
    fireEvent.click(recover)
    await waitFor(() => expect(enterpriseLifecycleStatus).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(installEnterpriseSkill).toHaveBeenCalledTimes(2))
    finishRecovery({ installed: {}, item: installed })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Installed recoverable-skill' })).toBeTruthy())
  })

  it('does not run a recovery action from an old lifecycle epoch', async () => {
    const available = {
      artifactSha256: '1'.repeat(64), artifactSizeBytes: 100, category: 'general', currentRevision: 1,
      declaredVersion: null, description: 'Stale recovery workflow', fileCount: 1,
      installedArtifactSha256: null, installedRevision: null, installState: 'not-installed',
      key: 'stale-skill', name: 'stale-skill', policyReason: null,
      policyStatus: 'available', publishedAt: null
    }
    listEnterpriseSkills.mockResolvedValue({ items: [available], page: 1, pageSize: 100, total: 1 })
    installEnterpriseSkill.mockRejectedValueOnce(rendererEnterpriseError('install_operation_reconciling', 202, 7))
    enterpriseLifecycleStatus.mockResolvedValue({
      authEpoch: 1, lifecycleEpoch: 8, reasonCode: 'policy-refreshed', state: 'running'
    })
    $enterprise.set(managedEnterpriseState())

    await renderSkills('enterprise')
    fireEvent.click(await screen.findByRole('button', { name: 'Install stale-skill' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh skills stale-skill' }))
    await waitFor(() => expect(enterpriseLifecycleStatus).toHaveBeenCalledTimes(1))
    expect(installEnterpriseSkill).toHaveBeenCalledTimes(1)
    expect(refreshEnterprisePolicyBridge).not.toHaveBeenCalled()
  })

  it('handles lifecycle status failure during recovery without an unhandled rejection', async () => {
    const available = {
      artifactSha256: '2'.repeat(64), artifactSizeBytes: 100, category: 'general', currentRevision: 1,
      declaredVersion: null, description: 'Offline recovery workflow', fileCount: 1,
      installedArtifactSha256: null, installedRevision: null, installState: 'not-installed',
      key: 'offline-skill', name: 'offline-skill', policyReason: null,
      policyStatus: 'available', publishedAt: null
    }
    listEnterpriseSkills.mockResolvedValue({ items: [available], page: 1, pageSize: 100, total: 1 })
    installEnterpriseSkill.mockRejectedValueOnce(rendererEnterpriseError('install_operation_reconciling', 202, 7))
    enterpriseLifecycleStatus.mockRejectedValue(Object.assign(
      new Error('token dsk_secret at C:\\Users\\Alice\\enterprise\\skill.zip'),
      { code: 'hostile_internal_code' }
    ))
    $enterprise.set(managedEnterpriseState())
    const notifications = await import('@/store/notifications')

    await renderSkills('enterprise')
    fireEvent.click(await screen.findByRole('button', { name: 'Install offline-skill' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh skills offline-skill' }))
    await waitFor(() => expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'warning',
      message: 'Enterprise skill recovery could not be completed safely.'
    })))
    expect(JSON.stringify(vi.mocked(notifications.notify).mock.calls)).not.toContain('dsk_secret')
    expect(JSON.stringify(vi.mocked(notifications.notify).mock.calls)).not.toContain('Alice')
    expect(screen.queryByText(/hostile_internal_code|dsk_secret|Alice/)).toBeNull()
    expect(screen.getByText(/install_operation_reconciling/)).toBeTruthy()
    expect(installEnterpriseSkill).toHaveBeenCalledTimes(1)
  })

  it('renders a switch for each toolset and toggles it off', async () => {
    getToolsets
      .mockResolvedValueOnce([toolset()])
      .mockResolvedValueOnce([toolset({ enabled: false, available: false })])
    await renderSkills()

    const sw = await screen.findByRole('switch', { name: 'Toggle Web Search toolset' })
    expect(sw.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(sw)

    await waitFor(() => expect(toggleToolset).toHaveBeenCalledWith('web', false))
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'))
  })

  it('refreshes skill state from the runtime after a successful toggle', async () => {
    getSkills.mockResolvedValueOnce([skill({ enabled: false })]).mockResolvedValueOnce([skill({ enabled: true })])

    await renderSkills('skills')

    const sw = await screen.findByRole('switch', { name: 'Toggle terminal skill' })
    expect(sw.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(sw)

    await waitFor(() => expect(toggleSkill).toHaveBeenCalledWith('terminal', true))
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'))
  })

  it('renders catalog-only skills as unavailable cards without a fake toggle', async () => {
    getSkills.mockResolvedValue([])
    $enterprise.set(
      managedEnterpriseState({
        toolPolicySnapshot: {
          skills: [
            {
              key: 'skill.core-chat',
              displayName: '基础对话',
              description: '提供基础会话能力',
              status: 'available',
              source: 'enterprise'
            }
          ],
          toolSets: [],
          tools: [],
          mcpServers: [],
          capabilityFlags: {},
          policyVersion: 'pv-tools',
          policyHash: 'hash-tools',
          generatedAt: '2026-07-06T12:00:00Z'
        }
      })
    )

    await renderSkills('skills', 'zh')

    const title = await screen.findByText('基础对话')
    expect(title.closest('article')).toBeTruthy()
    expect(screen.getByText('当前不可用')).toBeTruthy()
    expect(screen.queryByRole('switch', { name: '切换 基础对话 技能' })).toBeNull()
  })

  it('renders toolset titles without leading emoji', async () => {
    getToolsets.mockResolvedValue([toolset({ name: 'cronjob', label: '⏰ Cron Jobs', description: 'cron tools' })])

    await renderSkills()

    expect(await screen.findByText('Cron Jobs')).toBeTruthy()
    expect(screen.queryByText(/⏰/)).toBeNull()
  })

  it('keeps the configured pill alongside the switch', async () => {
    await renderSkills()

    await screen.findByRole('switch', { name: 'Toggle Web Search toolset' })
    expect(screen.getByText('Configured')).toBeTruthy()
  })

  it('keeps Needs keys for unconfigured enterprise toolsets that are not policy locked', async () => {
    getToolsets.mockResolvedValue([toolset({ name: 'web', configured: false })])
    $enterprise.set(
      managedEnterpriseState({
        toolPolicySnapshot: {
          skills: [],
          toolSets: [
            {
              key: 'web',
              displayName: 'Enterprise Web',
              description: 'governed browser access',
              status: 'recommended',
              source: 'enterprise'
            }
          ],
          tools: [],
          mcpServers: [],
          capabilityFlags: {},
          policyVersion: 'pv-tools',
          policyHash: 'hash-tools',
          generatedAt: '2026-07-06T12:00:00Z'
        }
      })
    )

    await renderSkills()

    expect(await screen.findByText('Enterprise Web')).toBeTruthy()
    expect(screen.getByText('Recommended')).toBeTruthy()
    expect(screen.getByText('Needs keys')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Configure Enterprise Web' }).getAttribute('disabled')).toBeNull()
  })

  it('expands the provider config panel when the configured pill is clicked', async () => {
    await renderSkills()

    const configureBtn = await screen.findByRole('button', { name: 'Configure Web Search' })
    fireEvent.click(configureBtn)

    await waitFor(() => expect(getToolsetConfig).toHaveBeenCalledWith('web'))
  })

  it('shows enterprise tool policy first and keeps local-only toolsets as user-created supplements', async () => {
    getToolsets.mockResolvedValue([
      toolset({ name: 'web', label: 'Local Web Search', description: 'local should not override' }),
      toolset({ name: 'local-dev', label: 'Local Dev Tools', description: 'local scripts' })
    ])
    $enterprise.set(
      managedEnterpriseState({
        toolPolicySnapshot: {
          skills: [],
          toolSets: [
            {
              key: 'web',
              displayName: 'Enterprise Web',
              description: 'governed browser access',
              status: 'recommended',
              source: 'enterprise'
            }
          ],
          tools: [],
          mcpServers: [],
          capabilityFlags: {},
          policyVersion: 'pv-tools',
          policyHash: 'hash-tools',
          generatedAt: '2026-07-06T12:00:00Z'
        }
      })
    )

    await renderSkills()

    expect(await screen.findByText('Enterprise Web')).toBeTruthy()
    expect(screen.queryByText('Local Web Search')).toBeNull()
    expect(screen.getByText(/Web search and scraping/)).toBeTruthy()
    expect(screen.getByText('Local Dev Tools')).toBeTruthy()
    expect(screen.getByText('Recommended')).toBeTruthy()
    expect(screen.getByText('User')).toBeTruthy()
  })

  it('uses runtime toolset keys when enterprise policy keys are catalog-prefixed', async () => {
    getToolsets.mockResolvedValue([toolset({ name: 'web', label: 'Local Web Search', description: 'local browser' })])
    $enterprise.set(
      managedEnterpriseState({
        toolPolicySnapshot: {
          skills: [],
          toolSets: [
            {
              key: 'toolset.web',
              displayName: 'Enterprise Web',
              description: 'governed browser access',
              status: 'available',
              source: 'enterprise'
            }
          ],
          tools: [],
          mcpServers: [],
          capabilityFlags: {},
          policyVersion: 'pv-tools',
          policyHash: 'hash-tools',
          generatedAt: '2026-07-06T12:00:00Z'
        }
      })
    )

    await renderSkills()

    expect(await screen.findByText('Enterprise Web')).toBeTruthy()
    const sw = screen.getByRole('switch', { name: 'Toggle Enterprise Web toolset' })
    fireEvent.click(sw)
    await waitFor(() => expect(toggleToolset).toHaveBeenCalledWith('web', false))
  })

  it('disables restricted toolset toggle and provider setup entry', async () => {
    getToolsets.mockResolvedValue([toolset({ name: 'web', enabled: true, configured: true })])
    $enterprise.set(
      managedEnterpriseState({
        toolPolicySnapshot: {
          skills: [],
          toolSets: [
            {
              key: 'web',
              localizedDisplay: { zh: { displayName: '企业浏览器', description: '由企业策略限制' } },
              displayName: 'Enterprise Browser',
              status: 'restricted',
              reason: 'Admin approval required',
              source: 'enterprise'
            }
          ],
          tools: [],
          mcpServers: [{ key: 'filesystem', displayName: 'Filesystem MCP', status: 'blocked' }],
          capabilityFlags: { mcpInstall: false, mcpProbe: false, mcpTest: false },
          policyVersion: 'pv-tools',
          policyHash: 'hash-tools',
          generatedAt: '2026-07-06T12:00:00Z'
        }
      })
    )

    await renderSkills()

    expect(await screen.findByText('企业浏览器')).toBeTruthy()
    expect(screen.getAllByText('Restricted').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('Needs keys')).toBeNull()
    expect(screen.getByText(/Web search and scraping/)).toBeTruthy()

    const sw = screen.getByRole('switch', { name: 'Toggle 企业浏览器 toolset' })
    expect(sw.getAttribute('disabled')).not.toBeNull()
    fireEvent.click(sw)
    expect(toggleToolset).not.toHaveBeenCalled()

    expect(screen.queryByRole('button', { name: 'Configure 企业浏览器' })).toBeNull()
    expect(getToolsetConfig).not.toHaveBeenCalled()
  })

  it('shows Blocked instead of Needs keys for blocked enterprise toolsets', async () => {
    getToolsets.mockResolvedValue([toolset({ name: 'web', enabled: false, configured: true })])
    $enterprise.set(
      managedEnterpriseState({
        toolPolicySnapshot: {
          skills: [],
          toolSets: [
            {
              key: 'web',
              displayName: 'Enterprise Web',
              description: 'blocked by enterprise policy',
              status: 'blocked',
              source: 'enterprise'
            }
          ],
          tools: [],
          mcpServers: [],
          capabilityFlags: {},
          policyVersion: 'pv-tools',
          policyHash: 'hash-tools',
          generatedAt: '2026-07-06T12:00:00Z'
        }
      })
    )

    await renderSkills()

    expect(await screen.findByText('Enterprise Web')).toBeTruthy()
    expect(screen.getAllByText('Blocked').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('Needs keys')).toBeNull()

    expect(screen.queryByRole('button', { name: 'Configure Enterprise Web' })).toBeNull()
    expect(getToolsetConfig).not.toHaveBeenCalled()
  })

  it('expands localized toolset details without enabling locked controls', async () => {
    getToolsets.mockResolvedValue([toolset({ name: 'web', enabled: false, configured: false })])
    $enterprise.set(
      managedEnterpriseState({
        toolPolicySnapshot: {
          skills: [],
          toolSets: [
            {
              key: 'web',
              displayName: 'Web Search',
              description: 'web_search, web_extract',
              status: 'blocked',
              source: 'enterprise'
            }
          ],
          tools: [],
          mcpServers: [],
          capabilityFlags: {},
          policyVersion: 'pv-tools',
          policyHash: 'hash-tools',
          generatedAt: '2026-07-06T12:00:00Z'
        }
      })
    )

    await renderSkills('toolsets', 'zh')

    const sw = await screen.findByRole('switch', { name: '切换 Web Search 工具集' })
    expect(sw.getAttribute('disabled')).not.toBeNull()

    const detailButton = await screen.findByRole('button', { name: '查看 Web Search 详情' })
    fireEvent.click(detailButton)

    expect(screen.getAllByText(/用于网页搜索和抓取/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/当前会话工具/)).toBeTruthy()
    expect(screen.getByText(/不会进入当前会话 callable tools/)).toBeTruthy()
    expect(screen.getByText('包含工具')).toBeTruthy()

    fireEvent.click(sw)
    expect(toggleToolset).not.toHaveBeenCalled()
  })

  it('disables blocked skill toggles and uses Chinese display/status fallback', async () => {
    getSkills.mockResolvedValue([skill({ name: 'terminal', description: 'local terminal', enabled: true })])
    $enterprise.set(
      managedEnterpriseState({
        toolPolicySnapshot: {
          skills: [
            {
              key: 'terminal',
              localizedDisplay: {
                zh: { displayName: '终端执行', description: '禁止本地命令' },
                en: { displayName: 'Terminal Execution' }
              },
              displayName: 'Terminal',
              status: 'blocked',
              reason: 'No shell access'
            },
            {
              key: 'browser',
              localizedDisplay: { en: { displayName: 'Browser Skill', description: 'English fallback' } },
              displayName: 'Browser',
              status: 'available'
            }
          ],
          toolSets: [],
          tools: [],
          mcpServers: [],
          capabilityFlags: {},
          policyVersion: 'pv-tools',
          policyHash: 'hash-tools',
          generatedAt: '2026-07-06T12:00:00Z'
        }
      })
    )

    await renderSkills('skills', 'zh')

    expect(await screen.findByText('终端执行')).toBeTruthy()
    expect(screen.getByText(/禁止本地命令/)).toBeTruthy()
    expect(screen.getAllByText('已禁止').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Browser Skill')).toBeTruthy()
    expect(screen.getByText(/English fallback/)).toBeTruthy()

    const terminalSwitch = screen.getByRole('switch', { name: '切换 终端执行 技能' })
    expect(terminalSwitch.getAttribute('disabled')).not.toBeNull()
    fireEvent.click(terminalSwitch)
    expect(toggleSkill).not.toHaveBeenCalled()
  })

  it('loads and shows raw SKILL.md content from a skill detail row', async () => {
    getSkills.mockResolvedValue([skill({ name: 'terminal', description: 'Local terminal', enabled: true })])

    await renderSkills('skills', 'zh')

    const detailButton = await screen.findByRole('button', { name: '查看 terminal 详情' })
    fireEvent.click(detailButton)

    await waitFor(() => expect(getSkillContent).toHaveBeenCalledWith('terminal'))
    expect(screen.getByText('原始 SKILL.md')).toBeTruthy()
    expect(screen.getByText(/# Terminal/)).toBeTruthy()
    expect(screen.getByText(/技能只提供行为指导/)).toBeTruthy()
  })

  it('keeps the skill list usable when SKILL.md content fails to load', async () => {
    getSkills.mockResolvedValue([skill({ name: 'terminal', description: 'Local terminal', enabled: true })])
    getSkillContent.mockRejectedValueOnce(new Error('missing skill file'))

    await renderSkills('skills', 'zh')

    const skillSwitch = await screen.findByRole('switch', { name: '切换 terminal 技能' })
    const detailButton = await screen.findByRole('button', { name: '查看 terminal 详情' })
    fireEvent.click(detailButton)

    expect(await screen.findByText('读取 terminal 的 SKILL.md 失败。')).toBeTruthy()
    expect(skillSwitch).toBeTruthy()
  })

  it('falls back to local runtime lists when the old enterprise manifest has no tool policy snapshot', async () => {
    getToolsets.mockResolvedValue([toolset({ name: 'web', label: 'Web Search' })])
    $enterprise.set(
      managedEnterpriseState({
        policyHash: null,
        generatedAt: null,
        toolPolicySnapshot: null
      })
    )

    await renderSkills()

    expect(await screen.findByText('Web Search')).toBeTruthy()
    const sw = screen.getByRole('switch', { name: 'Toggle Web Search toolset' })
    fireEvent.click(sw)
    await waitFor(() => expect(toggleToolset).toHaveBeenCalledWith('web', false))
  })
})
