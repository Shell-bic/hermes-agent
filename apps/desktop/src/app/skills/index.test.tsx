import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function renderSkills(tab: 'skills' | 'toolsets' = 'toolsets', locale: Locale = 'en') {
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
})

afterEach(() => {
  cleanup()
  $enterprise.set(INITIAL_ENTERPRISE_STATE)
  vi.clearAllMocks()
})

describe('SkillsView toolset management', () => {
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
