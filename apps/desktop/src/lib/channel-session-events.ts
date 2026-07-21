import type { RpcEvent } from '@/types/hermes'

interface StoredSessionRuntimeState {
  storedSessionId?: null | string
}

export function storedSessionIdFromChange(event: RpcEvent): string | null {
  if (event.type !== 'session.changed' || !event.payload || typeof event.payload !== 'object') {
    return null
  }

  const value = (event.payload as { stored_session_id?: unknown }).stored_session_id
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function runtimeSessionIdForStoredSession(
  storedSessionId: string,
  runtimeStates: Iterable<readonly [string, StoredSessionRuntimeState]>,
  activeRuntimeSessionId?: null | string,
  selectedStoredSessionId?: null | string
): string | null {
  const normalizedStoredSessionId = storedSessionId.trim()

  if (!normalizedStoredSessionId) {
    return null
  }

  for (const [runtimeSessionId, state] of runtimeStates) {
    if (state.storedSessionId === normalizedStoredSessionId) {
      return runtimeSessionId
    }
  }

  if (
    selectedStoredSessionId === normalizedStoredSessionId &&
    typeof activeRuntimeSessionId === 'string' &&
    activeRuntimeSessionId.trim()
  ) {
    return activeRuntimeSessionId
  }

  return null
}
