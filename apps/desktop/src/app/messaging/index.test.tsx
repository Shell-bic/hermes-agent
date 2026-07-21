import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnterpriseWeComPersonalBotState } from '@/global'
import { I18nProvider } from '@/i18n'
import { $enterprise, INITIAL_ENTERPRISE_STATE } from '@/store/enterprise'

const getMessagingPlatforms = vi.fn()
const listAllProfileSessions = vi.fn()
const refresh = vi.fn()
const revoke = vi.fn()
const unlinkIdentity = vi.fn()

vi.mock('@/hermes', () => ({
  getMessagingPlatforms: () => getMessagingPlatforms(),
  listAllProfileSessions: (...args: unknown[]) => listAllProfileSessions(...args),
  updateMessagingPlatform: vi.fn()
}))

const state: EnterpriseWeComPersonalBotState = {
  authorizationPending: false,
  binding: {
    bindingId: '11234567-89ab-4def-8abc-0123456789ab',
    createdAt: '2026-07-15T10:00:00Z',
    displayName: 'Hermes Bot',
    updatedAt: '2026-07-15T10:01:00Z'
  },
  channel: { errorCode: null, localStopped: false, serverRevokePending: false, status: 'connected' },
  identity: {
    claim: {
      bindingId: '11234567-89ab-4def-8abc-0123456789ab',
      claimId: '21234567-89ab-4def-8abc-0123456789ab',
      code: '482731',
      contractVersion: 'wecom-channel-identity.v1',
      expiresAt: '2026-07-15T10:06:00Z',
      failedAttempts: 0,
      status: 'pending'
    },
    errorCode: null,
    link: null,
    status: 'pending'
  }
}

beforeEach(() => {
  refresh.mockResolvedValue(state)
  listAllProfileSessions.mockResolvedValue({
    limit: 8,
    offset: 0,
    sessions: [{
      channel_identity_label: '贝佳豪',
      channel_identity_match_scope: 'exact',
      channel_identity_status: 'mapped',
      id: 'wecom-session',
      message_count: 2,
      title: '企业微信会话'
    }],
    total: 1
  })
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      enterprise: {
        weComBot: {
          cancel: vi.fn(),
          focusAuthorization: vi.fn(),
          onState: () => () => {},
          onSessionEvent: () => () => {},
          regenerateVerification: vi.fn(),
          refresh,
          revoke,
          unlinkIdentity,
          start: vi.fn()
        }
      }
    }
  })
  $enterprise.set({
    ...INITIAL_ENTERPRISE_STATE,
    authenticated: true,
    enabled: true,
    messagingChannelPolicy: {
      allowedChannelIds: ['wecom-personal'],
      hideUnlisted: true,
      mode: 'managed',
      policy: null,
      reason: null,
      status: 'applied',
      userManageableChannelIds: ['wecom-personal'],
      visibleChannelIds: ['wecom-personal']
    },
    status: 'authenticated'
  })
})

afterEach(() => {
  cleanup()
  $enterprise.set(INITIAL_ENTERPRISE_STATE)
  vi.clearAllMocks()
})

describe('managed messaging policy', () => {
  it('shows only the personal WeCom product surface and owner verification code', async () => {
    const { MessagingView } = await import('./index')
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <MemoryRouter initialEntries={['/messaging']}>
          <MessagingView />
        </MemoryRouter>
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByText('482731')).toBeTruthy())
    expect(screen.getByText(/尚未认领的私聊和群聊也可以正常使用机器人/)).toBeTruthy()
    expect(screen.getByText('Bot 渠道')).toBeTruthy()
    expect(screen.getByText('企业身份')).toBeTruthy()
    expect(screen.getByText('已识别 · 贝佳豪 · exact')).toBeTruthy()
    expect(screen.getAllByText('企业微信个人机器人').length).toBeGreaterThan(0)
    expect(getMessagingPlatforms).not.toHaveBeenCalled()
    expect(listAllProfileSessions).toHaveBeenCalledWith(8, 0, 'exclude', 'recent', 'all', { source: 'wecom' })
  }, 60_000)

  it('keeps channel and identity controls independent for a verified mapping', async () => {
    refresh.mockResolvedValue({
      ...state,
      identity: {
        claim: null,
        errorCode: null,
        link: {
          channelUserIdHint: 'woPx…IrMg',
          contractVersion: 'wecom-channel-identity.v1',
          displayName: '贝佳豪',
          linkId: '31234567-89ab-4def-8abc-0123456789ab',
          userName: 'beijiahao',
          verificationMethod: 'claim-code',
          verifiedAt: '2026-07-15T10:02:00Z'
        },
        status: 'verified'
      }
    })
    unlinkIdentity.mockResolvedValue(state)
    const { MessagingView } = await import('./index')
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <MemoryRouter initialEntries={['/messaging']}><MessagingView /></MemoryRouter>
      </I18nProvider>
    )
    await waitFor(() => expect(screen.getByText('已关联企业身份')).toBeTruthy())
    expect(screen.getAllByText('已连接').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '解除身份关联' }))
    await waitFor(() => expect(unlinkIdentity).toHaveBeenCalledTimes(1))
    expect(revoke).not.toHaveBeenCalled()
  }, 60_000)

  it('shows local-stopped/server-pending without presenting identity as the channel failure', async () => {
    refresh.mockResolvedValue({
      ...state,
      channel: {
        errorCode: 'gateway-offline',
        localStopped: true,
        serverRevokePending: true,
        status: 'offline'
      }
    })
    const { MessagingView } = await import('./index')
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <MemoryRouter initialEntries={['/messaging']}><MessagingView /></MemoryRouter>
      </I18nProvider>
    )
    await waitFor(() => expect(screen.getByText(/机器人已在本机停止，但服务器解绑仍待重试/)).toBeTruthy())
    expect(screen.getByText('等待认领')).toBeTruthy()
  }, 60_000)
})
