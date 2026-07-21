import { useEffect, useRef } from 'react'

import type { HermesConnection } from '@/global'
import { HermesGateway } from '@/hermes'
import { translateNow } from '@/i18n'
import { desktopDefaultCwd } from '@/lib/desktop-fs'
import { enterprisePublicErrorFromUnknown } from '@/lib/enterprise-bootstrap-error'
import { isGatewayReauthRequired, resolveGatewayWsUrl } from '@/lib/gateway-ws-url'
import {
  $desktopBoot,
  applyDesktopBootProgress,
  completeDesktopBoot,
  failDesktopBoot,
  failDesktopBootWithEnterpriseError,
  setDesktopBootStep
} from '@/store/boot'
import { refreshEnterpriseState } from '@/store/enterprise'
import {
  $gateway,
  beginGatewayRuntime,
  configureGatewayRegistry,
  ensureGatewayForProfile,
  pruneSecondaryGateways,
  reconnectSecondaryGateways,
  reportPrimaryGatewayState,
  revokeGatewayRuntime,
  setPrimaryGateway,
  touchSecondaryGateways
} from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey, touchActiveGatewayBackend } from '@/store/profile'
import {
  $activeSessionId,
  $attentionSessionIds,
  $connection,
  $currentCwd,
  $sessions,
  $workingSessionIds,
  ensureDefaultWorkspaceCwd,
  setConnection,
  setCurrentBranch,
  setCurrentCwd,
  setSessionsLoading
} from '@/store/session'
import type { RpcEvent } from '@/types/hermes'

interface GatewayBootOptions {
  enabled?: boolean
  handleGatewayEvent: (event: RpcEvent) => void
  onConnectionReady: (
    connection: Awaited<ReturnType<NonNullable<typeof window.hermesDesktop>['getConnection']>> | null
  ) => void
  onGatewayReady: (gateway: HermesGateway | null) => void
  refreshHermesConfig: () => Promise<void>
  refreshSessions: () => Promise<void>
}

const POST_BOOT_RECONNECT_FAILURE_THRESHOLD = 6

