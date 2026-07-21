import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { EnterpriseLoginMethod, EnterpriseLoginStatus } from '@/global'
import { useI18n } from '@/i18n'
import { Loader2, Lock, LogIn, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $enterprise,
  $enterpriseLogin,
  cancelEnterpriseWeCom,
  initializeEnterpriseLogin,
  loginEnterprise,
  refreshEnterpriseState,
  refreshEnterpriseWeCom,
  selectEnterpriseLoginMethod,
  setEnterpriseWeComBounds,
  subscribeEnterpriseLogin
} from '@/store/enterprise'

interface EnterpriseLoginOverlayProps {
  onAuthenticated?: () => void
}

function displayName(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return ''
  }

  const record = value as Record<string, unknown>

  return String(record.displayName || record.name || record.username || record.email || '').trim()
}

function qrViewVisible(status: EnterpriseLoginStatus, expiresAt: string | null): boolean {
  return status === 'qr-pending' || (status === 'gateway-offline' && Boolean(expiresAt))
}

export function EnterpriseLoginOverlay({ onAuthenticated }: EnterpriseLoginOverlayProps) {
  const enterprise = useStore($enterprise)
  const login = useStore($enterpriseLogin)
  const { t } = useI18n()
  const copy = t.enterpriseLogin
  const qrSlotRef = useRef<HTMLDivElement>(null)
  const handledSuccessRef = useRef(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const unsubscribe = subscribeEnterpriseLogin()
    void refreshEnterpriseState()

    return () => {
      unsubscribe()
    }
  }, [])

  const loginRequired = enterprise.enabled && enterprise.status !== 'loading' && !enterprise.authenticated

  useEffect(() => {
    if (!loginRequired) {
      return
    }

    handledSuccessRef.current = false
    void initializeEnterpriseLogin()

    return () => {
      void cancelEnterpriseWeCom().catch(() => undefined)
      void setEnterpriseWeComBounds({ height: 0, visible: false, width: 0, x: 0, y: 0 }).catch(() => undefined)
    }
  }, [loginRequired])

  useEffect(() => {
    if (login.status !== 'success') {
      handledSuccessRef.current = false
    }
  }, [login.status])

  useEffect(() => {
    if (!login.expiresAt) {
      return
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(timer)
  }, [login.expiresAt])

  useEffect(() => {
    if (login.status !== 'success' || handledSuccessRef.current) {
      return
    }

    handledSuccessRef.current = true
    void refreshEnterpriseState().finally(() => onAuthenticated?.())
  }, [login.status, onAuthenticated])

  const updateQrBounds = useCallback(() => {
    const slot = qrSlotRef.current

    if (!slot) {
      return
    }

    const rect = slot.getBoundingClientRect()
    void setEnterpriseWeComBounds({
      height: rect.height,
      visible: login.selectedMethod === 'wecom-qr' && qrViewVisible(login.status, login.expiresAt),
      width: rect.width,
      x: rect.left,
      y: rect.top
    }).catch(() => undefined)
  }, [login.expiresAt, login.selectedMethod, login.status])

  useEffect(() => {
    updateQrBounds()
    window.addEventListener('resize', updateQrBounds)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateQrBounds)

    if (qrSlotRef.current) {
      observer?.observe(qrSlotRef.current)
    }

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateQrBounds)
      void setEnterpriseWeComBounds({ height: 0, visible: false, width: 0, x: 0, y: 0 }).catch(() => undefined)
    }
  }, [updateQrBounds])

  const remainingSeconds = useMemo(() => {
    if (!login.expiresAt) {
      return 0
    }

    return Math.max(0, Math.ceil((Date.parse(login.expiresAt) - now) / 1000))
  }, [login.expiresAt, now])

  if (!enterprise.enabled || enterprise.status === 'loading' || enterprise.authenticated) {
    return null
  }

  const selectMethod = (method: EnterpriseLoginMethod) => {
    if (login.status === 'qr-verified' || busy) {
      return
    }

    setPasswordError(null)
    void selectEnterpriseLoginMethod(method).catch(() => undefined)
  }

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (login.selectedMethod !== 'password') {
      return
    }

    setBusy(true)
    setPasswordError(null)

    try {
      await loginEnterprise({ password, username })
      onAuthenticated?.()
    } catch {
      setPasswordError(copy.passwordError)
    } finally {
      setBusy(false)
    }
  }

  const qrMessage = (() => {
    switch (login.status) {
      case 'methods-loading':

      case 'qr-preparing':
        return copy.preparingQr

      case 'qr-pending':
        return copy.pendingQr

      case 'qr-verified':
        return copy.verifiedQr

      case 'qr-expired':
        return copy.expiredQr

      case 'out-of-scope':
        return copy.outOfScope

      case 'gateway-offline':
        return copy.gatewayOffline

      case 'qr-canceled':

      case 'qr-error':
        return login.errorCode === 'qr-denied' ? copy.deniedQr : copy.genericQrError

      default:
        return copy.weComDescription
    }
  })()

  const cachedAccount = displayName(enterprise.user)
  const canSwitch = login.status !== 'qr-verified' && !busy

  const showQrRefresh = ['gateway-offline', 'out-of-scope', 'qr-canceled', 'qr-error', 'qr-expired'].includes(
    login.status
  )

  return (
    <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-(--ui-chat-surface-background) px-6">
      <form
        className="flex w-full max-w-[31rem] flex-col gap-4 border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) p-5 shadow-2xl"
        onSubmit={submitPassword}
      >
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-[4px] bg-(--ui-bg-tertiary) text-(--theme-primary)">
            <Lock className="size-4" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-(--ui-text-primary)">{copy.title}</h1>
            <p className="mt-1 text-xs leading-5 text-(--ui-text-secondary)">{copy.description}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-1">
          {login.methods.includes('wecom-qr') && (
            <Button
              aria-pressed={login.selectedMethod === 'wecom-qr'}
              disabled={!canSwitch}
              onClick={() => selectMethod('wecom-qr')}
              size="sm"
              type="button"
              variant={login.selectedMethod === 'wecom-qr' ? 'secondary' : 'ghost'}
            >
              {copy.weComTab}
            </Button>
          )}
          {login.methods.includes('password') && (
            <Button
              aria-pressed={login.selectedMethod === 'password'}
              disabled={!canSwitch}
              onClick={() => selectMethod('password')}
              size="sm"
              type="button"
              variant={login.selectedMethod === 'password' ? 'secondary' : 'ghost'}
            >
              {copy.passwordTab}
            </Button>
          )}
        </div>

        {login.selectedMethod === 'password' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Input
                autoComplete="username"
                autoFocus
                disabled={busy}
                onChange={event => setUsername(event.target.value)}
                placeholder={copy.usernamePlaceholder}
                value={username}
              />
              <Input
                autoComplete="current-password"
                disabled={busy}
                onChange={event => setPassword(event.target.value)}
                placeholder={copy.passwordPlaceholder}
                type="password"
                value={password}
              />
            </div>
            {passwordError && (
              <div className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
                {passwordError}
              </div>
            )}
            {cachedAccount && <div className="text-xs text-(--ui-text-secondary)">{copy.cachedAccount(cachedAccount)}</div>}
            <div className="flex justify-end">
              <Button disabled={busy || !username.trim() || !password} size="sm" type="submit">
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
                {copy.signIn}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="text-center">
              <h2 className="text-sm font-medium text-(--ui-text-primary)">{copy.weComTitle}</h2>
              {login.enterpriseDisplayName && (
                <p className="mt-1 text-xs text-(--ui-text-secondary)">{login.enterpriseDisplayName}</p>
              )}
            </div>
            <div
              aria-label={copy.weComTitle}
              className="relative grid h-[320px] w-[320px] place-items-center overflow-hidden border border-(--ui-stroke-secondary) bg-white"
              ref={qrSlotRef}
            >
              {!qrViewVisible(login.status, login.expiresAt) && (
                <div className="flex max-w-[13rem] flex-col items-center gap-3 px-4 text-center text-xs leading-5 text-neutral-700">
                  {(login.status === 'methods-loading' || login.status === 'qr-preparing' || login.status === 'qr-verified') && (
                    <Loader2 className="size-5 animate-spin" />
                  )}
                  <span>{qrMessage}</span>
                </div>
              )}
            </div>
            <div
              className={cn(
                'min-h-5 text-center text-xs leading-5 text-(--ui-text-secondary)',
                (login.status === 'out-of-scope' || login.status === 'qr-error') && 'text-destructive'
              )}
            >
              {qrViewVisible(login.status, login.expiresAt) && qrMessage}
              {remainingSeconds > 0 && login.status === 'qr-pending' && ` · ${copy.expiresIn(remainingSeconds)}`}
            </div>
            {showQrRefresh && (
              <Button onClick={() => void refreshEnterpriseWeCom()} size="sm" type="button" variant="secondary">
                <RefreshCw className="size-3.5" />
                {copy.refreshQr}
              </Button>
            )}
          </div>
        )}
      </form>
    </div>
  )
}
