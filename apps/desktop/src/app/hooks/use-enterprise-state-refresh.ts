import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { $enterprise, refreshEnterpriseState } from '@/store/enterprise'

export function useEnterpriseStateRefresh(gatewayState: string | undefined): void {
  const enterprise = useStore($enterprise)

  useEffect(() => {
    void refreshEnterpriseState()
  }, [])

  useEffect(() => {
    if (gatewayState !== 'open' || !enterprise.enabled || !enterprise.authenticated) {
      return
    }

    void refreshEnterpriseState()
  }, [enterprise.authenticated, enterprise.enabled, gatewayState])
}
