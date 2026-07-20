import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnterpriseDesktopState } from '@/global'
import { translateNow } from '@/i18n'
import { $desktopBoot } from '@/store/boot'
import { $enterprise, INITIAL_ENTERPRISE_STATE } from '@/store/enterprise'
import { beginGatewayRuntime, ensureGatewayForProfile } from '@/store/gateway'
import { $gatewayState } from '@/store/session'

import { useGatewayBoot } from './use-gateway-boot'

// End-to-end-ish repro of the "remote VPS → stuck on CONNECTING, no Settings"
// bug that drives the REAL useGatewayBoot hook + REAL HermesGateway through a
// fake WebSocket we fully control. No Docker / no real port: from the desktop's
// point of view a "remote VPS" is just a WebSocket that opens once and later
// refuses to reopen, so that is exactly (and only) what we fake.
//
// The previous test (gateway-connecting-overlay.test.tsx) hand-set the stores
// and asserted the overlays; this one proves the HOOK actually PRODUCES that
// stuck store combo — closing the "inferred by reading code" gap on the
// post-boot reconnect loop.

type Listener = (ev: unknown) => void

// Minimal WebSocket stand-in implementing only what json-rpc-gateway.connect()
// touches: readyState, add/removeEventListener('open'|'error'|'close'), close().
class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  // Flipped by the test: 'open' = next socket connects; 'fail' = next socket
  // errors (a dead remote). Mirrors a VPS going away after the first connect.
  static mode: 'open' | 'fail' = 'open'
  static instances: FakeWebSocket[] = []

  readyState = 0
  private listeners: Record<string, Set<Listener>> = {}

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
    const willOpen = FakeWebSocket.mode === 'open'
    // Resolve on the next microtask/macrotask so connect()'s promise wiring is
    // in place before open/error fires (matches real async socket handshake).
    setTimeout(() => {
      if (willOpen) {
        this.readyState = FakeWebSocket.OPEN
        this.emit('open', {})
      } else {
        this.readyState = FakeWebSocket.CLOSED
        this.emit('error', {})
      }
    }, 0)
  }

  addEventListener(type: string, fn: Listener) {
    ;(this.listeners[type] ??= new Set()).add(fn)
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners[type]?.delete(fn)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  // Force-drop an open socket, as a sleeping laptop / restarted remote would.
  drop() {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  private emit(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) {
      fn(ev)
    }
  }
}

function fakeDesktop(authMode: 'oauth' | 'token' = 'token') {
  const conn = {
    authMode,
    baseUrl: 'https://vps.example.com',
    profile: 'default',
    token: 't',
    wsUrl: 'wss://vps.example.com/api/ws?token=t'
  }

  let runtimeRevokeCallback: (() => Promise<void> | void) | null = null

  return {
    applyConnectionConfig: vi.fn(async () => undefined),
    enterprise: {
      lifecycleStatus: vi.fn(async () => ({
        authEpoch: 0,
        lifecycleEpoch: 0,
        reasonCode: 'ready',
        state: 'running' as 'blocked' | 'recovering' | 'revoking' | 'running' | 'stop_failed' | 'unauthenticated'
      })),
      status: vi.fn(async (): Promise<EnterpriseDesktopState> => ({
        ...INITIAL_ENTERPRISE_STATE,
        enabled: false,
        status: 'disabled'
      }))
    },
    getConnection: vi.fn(async (_profile?: string | null) => conn),
    getGatewayWsUrl: vi.fn(async () => conn.wsUrl),
    revalidateConnection: vi.fn(async () => ({ ok: true, rebuilt: false })),
    getBootProgress: vi.fn(async () => ({
      error: null,
      fakeMode: false,
      message: '',
      phase: 'init',
      progress: 0,
      running: true,
      timestamp: Date.now()
    })),
    onBootProgress: vi.fn(() => () => undefined),
    onBackendExit: vi.fn(() => () => undefined),
    onEnterpriseRuntimeRevoked: vi.fn((callback: () => Promise<void> | void) => {
      runtimeRevokeCallback = callback
      return () => {
        runtimeRevokeCallback = null
      }
    }),
    onPowerResume: vi.fn(() => () => undefined),
    onWindowStateChanged: vi.fn(() => () => undefined),
    oauthLoginConnectionConfig: vi.fn(async () => ({ connected: false })),
    touchBackend: vi.fn(async () => undefined),
    profile: { get: vi.fn(async () => ({ profile: 'default' })) },
    repairBootstrap: vi.fn(async () => ({ ok: true })),
    resetBootstrap: vi.fn(async () => ({ ok: true })),
    revokeRuntime: async () => runtimeRevokeCallback?.(),
    updates: { check: vi.fn(async () => ({ supported: true })) }
  }
}

