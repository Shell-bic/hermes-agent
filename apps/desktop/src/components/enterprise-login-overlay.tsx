import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, Lock, LogIn, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $enterprise, loginEnterprise, refreshEnterpriseState } from '@/store/enterprise'

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

export function EnterpriseLoginOverlay({ onAuthenticated }: EnterpriseLoginOverlayProps) {
  const enterprise = useStore($enterprise)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void refreshEnterpriseState()
  }, [])

  if (!enterprise.enabled || enterprise.authenticated) {
    return null
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError(null)

    try {
      await loginEnterprise({ password, username })
      onAuthenticated?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const retry = () => {
    setError(null)
    void refreshEnterpriseState()
  }

  const message =
    enterprise.status === 'error'
      ? enterprise.error || 'Enterprise service is unavailable.'
      : 'Sign in with your enterprise account to start the managed Hermes runtime.'

  return (
    <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-(--ui-chat-surface-background) px-6">
      <form
        className="flex w-full max-w-[22rem] flex-col gap-4 border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) p-5 shadow-2xl"
        onSubmit={submit}
      >
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-[4px] bg-(--ui-bg-tertiary) text-(--theme-primary)">
            <Lock className="size-4" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-(--ui-text-primary)">Enterprise sign in</h1>
            <p className="mt-1 text-xs leading-5 text-(--ui-text-secondary)">{message}</p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Input
            autoComplete="username"
            autoFocus
            disabled={busy}
            onChange={event => setUsername(event.target.value)}
            placeholder="Username"
            value={username}
          />
          <Input
            autoComplete="current-password"
            disabled={busy}
            onChange={event => setPassword(event.target.value)}
            placeholder="Password"
            type="password"
            value={password}
          />
        </div>

        {(error || enterprise.error) && (
          <div className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
            {error || enterprise.error}
          </div>
        )}

        {displayName(enterprise.user) && (
          <div className="text-xs text-(--ui-text-secondary)">Cached account: {displayName(enterprise.user)}</div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button disabled={busy} onClick={retry} size="sm" type="button" variant="ghost">
            <RefreshCw className={cn('size-3.5', enterprise.status === 'loading' && 'animate-spin')} />
            Refresh
          </Button>
          <Button disabled={busy || !username.trim() || !password} size="sm" type="submit">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
            Sign in
          </Button>
        </div>
      </form>
    </div>
  )
}
