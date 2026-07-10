import { useStore } from '@nanostores/react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnterpriseDesktopState } from '@/global'
import { $enterprise, INITIAL_ENTERPRISE_STATE } from '@/store/enterprise'
import { $gatewayState, setGatewayState } from '@/store/session'

import { useEnterpriseStateRefresh } from './use-enterprise-state-refresh'

function enterpriseState(overrides: Partial<EnterpriseDesktopState> = {}): EnterpriseDesktopState {
  return {
    ...INITIAL_ENTERPRISE_STATE,
    authenticated: true,
    enabled: true,
    status: 'authenticated',
    ...overrides
  }
}

function Harness() {
  const gatewayState = useStore($gatewayState)
  useEnterpriseStateRefresh(gatewayState)

  return null
}

beforeEach(() => {
  $enterprise.set(INITIAL_ENTERPRISE_STATE)
  setGatewayState('idle')
})

afterEach(() => {
  cleanup()
  $enterprise.set(INITIAL_ENTERPRISE_STATE)
  setGatewayState('idle')
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
  vi.clearAllMocks()
})

describe('useEnterpriseStateRefresh', () => {
  it('refreshes enterprise state again when the managed gateway opens', async () => {
    const status = vi
      .fn<() => Promise<EnterpriseDesktopState>>()
      .mockResolvedValueOnce(enterpriseState({ toolPolicySnapshot: null }))
      .mockResolvedValueOnce(
        enterpriseState({
          toolPolicySnapshot: {
            capabilityFlags: {},
            generatedAt: '2026-07-06T12:00:00Z',
            mcpServers: [],
            policyHash: 'hash-tools',
            policyVersion: 'pv-tools',
            skills: [],
            toolSets: [
              {
                key: 'web',
                displayName: 'Enterprise Web',
                status: 'restricted'
              }
            ],
            tools: []
          }
        })
      )

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      enterprise: {
        status
      }
    }

    render(<Harness />)

    await waitFor(() => expect(status).toHaveBeenCalledTimes(1))
    expect($enterprise.get().toolPolicySnapshot).toBeNull()

    act(() => setGatewayState('open'))

    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect($enterprise.get().toolPolicySnapshot?.toolSets[0]).toMatchObject({
      key: 'web',
      status: 'restricted'
    })
  })
})
