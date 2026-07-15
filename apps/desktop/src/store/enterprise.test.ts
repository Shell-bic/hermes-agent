import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EnterpriseDesktopState } from '@/global'

import {
  $enterprise,
  INITIAL_ENTERPRISE_STATE,
  refreshEnterpriseState
} from './enterprise'

afterEach(() => {
  $enterprise.set(INITIAL_ENTERPRISE_STATE)
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
  vi.clearAllMocks()
})

describe('enterprise messaging channel policy store boundary', () => {
  it('fails closed when a legacy managed bridge omits messagingChannelPolicy', async () => {
    const legacyState = {
      ...INITIAL_ENTERPRISE_STATE,
      authenticated: true,
      enabled: true,
      status: 'authenticated'
    } as Partial<EnterpriseDesktopState>

    delete legacyState.messagingChannelPolicy

    const status = vi.fn().mockResolvedValue(legacyState)

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = { enterprise: { status } }

    const state = await refreshEnterpriseState()

    expect(state.messagingChannelPolicy).toMatchObject({
      allowedChannelIds: [],
      mode: 'managed',
      reason: 'policy_missing',
      status: 'fail-closed',
      visibleChannelIds: []
    })
  })

  it('keeps full catalog semantics when enterprise management is unavailable', async () => {
    const state = await refreshEnterpriseState()

    expect(state.messagingChannelPolicy).toMatchObject({
      allowedChannelIds: null,
      mode: 'unmanaged',
      status: 'full-catalog',
      visibleChannelIds: null
    })
  })
})