function sessionRequiredError() {
  return Object.assign(new Error('Sign in to your enterprise account and try again.'), {
    code: 'desktop_session_required',
    envelope: 'enterprise-public-error.v1' as const,
    errorCode: 'desktop_session_required',
    httpStatus: 401,
    lifecycleEpoch: 9,
    recoveryKind: 'sign-in' as const,
    status: 401
  })
}

function Harness() {
  useGatewayBoot({
    handleGatewayEvent: () => undefined,
    onConnectionReady: () => undefined,
    onGatewayReady: () => undefined,
    refreshHermesConfig: async () => undefined,
    refreshSessions: async () => undefined
  })

  return null
}

function DisabledHarness() {
  useGatewayBoot({
    enabled: false,
    handleGatewayEvent: () => undefined,
    onConnectionReady: () => undefined,
    onGatewayReady: () => undefined,
    refreshHermesConfig: async () => undefined,
    refreshSessions: async () => undefined
  })

  return null
}

const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.mode = 'open'
  FakeWebSocket.instances = []
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
  ;(window as { hermesDesktop?: unknown }).hermesDesktop = fakeDesktop()
  $gatewayState.set('idle')
  $enterprise.set({
    ...INITIAL_ENTERPRISE_STATE,
    authenticated: true,
    enabled: true,
    status: 'authenticated'
  })
  $desktopBoot.set({
    enterpriseManaged: true,
    error: null,
    fakeMode: false,
    message: '',
    phase: 'init',
    progress: 0,
    running: true,
    timestamp: Date.now(),
    visible: true
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  ;(globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
  $enterprise.set(INITIAL_ENTERPRISE_STATE)
})

// Let pending microtasks (awaits) AND the queued 0ms socket open/error fire.
async function flushAsync() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

// Drive the exponential backoff forward by its full cap so the next scheduled
// reconnect attempt actually runs (1s,2s,4s,8s,15s,15s…). Returns after the
// attempt's async work settles.
async function advanceBackoff() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
}

