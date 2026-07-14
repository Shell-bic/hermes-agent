import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnterpriseLoginState } from '@/global'
import { I18nProvider } from '@/i18n'
import {
  $enterprise,
  $enterpriseLogin,
  INITIAL_ENTERPRISE_LOGIN_STATE,
  INITIAL_ENTERPRISE_STATE
} from '@/store/enterprise'

import { EnterpriseLoginOverlay } from './enterprise-login-overlay'

const enterpriseState = {
  ...INITIAL_ENTERPRISE_STATE,
  authenticated: false,
  enabled: true,
  status: 'unauthenticated' as const,
  user: { displayName: 'Alice Zhang' }
}

const qrState: EnterpriseLoginState = {
  defaultMethod: 'wecom-qr',
  enterpriseDisplayName: 'Example Corp',
  errorCode: null,
  expiresAt: '2099-07-13T00:05:00Z',
  methods: ['wecom-qr', 'password'],
  selectedMethod: 'wecom-qr',
  status: 'qr-pending',
  user: null
}

let loginStateListener: ((state: EnterpriseLoginState) => void) | null = null

function installBridge(initial: EnterpriseLoginState = qrState) {
  window.hermesDesktop = {
    enterprise: {
      cancelWeCom: vi.fn().mockResolvedValue({ ...initial, status: 'qr-canceled' }),
      login: vi.fn(),
      loginMethods: vi.fn().mockResolvedValue(initial),
      loginState: vi.fn().mockResolvedValue(initial),
      logout: vi.fn(),
      onLoginState: vi.fn(callback => {
        loginStateListener = callback

        return () => {
          loginStateListener = null
        }
      }),
      refresh: vi.fn().mockResolvedValue(enterpriseState),
      refreshWeCom: vi.fn().mockResolvedValue(qrState),
      selectLoginMethod: vi.fn(async method => ({
        ...initial,
        selectedMethod: method,
        status: method === 'password' ? 'password-ready' : 'qr-pending'
      })),
      selectModel: vi.fn(),
      setWeComBounds: vi.fn().mockResolvedValue(initial),
      status: vi.fn().mockResolvedValue(enterpriseState)
    }
  } as unknown as typeof window.hermesDesktop
}

function renderOverlay(initialLocale: 'en' | 'zh', onAuthenticated?: () => void) {
  return render(
    <I18nProvider configClient={null} initialLocale={initialLocale}>
      <EnterpriseLoginOverlay onAuthenticated={onAuthenticated} />
    </I18nProvider>
  )
}

beforeEach(() => {
  $enterprise.set(enterpriseState)
  $enterpriseLogin.set(INITIAL_ENTERPRISE_LOGIN_STATE)
  installBridge()
})

afterEach(() => {
  cleanup()
  $enterprise.set(INITIAL_ENTERPRISE_STATE)
  $enterpriseLogin.set(INITIAL_ENTERPRISE_LOGIN_STATE)
  window.hermesDesktop = undefined as unknown as typeof window.hermesDesktop
  loginStateListener = null
})

