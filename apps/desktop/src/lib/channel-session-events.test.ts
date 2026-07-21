import { describe, expect, it } from 'vitest'

import { runtimeSessionIdForStoredSession, storedSessionIdFromChange } from './channel-session-events'

describe('storedSessionIdFromChange', () => {
  it('accepts only the generic authoritative-session invalidation', () => {
    expect(storedSessionIdFromChange({
      type: 'session.changed',
      payload: { reason: 'channel-turn-persisted', stored_session_id: ' stored-session ' }
    })).toBe('stored-session')

    expect(storedSessionIdFromChange({
      type: 'message.complete',
      payload: { stored_session_id: 'stored-session', text: 'message dto' }
    })).toBeNull()
  })
})

describe('runtimeSessionIdForStoredSession', () => {
  it('uses the existing stored-to-runtime mapping when it is warm', () => {
    expect(
      runtimeSessionIdForStoredSession(
        'stored-session',
        new Map([['runtime-session', { storedSessionId: 'stored-session' }]])
      )
    ).toBe('runtime-session')
  })

  it('falls back to the active runtime when a newly discovered channel session is selected', () => {
    expect(
      runtimeSessionIdForStoredSession(
        'stored-session',
        new Map(),
        'active-runtime',
        'stored-session'
      )
    ).toBe('active-runtime')

    expect(
      runtimeSessionIdForStoredSession(
        'background-session',
        new Map(),
        'active-runtime',
        'stored-session'
      )
    ).toBeNull()
  })
})