export function useGatewayBoot({
  enabled = true,
  handleGatewayEvent,
  onConnectionReady,
  onGatewayReady,
  refreshHermesConfig,
  refreshSessions
}: GatewayBootOptions) {
  const callbacksRef = useRef({
    handleGatewayEvent,
    onConnectionReady,
    onGatewayReady,
    refreshHermesConfig,
    refreshSessions
  })

  callbacksRef.current = {
    handleGatewayEvent,
    onConnectionReady,
    onGatewayReady,
    refreshHermesConfig,
    refreshSessions
  }

  useEffect(() => {
    let cancelled = false
    let runtimeRevoked = true
    let runtimeRevokeObserved = false
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null
    const desktop = window.hermesDesktop

    const publish = (next: HermesConnection | null) => {
      callbacksRef.current.onConnectionReady(next)
      setConnection(next)
    }

    if (!desktop) {
      failDesktopBoot('Desktop IPC bridge is unavailable.')
      setSessionsLoading(false)

      return () => void (cancelled = true)
    }

    if (!enabled) {
      const offEnterpriseRuntimeRevoked = desktop.onEnterpriseRuntimeRevoked?.(async () => {
        runtimeRevokeObserved = true
        revokeGatewayRuntime()
        publish(null)
        callbacksRef.current.onGatewayReady(null)
        const state = await refreshEnterpriseState().catch(() => null)
        if (!cancelled && state?.enabled && !state.authenticated) {
          completeDesktopBoot('Waiting for enterprise sign-in')
          setSessionsLoading(false)
        }
      })
      completeDesktopBoot('Waiting for enterprise sign-in')
      setSessionsLoading(false)

      return () => {
        cancelled = true
        offEnterpriseRuntimeRevoked?.()
        revokeGatewayRuntime()
        publish(null)
        callbacksRef.current.onGatewayReady(null)
      }
    }

    // --- Reconnect-after-sleep machinery -------------------------------------
    // macOS sleep silently drops the renderer's WebSocket. The backend Python
    // process keeps running, but nothing re-opened the socket on wake, so the
    // composer stayed disabled forever on "Starting Hermes...". Once the
    // initial boot succeeds we treat any non-open state as recoverable and
    // reconnect with backoff, and we nudge a reconnect on the OS/browser
    // signals that fire around wake (power resume, network online, the window
    // becoming visible).
    let bootCompleted = false
    let reconnecting = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0
    let reconnectFailureCount = 0
    let reconnectFailureSurfaced = false
    let sessionRequiredRefresh: Promise<boolean> | null = null
    // Surface "sign in again" once per disconnect episode, not on every backoff
    // tick — a stale OAuth ticket fails every attempt and would otherwise stack
    // identical error toasts (and their haptics). Reset on the next clean open.
    let reauthNotified = false

    // Wrap the live getter in a call so TS control-flow analysis doesn't narrow
    // `connectionState` to a constant across the early-return guards (the state
    // genuinely changes between reads).
    const gatewayOpen = () => gateway.connectionState === 'open'

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    const handOffEnterpriseSessionRequired = (error: unknown, forceRefresh = false): Promise<boolean> => {
      const enterpriseError = enterprisePublicErrorFromUnknown(error)

      if (!forceRefresh && (
        enterpriseError?.errorCode !== 'desktop_session_required' ||
        enterpriseError.httpStatus !== 401 ||
        enterpriseError.recoveryKind !== 'sign-in'
      )) {
        return Promise.resolve(false)
      }

      if (sessionRequiredRefresh) {
        return sessionRequiredRefresh
      }

      // A terminal managed 401 is an authentication-state transition, not a
      // backend/bootstrap failure. Stop this runtime generation before asking
      // main for the authoritative public state. The resulting unauthenticated
      // store state remounts this hook disabled and lets EnterpriseLoginOverlay
      // take ownership without a reconnect/retry loop.
      runtimeRevokeObserved = true
      runtimeRevoked = true
      bootCompleted = false
      clearReconnectTimer()
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
      revokeGatewayRuntime()
      publish(null)
      callbacksRef.current.onGatewayReady(null)

      const refresh = refreshEnterpriseState()
        .then(state => {
          if (!cancelled && state.enabled && !state.authenticated) {
            completeDesktopBoot('Waiting for enterprise sign-in')
            setSessionsLoading(false)
            return true
          }

          return false
        })
        .catch(() => false)
      sessionRequiredRefresh = refresh
      void refresh.finally(() => {
        if (sessionRequiredRefresh === refresh) {
          sessionRequiredRefresh = null
        }
      })

      return refresh
    }

    const attemptReconnect = async () => {
      if (cancelled || runtimeRevoked || reconnecting || gatewayOpen()) {
        return
      }

      reconnecting = true

      try {
        // Drop a stale REMOTE backend cache before re-dialing. After sleep/wake a
        // remote backend can become unreachable, but it has no child process
        // whose 'exit' would clear the main process's cached descriptor — without
        // this the renderer re-dials the same dead endpoint forever and stays on
        // "Starting Hermes…". The probe is a no-op for a healthy or local backend.
        await desktop.revalidateConnection?.().catch(() => undefined)

        const conn = await desktop.getConnection($activeGatewayProfile.get())

        if (cancelled || runtimeRevoked) {
          return
        }

        publish(conn)
        // Re-mint the WS URL before reconnecting. OAuth tickets are single-use
        // with a short TTL, so the ticket baked into the cached conn.wsUrl is
        // dead on every reconnect after the initial boot — reusing it surfaces
        // as an opaque "Could not connect to Hermes gateway". resolveGatewayWsUrl
        // mints a fresh ticket (or throws a reauth error in OAuth mode rather
        // than connecting with a stale one). For local/token gateways the URL
        // carries a long-lived token and the re-mint is a cheap no-op.
        const wsUrl = await resolveGatewayWsUrl(desktop, conn)
        await gateway.connect(wsUrl)

        if (cancelled || runtimeRevoked) {
          gateway.close()
          return
        }

        reconnectAttempt = 0
        reconnectFailureCount = 0
        reconnectFailureSurfaced = false
        // Resync state that may have moved on the backend while we were asleep.
        await callbacksRef.current.refreshHermesConfig().catch(() => undefined)
        await callbacksRef.current.refreshSessions().catch(() => undefined)
      } catch (err) {
        if (await handOffEnterpriseSessionRequired(err)) {
          return
        }

        // OAuth session expired mid-reconnect: surface the actionable "sign in
        // again" message once instead of silently looping the backoff against a
        // ticket that can never succeed. Transport failures fall through to the
        // backoff in the finally block below.
        const reauthRequired = isGatewayReauthRequired(err)

        if (!cancelled && !runtimeRevoked && reauthRequired && !reauthNotified) {
          reauthNotified = true
          notifyError(err, translateNow('boot.errors.gatewaySignInRequired'))
        }

        if (!cancelled && !runtimeRevoked && bootCompleted) {
          reconnectFailureCount += 1

          if (!reconnectFailureSurfaced && reconnectFailureCount >= POST_BOOT_RECONNECT_FAILURE_THRESHOLD) {
            reconnectFailureSurfaced = true
            failDesktopBoot(
              translateNow(reauthRequired ? 'boot.errors.gatewaySignInRequired' : 'boot.errors.desktopBootFailed')
            )
          }
        }
      } finally {
        reconnecting = false

        if (!cancelled && !runtimeRevoked && !gatewayOpen()) {
          scheduleReconnect()
        }
      }
    }

    function scheduleReconnect() {
      if (cancelled || runtimeRevoked || reconnecting || reconnectTimer !== null || gatewayOpen()) {
        return
      }

      // 1s, 2s, 4s … capped at 15s.
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(reconnectAttempt, 4))
      reconnectAttempt += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void attemptReconnect()
      }, delay)
    }

    const reconnectNow = () => {
      if (cancelled || runtimeRevoked || !bootCompleted) {
        return
      }

      clearReconnectTimer()
      reconnectAttempt = 0
      reconnectSecondaryGateways()

      if (!gatewayOpen()) {
        void attemptReconnect()
      }
    }

    const offBootProgress = desktop.onBootProgress(payload => applyDesktopBootProgress(payload))
    void desktop
      .getBootProgress()
      .then(snapshot => applyDesktopBootProgress(snapshot))
      .catch(() => undefined)

    setDesktopBootStep({
      phase: 'renderer.boot',
      message: translateNow('boot.steps.startingDesktopConnection'),
      progress: 6
    })

    const gateway = new HermesGateway()
    callbacksRef.current.onGatewayReady(gateway)
    setPrimaryGateway(gateway, normalizeProfileKey($activeGatewayProfile.get()))
    // Secondary (background-profile) sockets funnel into the same handler.
    configureGatewayRegistry({ onEvent: event => callbacksRef.current.handleGatewayEvent(event) })

    const offEnterpriseRuntimeRevoked = desktop.onEnterpriseRuntimeRevoked?.(async () => {
      await handOffEnterpriseSessionRequired(null, true)
    })

    const offState = gateway.onState(st => {
      // Mirror to the composer only while the primary is the active profile —
      // a background secondary reconnect mustn't flip the foreground state.
      reportPrimaryGatewayState(st)

      if (st === 'open') {
        reconnectAttempt = 0
        reconnectFailureCount = 0
        reconnectFailureSurfaced = false
        reauthNotified = false
        clearReconnectTimer()

        // A revalidate-driven reconnect can rebuild the backend in place when the
        // cached remote was found dead, which re-drives the boot-progress overlay.
        // Unlike the initial boot, nothing calls completeDesktopBoot() afterwards,
        // so dismiss it here once we're open again — otherwise the overlay sticks
        // at ~94%. A no-op on a normal (non-rebuild) reconnect.
        if (bootCompleted) {
          completeDesktopBoot()
        }
      } else if (!runtimeRevoked && bootCompleted && (st === 'closed' || st === 'error')) {
        // The socket dropped after a healthy boot (typically sleep/wake). Try
        // to bring it back instead of leaving the composer stuck disabled.
        scheduleReconnect()
      }
    })

    const offEvent = gateway.onEvent(event => callbacksRef.current.handleGatewayEvent(event))
    const offWeComSessionEvent = desktop.enterprise?.weComBot?.onSessionEvent?.(event => {
      callbacksRef.current.handleGatewayEvent(event)
      if (event.type === 'message.start' || event.type === 'message.complete') {
        void callbacksRef.current.refreshSessions().catch(() => undefined)
      }
      if (event.type === 'message.complete') {
        // The completion event can arrive a few milliseconds before the durable
        // session row is visible to the cross-profile reader. Re-read once after
        // that write settles so WeCom conversations do not require a manual refresh.
        setTimeout(() => {
          void callbacksRef.current.refreshSessions().catch(() => undefined)
        }, 500)
      }
    })

    // Wake signals: power resume (macOS/Windows), network coming back, and the
    // window regaining focus/visibility. Each nudges an immediate reconnect.
    const offPowerResume = desktop.onPowerResume?.(() => reconnectNow())

    const onOnline = () => reconnectNow()

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        reconnectNow()
      }
    }

    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)

    // Keep live pool backends alive while this window is open (the main process
    // can't observe the direct renderer↔backend WS). No-op for the primary.
    keepaliveTimer = setInterval(() => {
      if (runtimeRevoked || cancelled) {
        return
      }
      touchActiveGatewayBackend()
      touchSecondaryGateways()
    }, 60_000)

    // Bound concurrency cost to live work: keep a background socket only while
    // its profile has a running (working) or blocked (needs-input) session.
    // Once that profile goes idle its socket is dropped and its backend is free
    // to idle-reap. The active profile is always spared.
    const recomputeKeptGateways = () => {
      const live = new Set([...$workingSessionIds.get(), ...$attentionSessionIds.get()])
      const keep = new Set<string>()

      for (const session of $sessions.get()) {
        if (live.has(session.id)) {
          keep.add(normalizeProfileKey(session.profile))
        }
      }

      pruneSecondaryGateways(keep)
    }

    const offWorking = $workingSessionIds.subscribe(() => recomputeKeptGateways())
    const offAttention = $attentionSessionIds.subscribe(() => recomputeKeptGateways())
    const offActiveProfile = $activeGatewayProfile.subscribe(() => recomputeKeptGateways())

    const offWindowState = desktop.onWindowStateChanged?.(payload => {
      const current = $connection.get()

      if (current) {
        publish({ ...current, ...payload })
      }
    })

    const offExit = desktop.onBackendExit(() => {
      if ($desktopBoot.get().running || $desktopBoot.get().visible) {
        failDesktopBoot(translateNow('boot.errors.backgroundExitedDuringStartup'))
      }

      notify({
        kind: 'error',
        title: translateNow('boot.errors.backendStopped'),
        message: translateNow('boot.errors.backgroundExited'),
        durationMs: 0
      })
    })

    async function boot() {
      try {
        const conn = await desktop.getConnection()

        if (cancelled || runtimeRevoked) {
          return
        }

        setDesktopBootStep({
          phase: 'renderer.gateway.connect',
          message: translateNow('boot.steps.connectingGateway'),
          progress: 95
        })
        publish(conn)
        // Mint a fresh WS URL right before connecting. For OAuth gateways the
        // ticket is single-use with a short TTL, so the ticket baked into
        // conn.wsUrl is stale; resolveGatewayWsUrl() re-mints it and, on
        // failure, throws a reauth error rather than connecting with a dead
        // ticket (which would surface as an opaque "connection closed").
        const wsUrl = await resolveGatewayWsUrl(desktop, conn)
        if (cancelled || runtimeRevoked) {
          return
        }
        await gateway.connect(wsUrl)

        if (cancelled || runtimeRevoked) {
          gateway.close()
          return
        }

        // Record which profile the primary (window) backend booted as, so
        // same-profile resumes are no-op swaps and any reconnect targets the
        // right backend. Best-effort: a missing preference means "default".
        try {
          const pref = await desktop.profile?.get?.()
          const profileKey = (pref?.profile ?? '').trim() || 'default'
          $activeGatewayProfile.set(profileKey)
          setPrimaryGateway(gateway, profileKey)
          void ensureGatewayForProfile(profileKey)
        } catch {
          $activeGatewayProfile.set('default')
        }

        setDesktopBootStep({
          phase: 'renderer.config',
          message: translateNow('boot.steps.loadingSettings'),
          progress: 97
        })
        await ensureDefaultWorkspaceCwd()
        const remoteDefault = await desktopDefaultCwd().catch(() => null)

        if (remoteDefault?.cwd && !$activeSessionId.get() && !$currentCwd.get()) {
          setCurrentCwd(remoteDefault.cwd)
          setCurrentBranch(remoteDefault.branch || '')
        }

        await callbacksRef.current.refreshHermesConfig()

        if (cancelled || runtimeRevoked) {
          return
        }

        setDesktopBootStep({
          phase: 'renderer.sessions',
          message: translateNow('boot.steps.loadingSessions'),
          progress: 99
        })
        await callbacksRef.current.refreshSessions()
        completeDesktopBoot()
        bootCompleted = true
      } catch (err) {
        if (!cancelled && await handOffEnterpriseSessionRequired(err)) {
          return
        }

        if (!cancelled && !runtimeRevoked) {
          const message = err instanceof Error ? err.message : String(err)
          const enterpriseError = enterprisePublicErrorFromUnknown(err)
          const managed = $desktopBoot.get().enterpriseManaged === true || desktop.enterprise.managed === true

          if (enterpriseError) {
            failDesktopBootWithEnterpriseError(enterpriseError.message, enterpriseError)
          } else if (managed) {
            failDesktopBoot(translateNow('boot.failure.managedFailure'))
          } else {
            failDesktopBoot(message)
          }

          notifyError(
            managed && !enterpriseError ? new Error(translateNow('boot.failure.managedFailure')) : err,
            translateNow('boot.errors.desktopBootFailed')
          )
          setSessionsLoading(false)
        }
      }
    }

    async function initializeRuntime() {
      try {
        const lifecycle = await desktop.enterprise.lifecycleStatus()
        if (cancelled || runtimeRevokeObserved) {
          return
        }
        if (lifecycle.state !== 'running' && lifecycle.state !== 'recovering') {
          revokeGatewayRuntime()
          publish(null)
          callbacksRef.current.onGatewayReady(null)
          return
        }
        beginGatewayRuntime()
        runtimeRevoked = false
        await boot()
      } catch (error) {
        if (!cancelled && !runtimeRevokeObserved) {
          const message = error instanceof Error ? error.message : String(error)
          failDesktopBoot(message)
          setSessionsLoading(false)
        }
      }
    }

    void initializeRuntime()

    return () => {
      cancelled = true
      clearReconnectTimer()
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer)
      }
      offWorking()
      offAttention()
      offActiveProfile()
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      offPowerResume?.()
      offState()
      offEvent()
      offWeComSessionEvent?.()
      offExit()
      offEnterpriseRuntimeRevoked?.()
      offWindowState?.()
      offBootProgress()
      revokeGatewayRuntime()
      publish(null)
      callbacksRef.current.onGatewayReady(null)
      setPrimaryGateway(null)
      $gateway.set(null)
    }
  }, [enabled])
}