describe('useGatewayBoot remote reconnect loop (real hook, fake socket)', () => {
  it('hands a terminal managed 401 to authoritative enterprise state without boot recovery actions', async () => {
    const desktop = fakeDesktop()
    desktop.getConnection = vi.fn(async () => {
      throw sessionRequiredError()
    })
    desktop.enterprise.status.mockResolvedValue({
      ...INITIAL_ENTERPRISE_STATE,
      authenticated: false,
      enabled: true,
      status: 'unauthenticated'
    })
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop

    render(<Harness />)
    await flushAsync()

    expect(desktop.enterprise.status).toHaveBeenCalledTimes(1)
    expect($enterprise.get()).toMatchObject({ authenticated: false, enabled: true, status: 'unauthenticated' })
    expect($desktopBoot.get()).toMatchObject({ error: null, running: false, visible: false })
    expect($gatewayState.get()).toBe('closed')
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(desktop.revalidateConnection).not.toHaveBeenCalled()
    expect(desktop.applyConnectionConfig).not.toHaveBeenCalled()
    expect(desktop.oauthLoginConnectionConfig).not.toHaveBeenCalled()
    expect(desktop.repairBootstrap).not.toHaveBeenCalled()
    expect(desktop.resetBootstrap).not.toHaveBeenCalled()
    expect(desktop.updates.check).not.toHaveBeenCalled()
  })

  it('uses the same single-flight sign-in handoff when runtime revocation wins the race with the 401 catch', async () => {
    let rejectConnection: (error: Error) => void = () => undefined
    let releaseStatus: (() => void) | null = null
    const desktop = fakeDesktop()
    desktop.getConnection = vi.fn(
      () => new Promise((_resolve, reject) => {
        rejectConnection = reject
      })
    )
    desktop.enterprise.status.mockImplementation(
      () => new Promise(resolve => {
        releaseStatus = () => resolve({
          ...INITIAL_ENTERPRISE_STATE,
          authenticated: false,
          enabled: true,
          status: 'unauthenticated'
        })
      })
    )
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop

    render(<Harness />)
    await flushAsync()
    await act(async () => {
      const revocation = desktop.revokeRuntime()
      rejectConnection(sessionRequiredError())
      releaseStatus?.()
      await revocation
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(desktop.enterprise.status).toHaveBeenCalledTimes(1)
    expect($enterprise.get()).toMatchObject({ authenticated: false, enabled: true, status: 'unauthenticated' })
    expect($desktopBoot.get()).toMatchObject({ error: null, running: false, visible: false })
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(desktop.getConnection).toHaveBeenCalledTimes(1)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('does not let an earlier blocked revocation suppress a later terminal 401 refresh', async () => {
    let rejectConnection: (error: Error) => void = () => undefined
    const desktop = fakeDesktop()
    desktop.getConnection = vi.fn(
      () => new Promise((_resolve, reject) => {
        rejectConnection = reject
      })
    )
    desktop.enterprise.status
      .mockResolvedValueOnce({
        ...INITIAL_ENTERPRISE_STATE,
        authenticated: true,
        enabled: true,
        status: 'authenticated'
      })
      .mockResolvedValueOnce({
        ...INITIAL_ENTERPRISE_STATE,
        authenticated: false,
        enabled: true,
        status: 'unauthenticated'
      })
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop

    render(<Harness />)
    await flushAsync()
    await act(async () => {
      await desktop.revokeRuntime()
      rejectConnection(sessionRequiredError())
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(desktop.enterprise.status).toHaveBeenCalledTimes(2)
    expect($enterprise.get()).toMatchObject({ authenticated: false, status: 'unauthenticated' })
    expect($desktopBoot.get()).toMatchObject({ error: null, visible: false })
  })

  it('enterprise sign-in wait dismisses the boot overlay so the login form can render', () => {
    render(<DisabledHarness />)

    expect($desktopBoot.get().visible).toBe(false)
    expect($desktopBoot.get().running).toBe(false)
    expect($desktopBoot.get().progress).toBe(100)
  })

  it('INITIAL boot against a dead VPS: getConnection hangs (waitForHermes) → app sits in the connecting combo, then fails', async () => {
    // The report's actual path: a fresh launch pointed at an unreachable VPS.
    // startHermes()'s remote branch awaits waitForHermes() for 45s before it
    // throws, so the renderer's `await desktop.getConnection()` stays pending
    // that whole window. During it: gatewayState is still 'idle' (connect was
    // never reached) and boot.error is null → connecting=true → the fullscreen
    // CONNECTING overlay, latched, blocking Settings.
    let rejectConn: (e: Error) => void = () => undefined
    const desktop = fakeDesktop()
    desktop.getConnection = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectConn = reject
        })
    )
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop

    render(<Harness />)
    await flushAsync()

    // getConnection is still pending — the dead-VPS wait. No socket was ever
    // created, gatewayState never left idle, boot.error is null.
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect($gatewayState.get()).not.toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    // ^ connecting === true here → fullscreen CONNECTING, no Settings.

    // After ~45s waitForHermes gives up and getConnection rejects → boot()
    // catch → failDesktopBoot → the BootFailureOverlay recovery surface.
    await act(async () => {
      rejectConn(new Error('Hermes backend did not become ready: timeout'))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect($desktopBoot.get().error).toBeTruthy()
  })

  it('a remote that drops post-boot keeps looping with NO boot.error (the dead-end CONNECTING combo)', async () => {
    render(<Harness />)
    await flushAsync()

    // Initial boot connected.
    expect($gatewayState.get()).toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(1)

    // The remote VPS goes away: drop the live socket, and make every reopen
    // fail from here on.
    FakeWebSocket.mode = 'fail'
    act(() => FakeWebSocket.instances[0].drop())
    await flushAsync()

    // Burn a couple backoff cycles BEFORE the escalation threshold (<6 attempts,
    // ~the first ~15s). This is the window where stock and fixed behave the
    // same: socket down, hook retrying, gatewayState non-open, boot.error still
    // null → CONNECTING covers the screen with no recovery surface. (Past ~45s
    // the fix raises boot.error; that's asserted in the next test.)
    await advanceBackoff()

    expect($gatewayState.get()).not.toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    // It is actively retrying, not idle — more sockets were minted.
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1)
  })

  it('FIX: after the prolonged drop the hook raises a recoverable boot error (the escape hatch)', async () => {
    render(<Harness />)
    await flushAsync()
    expect($desktopBoot.get().error).toBeNull()

    FakeWebSocket.mode = 'fail'
    act(() => FakeWebSocket.instances[0].drop())
    await flushAsync()

    // Walk the backoff past the >=6 attempt threshold (~45s of failures).
    for (let i = 0; i < 8; i += 1) {
      await advanceBackoff()
    }

    // The hook surfaced the recoverable error → BootFailureOverlay (Use local
    // gateway / Sign in / Retry) becomes reachable instead of CONNECTING.
    expect($desktopBoot.get().error).toBeTruthy()
  })

  it('FIX: a successful reconnect clears the recoverable error', async () => {
    render(<Harness />)
    await flushAsync()

    FakeWebSocket.mode = 'fail'
    act(() => FakeWebSocket.instances[0].drop())
    await flushAsync()

    for (let i = 0; i < 8; i += 1) {
      await advanceBackoff()
    }

    expect($desktopBoot.get().error).toBeTruthy()

    // The remote comes back: next reconnect attempt opens.
    FakeWebSocket.mode = 'open'
    await advanceBackoff()

    expect($gatewayState.get()).toBe('open')
    expect($desktopBoot.get().error).toBeNull()
  })

  it('keeps OAuth reconnect escalation recognizable without exposing the mint failure', async () => {
    const desktop = fakeDesktop('oauth')

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop
    render(<Harness />)
    await flushAsync()
    expect($gatewayState.get()).toBe('open')

    desktop.getGatewayWsUrl.mockRejectedValue(
      new Error('sensitive mint failure at https://gateway.example.com/?token=do-not-render')
    )
    act(() => FakeWebSocket.instances[0].drop())
    await flushAsync()

    for (let i = 0; i < 8; i += 1) {
      await advanceBackoff()
    }

    expect($desktopBoot.get().error).toBe(translateNow('boot.errors.gatewaySignInRequired'))
    expect($desktopBoot.get().error).not.toContain('gateway.example.com')
    expect($desktopBoot.get().error).not.toContain('do-not-render')
  })

  it('enterprise revoke closes the window socket and permanently suppresses reconnect timers', async () => {
    const desktop = fakeDesktop()

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop
    render(<Harness />)
    await flushAsync()
    expect($gatewayState.get()).toBe('open')
    expect(FakeWebSocket.instances).toHaveLength(1)

    await act(async () => {
      await desktop.revokeRuntime()
    })
    expect($gatewayState.get()).toBe('closed')

    window.dispatchEvent(new Event('online'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(desktop.touchBackend).not.toHaveBeenCalled()
  })

  it('terminal lifecycle status blocks an unmount/remount and late secondary from issuing connection IPC', async () => {
    const desktop = fakeDesktop()

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop
    const mounted = render(<Harness />)
    await flushAsync()
    expect(desktop.getConnection).toHaveBeenCalledTimes(1)
    await act(async () => {
      await desktop.revokeRuntime()
    })
    mounted.unmount()

    desktop.enterprise.lifecycleStatus.mockResolvedValue({
      authEpoch: 1,
      lifecycleEpoch: 1,
      reasonCode: 'policy_denied',
      state: 'blocked'
    })
    render(<Harness />)
    await flushAsync()
    await ensureGatewayForProfile('finance')

    expect(desktop.getConnection).toHaveBeenCalledTimes(1)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('revoke during a primary connection handshake closes it and does not schedule another socket', async () => {
    const desktop = fakeDesktop()

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop
    render(<Harness />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(FakeWebSocket.instances).toHaveLength(1)
    await act(async () => {
      await desktop.revokeRuntime()
      await vi.advanceTimersByTimeAsync(120_000)
    })

    expect($gatewayState.get()).toBe('closed')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('disabled renderer still registers the revoke closure and acknowledges residual teardown', async () => {
    const desktop = fakeDesktop()

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop
    render(<DisabledHarness />)
    expect(desktop.onEnterpriseRuntimeRevoked).toHaveBeenCalledTimes(1)
    await act(async () => {
      await desktop.revokeRuntime()
    })
    expect($gatewayState.get()).toBe('closed')
    expect(desktop.getConnection).not.toHaveBeenCalled()
  })

  it('old deferred secondary work cannot connect or touch after revoke and authoritative new generation', async () => {
    const desktop = fakeDesktop()

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop
    render(<Harness />)
    await flushAsync()
    let resolveFinance: (value: Awaited<ReturnType<typeof desktop.getConnection>>) => void = () => undefined
    desktop.getConnection.mockImplementation(profile => {
      if (profile !== 'finance') {
        return Promise.resolve({
          authMode: 'token',
          baseUrl: 'https://vps.example.com',
          profile: 'default',
          token: 't',
          wsUrl: 'wss://vps.example.com/api/ws?token=t'
        })
      }
      return new Promise(resolve => {
        resolveFinance = resolve
      })
    })
    const oldOpen = ensureGatewayForProfile('finance')
    await act(async () => {
      await Promise.resolve()
    })
    await desktop.revokeRuntime()
    beginGatewayRuntime()
    resolveFinance({
      authMode: 'token',
      baseUrl: 'https://finance.example.com',
      profile: 'finance',
      token: 'finance-token',
      wsUrl: 'wss://finance.example.com/api/ws?token=finance-token'
    })
    await oldOpen

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(desktop.touchBackend).not.toHaveBeenCalled()
  })
})
