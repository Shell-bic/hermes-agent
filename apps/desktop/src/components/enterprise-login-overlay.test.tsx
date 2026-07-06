import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $enterprise, INITIAL_ENTERPRISE_STATE } from '@/store/enterprise'

import { EnterpriseLoginOverlay } from './enterprise-login-overlay'

const enterpriseState = {
  ...INITIAL_ENTERPRISE_STATE,
  authenticated: false,
  enabled: true,
  status: 'unauthenticated' as const,
  user: { displayName: 'Alice Zhang' }
}

function renderOverlay(initialLocale: 'en' | 'zh') {
  render(
    <I18nProvider configClient={null} initialLocale={initialLocale}>
      <EnterpriseLoginOverlay />
    </I18nProvider>
  )
}

beforeEach(() => {
  $enterprise.set(enterpriseState)
  window.hermesDesktop = {
    enterprise: {
      login: vi.fn(),
      logout: vi.fn(),
      selectModel: vi.fn(),
      status: vi.fn().mockResolvedValue(enterpriseState)
    }
  } as unknown as typeof window.hermesDesktop
})

afterEach(() => {
  cleanup()
  $enterprise.set(INITIAL_ENTERPRISE_STATE)
  window.hermesDesktop = undefined as unknown as typeof window.hermesDesktop
})

describe('EnterpriseLoginOverlay i18n', () => {
  it('renders the enterprise sign-in overlay in Simplified Chinese', () => {
    renderOverlay('zh')

    expect(screen.getByRole('heading', { name: '企业账号登录' })).toBeTruthy()
    expect(screen.getByText('登录企业账号后即可启动受管 Hermes 运行时。')).toBeTruthy()
    expect(screen.getByPlaceholderText('用户名')).toBeTruthy()
    expect(screen.getByPlaceholderText('密码')).toBeTruthy()
    expect(screen.getByText('已缓存账号：Alice Zhang')).toBeTruthy()
    expect(screen.getByRole('button', { name: /刷新/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /登录/ })).toBeTruthy()
  })

  it('keeps the enterprise sign-in overlay in English for the English locale', () => {
    renderOverlay('en')

    expect(screen.getByRole('heading', { name: 'Enterprise sign in' })).toBeTruthy()
    expect(screen.getByText('Sign in with your enterprise account to start the managed Hermes runtime.')).toBeTruthy()
    expect(screen.getByPlaceholderText('Username')).toBeTruthy()
    expect(screen.getByPlaceholderText('Password')).toBeTruthy()
    expect(screen.getByText('Cached account: Alice Zhang')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Sign in/ })).toBeTruthy()
  })

  it('localizes the enterprise service fallback error', () => {
    $enterprise.set({
      ...enterpriseState,
      error: '',
      status: 'error'
    })

    renderOverlay('zh')

    expect(screen.getAllByText('企业服务暂不可用。').length).toBeGreaterThan(0)
  })
})
