import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { $enterprise, refreshEnterpriseState, subscribeEnterpriseState } from '@/store/enterprise'

export function useEnterpriseStateRefresh(gatewayState: string | undefined): void {
  const enterprise = useStore($enterprise)

  useEffect(() => {
    const unsubscribe = subscribeEnterpriseState()
    void refreshEnterpriseState()

    return unsubscribe
  }, [])

  useEffect(() => {
    if (gatewayState !== 'open' || !enterprise.enabled || !enterprise.authenticated) {
      return
    }

    void refreshEnterpriseState()
  }, [enterprise.authenticated, enterprise.enabled, gatewayState])
}
