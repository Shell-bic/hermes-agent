import { type QueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { getGlobalModelInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { enterpriseModelSelection, isEnterpriseModelAllowed } from '@/lib/chat-runtime'
import { $enterprise, selectEnterpriseModel } from '@/store/enterprise'
import { isEnterpriseModelManaged } from '@/store/model-visibility'
import { notifyError } from '@/store/notifications'
import {
  $activeSessionId,
  $currentModel,
  $currentProvider,
  setCurrentModel,
  setCurrentProvider
} from '@/store/session'
import type { ModelOptionsResponse } from '@/types/hermes'

interface ModelSelection {
  model: string
  provider: string
}

interface ModelControlsOptions {
  activeSessionId: string | null
  queryClient: QueryClient
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}

export function useModelControls({ activeSessionId, queryClient, requestGateway }: ModelControlsOptions) {
  const { t } = useI18n()
  const copy = t.desktop

  const updateModelOptionsCache = useCallback(
    (provider: string, model: string, includeGlobal: boolean) => {
      const patch = (prev: ModelOptionsResponse | undefined) => ({ ...(prev ?? {}), provider, model })

      queryClient.setQueryData<ModelOptionsResponse>(['model-options', activeSessionId || 'global'], patch)

      if (includeGlobal) {
        queryClient.setQueryData<ModelOptionsResponse>(['model-options', 'global'], patch)
      }
    },
    [activeSessionId, queryClient]
  )

  // Seed the composer's model state from the profile default. `force` reseeds
  // for a profile swap (the new profile has its own default); otherwise this
  // only fills an EMPTY selection so a user's pick (plain UI state in
  // $currentModel) survives the lifecycle refreshes that fire on boot / fresh
  // draft / session events. A live session owns the footer, so skip entirely.
  const refreshCurrentModel = useCallback(async (force = false) => {
    try {
      if ($activeSessionId.get()) {
        return
      }

      const enterprise = $enterprise.get()

      if (isEnterpriseModelManaged(enterprise)) {
        const selection = enterpriseModelSelection(enterprise, force ? null : $currentModel.get())

        if (selection && (force || !$currentModel.get())) {
          setCurrentModel(selection.model)
          setCurrentProvider(selection.provider)
        }

        return
      }

      if (!force && $currentModel.get()) {
        return
      }

      const result = await getGlobalModelInfo()

      if ($activeSessionId.get() || (!force && $currentModel.get())) {
        return
      }

      if (typeof result.model === 'string') {
        setCurrentModel(result.model)
      }

      if (typeof result.provider === 'string') {
        setCurrentProvider(result.provider)
      }
    } catch {
      // The delayed session.info event still updates this once the agent is ready.
    }
  }, [])

  // Returns whether the switch succeeded so callers can await it before applying
  // follow-up changes. The composer model is plain UI state: with no live
  // session it's just stored (and shipped on the next session.create); with one
  // it's scoped to that session via config.set. It NEVER writes the profile
  // default — that lives in Settings → Model — so picking a model here can't
  // silently mutate global config.
  const selectModel = useCallback(
    async (selection: ModelSelection): Promise<boolean> => {
      // Snapshot for rollback: the switch is applied optimistically, so a
      // failure must restore the prior model/provider (store + query cache)
      // rather than leave the UI showing a model the backend never selected.
      const prevModel = $currentModel.get()
      const prevProvider = $currentProvider.get()
      const enterprise = $enterprise.get()
      const enterpriseManaged = isEnterpriseModelManaged(enterprise)
      const enterpriseSelection = enterpriseManaged ? enterpriseModelSelection(enterprise, selection.model) : null

      if (enterpriseManaged && (!isEnterpriseModelAllowed(enterprise, selection.model) || !enterpriseSelection)) {
        notifyError(new Error(`Model "${selection.model}" is not allowed by enterprise policy.`), copy.modelSwitchFailed)

        return false
      }

      const nextModel = enterpriseSelection?.model ?? selection.model
      const nextProvider = enterpriseSelection?.provider ?? selection.provider

      setCurrentModel(nextModel)
      setCurrentProvider(nextProvider)
      updateModelOptionsCache(nextProvider, nextModel, !activeSessionId)

      if (enterpriseManaged) {
        try {
          const nextEnterprise = await selectEnterpriseModel(nextModel)
          const nextSelection = enterpriseModelSelection(nextEnterprise, nextModel)

          if (nextSelection) {
            setCurrentModel(nextSelection.model)
            setCurrentProvider(nextSelection.provider)
            updateModelOptionsCache(nextSelection.provider, nextSelection.model, !activeSessionId)
          }

          void queryClient.invalidateQueries({ queryKey: ['model-options'] })

          return true
        } catch (err) {
          setCurrentModel(prevModel)
          setCurrentProvider(prevProvider)
          updateModelOptionsCache(prevProvider, prevModel, !activeSessionId)
          notifyError(err, copy.modelSwitchFailed)

          return false
        }
      }

      // No live session yet: the pick is pure UI state. session.create reads
      // $currentModel/$currentProvider and applies it as that session's override.
      if (!activeSessionId) {
        return true
      }

      try {
        await requestGateway('config.set', {
          session_id: activeSessionId,
          key: 'model',
          value: `${selection.model} --provider ${selection.provider}`
        })

        void queryClient.invalidateQueries({ queryKey: ['model-options', activeSessionId] })

        return true
      } catch (err) {
        setCurrentModel(prevModel)
        setCurrentProvider(prevProvider)
        updateModelOptionsCache(prevProvider, prevModel, !activeSessionId)
        notifyError(err, copy.modelSwitchFailed)

        return false
      }
    },
    [activeSessionId, copy.modelSwitchFailed, queryClient, requestGateway, updateModelOptionsCache]
  )

  return { refreshCurrentModel, selectModel, updateModelOptionsCache }
}