describe('EnterpriseLoginOverlay', () => {
  it('defaults to the unified WeCom QR page and keeps password as an alternate method', async () => {
    renderOverlay('zh')

    expect(await screen.findByRole('heading', { name: '企业账号登录' })).toBeTruthy()
    expect((await screen.findByRole('button', { name: '企业微信扫码' })).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '账号密码' })).toBeTruthy()
    expect(screen.getByText('Example Corp')).toBeTruthy()
    expect(screen.getByText(/等待扫码确认/)).toBeTruthy()
    expect(screen.queryByPlaceholderText('用户名')).toBeNull()
  })

  it('switches to the existing username and password form and cancels the QR transaction in main', async () => {
    renderOverlay('en')
    const passwordTab = await screen.findByRole('button', { name: 'Username and password' })
    fireEvent.click(passwordTab)

    expect(await screen.findByPlaceholderText('Username')).toBeTruthy()
    expect(screen.getByPlaceholderText('Password')).toBeTruthy()
    expect(screen.getByText('Cached account: Alice Zhang')).toBeTruthy()
    expect(window.hermesDesktop.enterprise.selectLoginMethod).toHaveBeenCalledWith('password')
  })

  it('shows an explicit expired state and refreshes only on user action', async () => {
    const expired = { ...qrState, errorCode: 'qr-expired', status: 'qr-expired' as const }
    installBridge(expired)
    renderOverlay('zh')

    expect(await screen.findByText('二维码已过期，请刷新后重新扫码。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新二维码' }))
    expect(window.hermesDesktop.enterprise.refreshWeCom).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['out-of-scope', '当前企业微信账号无权使用此应用，请联系企业管理员。'],
    ['gateway-offline', '无法连接企业服务，请检查网络后重试。']
  ] as const)('renders the %s QR state without identity details', async (status, message) => {
    installBridge({ ...qrState, errorCode: status, status })
    renderOverlay('zh')
    expect(await screen.findByText(message)).toBeTruthy()
  })

  it('keeps the native QR visible while polling is offline with an active transaction', async () => {
    installBridge({ ...qrState, errorCode: 'gateway-offline', status: 'gateway-offline' })
    renderOverlay('zh')

    await screen.findByText('无法连接企业服务，请检查网络后重试。')
    await waitFor(() =>
      expect(window.hermesDesktop.enterprise.setWeComBounds).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: true })
      )
    )
  })

  it('shows the offline error inside the QR slot when no QR transaction was created', async () => {
    installBridge({
      ...INITIAL_ENTERPRISE_LOGIN_STATE,
      errorCode: 'gateway-offline',
      status: 'gateway-offline'
    })
    renderOverlay('zh')

    const qrSlot = await screen.findByLabelText('使用企业微信登录')
    expect(qrSlot.textContent).toContain('无法连接企业服务，请检查网络后重试。')
    await waitFor(() =>
      expect(window.hermesDesktop.enterprise.setWeComBounds).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: false })
      )
    )
  })

  it('shows the offline error inside the QR slot after a terminal failure destroys the transaction', async () => {
    installBridge({
      ...qrState,
      errorCode: 'gateway-offline',
      expiresAt: null,
      status: 'gateway-offline'
    })
    renderOverlay('zh')

    const qrSlot = await screen.findByLabelText('使用企业微信登录')
    expect(qrSlot.textContent).toContain('无法连接企业服务，请检查网络后重试。')
    await waitFor(() =>
      expect(window.hermesDesktop.enterprise.setWeComBounds).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: false })
      )
    )
  })

  it('retries method discovery after a cold-start outage and restores the password entry without remounting', async () => {
    installBridge({
      ...INITIAL_ENTERPRISE_LOGIN_STATE,
      errorCode: 'gateway-offline',
      status: 'gateway-offline'
    })
    renderOverlay('zh')

    fireEvent.click(await screen.findByRole('button', { name: '刷新二维码' }))
    expect(await screen.findByRole('button', { name: '企业微信扫码' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '账号密码' })).toBeTruthy()
    expect(window.hermesDesktop.enterprise.refreshWeCom).toHaveBeenCalledTimes(1)
  })

  it('uses a generic password error instead of exposing account enumeration details', async () => {
    installBridge({ ...qrState, selectedMethod: 'password', status: 'password-ready' })
    vi.mocked(window.hermesDesktop.enterprise.login).mockRejectedValue(new Error('User alice does not exist'))
    renderOverlay('en')

    fireEvent.change(await screen.findByPlaceholderText('Username'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('The username or password could not be verified. Check them and try again.')).toBeTruthy()
    expect(screen.queryByText('User alice does not exist')).toBeNull()
  })

  it('disables empty and in-flight password submissions to prevent duplicates', async () => {
    installBridge({ ...qrState, selectedMethod: 'password', status: 'password-ready' })
    let releaseLogin: (() => void) | null = null
    vi.mocked(window.hermesDesktop.enterprise.login).mockImplementation(
      () =>
        new Promise(resolve => {
          releaseLogin = () => resolve({ ...enterpriseState, authenticated: true, status: 'authenticated' })
        })
    )
    renderOverlay('en')

    const submit = await screen.findByRole('button', { name: 'Sign in' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'correct' } })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    expect(window.hermesDesktop.enterprise.login).toHaveBeenCalledTimes(1)

    await act(async () => releaseLogin?.())
  })

  it('renders preparing and denied QR states with stable non-enumerating copy', async () => {
    installBridge({ ...qrState, expiresAt: null, status: 'methods-loading' })
    const rendered = renderOverlay('zh')
    expect(await screen.findByText('正在准备企业微信二维码…')).toBeTruthy()
    rendered.unmount()

    installBridge({ ...qrState, errorCode: 'qr-denied', status: 'qr-error' })
    renderOverlay('zh')
    expect(await screen.findByText('本次登录未获授权，请重试或联系企业管理员。')).toBeTruthy()
  })

  it('uses the same authenticated exit when main reports QR success', async () => {
    const onAuthenticated = vi.fn()
    renderOverlay('zh', onAuthenticated)
    await screen.findByText('Example Corp')

    await act(async () => {
      loginStateListener?.({ ...qrState, expiresAt: null, status: 'success', user: { displayName: 'Ada' } })
    })
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))
  })

  it('reinitializes methods and completes a second QR login after logout without remounting', async () => {
    const onAuthenticated = vi.fn()

    const authenticatedState = {
      ...enterpriseState,
      authenticated: true,
      status: 'authenticated' as const,
      user: { displayName: 'Ada' }
    }

    let releaseInitialRefresh: (() => void) | null = null
    vi.mocked(window.hermesDesktop.enterprise.status)
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            releaseInitialRefresh = () => resolve(enterpriseState)
          })
      )
      .mockResolvedValue(authenticatedState)

    renderOverlay('zh', onAuthenticated)
    await screen.findByText('Example Corp')
    await waitFor(() => expect(window.hermesDesktop.enterprise.loginMethods).toHaveBeenCalledTimes(1))
    await act(async () => releaseInitialRefresh?.())

    await act(async () => {
      loginStateListener?.({ ...qrState, expiresAt: null, status: 'success', user: { displayName: 'Ada' } })
    })
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))
    await waitFor(() => expect($enterprise.get().authenticated).toBe(true))

    await act(async () => {
      $enterprise.set(enterpriseState)
      $enterpriseLogin.set(INITIAL_ENTERPRISE_LOGIN_STATE)
    })
    await waitFor(() => expect(window.hermesDesktop.enterprise.loginMethods).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Example Corp')).toBeTruthy()

    await act(async () => {
      loginStateListener?.({ ...qrState, expiresAt: null, status: 'success', user: { displayName: 'Ada' } })
    })
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(2))
    expect(window.hermesDesktop.enterprise.status).toHaveBeenCalledTimes(3)
  })
})
