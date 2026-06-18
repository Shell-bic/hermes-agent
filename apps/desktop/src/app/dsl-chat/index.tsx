import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { Suspense, useCallback, useMemo } from 'react'
import { useLocation } from 'react-router-dom'

import { ChatDropOverlay } from '@/app/chat/chat-drop-overlay'
import { ChatSwapOverlay } from '@/app/chat/chat-swap-overlay'
import { requestComposerInsert, requestComposerInsertRefs } from '@/app/chat/composer/focus'
import { droppedFileInlineRefs, type SessionDragPayload, sessionInlineRef } from '@/app/chat/composer/inline-refs'
import { type DroppedFile, partitionDroppedFiles } from '@/app/chat/hooks/use-composer-actions'
import { useFileDropZone } from '@/app/chat/hooks/use-file-drop-zone'
import { ScrollToBottomButton } from '@/app/chat/scroll-to-bottom-button'
import { threadLoadingState } from '@/app/chat/thread-loading'
import { Backdrop } from '@/components/Backdrop'
import { PromptOverlays } from '@/components/prompt-overlays'
import { Loader } from '@/components/ui/loader'
import { getGlobalModelOptions } from '@/hermes'
import { quickModelOptions } from '@/lib/chat-runtime'
import { cn } from '@/lib/utils'
import { $gatewaySwapTarget } from '@/store/profile'
import {
  $activeSessionId,
  $awaitingResponse,
  $busy,
  $contextSuggestions,
  $currentCwd,
  $currentModel,
  $currentProvider,
  $gatewayState,
  $lastVisibleMessageIsUser,
  $messages,
  $messagesEmpty,
  $selectedStoredSessionId
} from '@/store/session'
import type { ModelOptionsResponse } from '@/types/hermes'

import { ChatHeader, ChatRuntimeBoundary, type ChatViewProps } from '../chat'
import { ChatBar, ChatBarFallback } from '../chat/composer'
import type { ChatBarState } from '../chat/composer/types'
import { routeSessionId } from '../routes'
import { WorkspaceConversationRenderer, type WorkspaceConversationRendererProps } from '../workspace'

export interface DslChatViewProps extends Omit<ChatViewProps, 'onRetryResume'> {
  onRetryResume?: ChatViewProps['onRetryResume']
  primaryViewToggle?: React.ReactNode
  workspaceBlocks?: WorkspaceConversationRendererProps['blocks']
  workspaceObjects?: WorkspaceConversationRendererProps['objects']
  rawWorkspaceEvents?: WorkspaceConversationRendererProps['rawEvents']
  selectedWorkspaceObjectId?: WorkspaceConversationRendererProps['selectedBlockId']
  onSelectWorkspaceBlock?: WorkspaceConversationRendererProps['onSelectBlock']
  onWorkspaceBlockAction?: WorkspaceConversationRendererProps['onBlockAction']
}

function DslChatLoadingOverlay({ kind }: { kind: 'response' | 'session' }) {
  if (kind === 'response') {
    return (
      <div
        className="pointer-events-none absolute bottom-[calc(var(--composer-measured-height)+1rem)] left-1/2 z-1 flex -translate-x-1/2 items-center gap-2 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) px-3 py-1.5 text-xs text-(--ui-text-secondary)"
        role="status"
      >
        <span aria-hidden="true" className="dither inline-block size-3 rounded-[2px] text-midground/80 animate-pulse" />
        Thinking
      </div>
    )
  }

  return (
    <div
      aria-label="Loading session"
      className="pointer-events-none absolute inset-0 z-1 grid place-items-center bg-(--ui-chat-surface-background)"
      role="status"
    >
      <Loader
        aria-hidden="true"
        className="size-12 text-midground/70"
        pathSteps={220}
        role="presentation"
        strokeScale={0.72}
        type="rose-curve"
      />
    </div>
  )
}

function DslConversationRendererBoundary({
  onSelectWorkspaceBlock,
  onWorkspaceBlockAction,
  rawWorkspaceEvents,
  selectedWorkspaceObjectId,
  showChatBar,
  suppressMessages,
  workspaceBlocks,
  workspaceObjects
}: {
  onSelectWorkspaceBlock?: WorkspaceConversationRendererProps['onSelectBlock']
  onWorkspaceBlockAction?: WorkspaceConversationRendererProps['onBlockAction']
  rawWorkspaceEvents: NonNullable<WorkspaceConversationRendererProps['rawEvents']>
  selectedWorkspaceObjectId?: WorkspaceConversationRendererProps['selectedBlockId']
  showChatBar: boolean
  suppressMessages: boolean
  workspaceBlocks: WorkspaceConversationRendererProps['blocks']
  workspaceObjects: WorkspaceConversationRendererProps['objects']
}) {
  const messages = useStore($messages)

  return (
    <WorkspaceConversationRenderer
      blocks={workspaceBlocks}
      className={cn('h-full min-h-0', showChatBar && 'pb-[8.5rem]')}
      messages={suppressMessages ? [] : messages}
      objects={workspaceObjects}
      onBlockAction={onWorkspaceBlockAction}
      onSelectBlock={onSelectWorkspaceBlock}
      rawEvents={rawWorkspaceEvents}
      selectedBlockId={selectedWorkspaceObjectId}
    />
  )
}

export function DslChatView({
  className,
  gateway,
  maxVoiceRecordingSeconds,
  onAddContextRef,
  onAddUrl,
  onAttachDroppedItems,
  onAttachImageBlob,
  onBranchInNewChat: _onBranchInNewChat,
  onCancel,
  onDeleteSelectedSession,
  onEdit,
  onPasteClipboardImage,
  onPickFiles,
  onPickFolders,
  onPickImages,
  onReload,
  onRemoveAttachment,
  onRetryResume: _onRetryResume,
  onSteer,
  onSubmit,
  onThreadMessagesChange,
  onToggleSelectedPin,
  onRestoreToMessage: _onRestoreToMessage,
  onTranscribeAudio,
  primaryViewToggle,
  rawWorkspaceEvents = [],
  selectedWorkspaceObjectId,
  workspaceBlocks = [],
  workspaceObjects = [],
  onSelectWorkspaceBlock,
  onWorkspaceBlockAction
}: DslChatViewProps) {
  const location = useLocation()
  const activeSessionId = useStore($activeSessionId)
  const awaitingResponse = useStore($awaitingResponse)
  const busy = useStore($busy)
  const contextSuggestions = useStore($contextSuggestions)
  const currentCwd = useStore($currentCwd)
  const currentModel = useStore($currentModel)
  const currentProvider = useStore($currentProvider)
  const gatewayState = useStore($gatewayState)
  const gatewaySwapTarget = useStore($gatewaySwapTarget)
  const lastVisibleIsUser = useStore($lastVisibleMessageIsUser)
  const messagesEmpty = useStore($messagesEmpty)
  const selectedSessionId = useStore($selectedStoredSessionId)
  const gatewayOpen = gatewayState === 'open'
  const routedSessionId = routeSessionId(location.pathname)
  const isRoutedSessionView = Boolean(routedSessionId)
  const routeSessionMismatch = isRoutedSessionView && routedSessionId !== selectedSessionId
  const loadingSession = isRoutedSessionView && (routeSessionMismatch || (messagesEmpty && !activeSessionId))
  const threadLoading = threadLoadingState(loadingSession, busy, awaitingResponse, lastVisibleIsUser)
  const showChatBar = !loadingSession

  const modelOptionsQuery = useQuery<ModelOptionsResponse>({
    queryKey: ['model-options', activeSessionId || 'global'],
    queryFn: () => {
      if (!activeSessionId) {
        return getGlobalModelOptions()
      }

      if (!gateway) {
        throw new Error('Hermes gateway unavailable')
      }

      return gateway.request<ModelOptionsResponse>('model.options', { session_id: activeSessionId })
    },
    enabled: gatewayOpen
  })

  const quickModels = useMemo(
    () => quickModelOptions(modelOptionsQuery.data, currentProvider, currentModel),
    [currentModel, currentProvider, modelOptionsQuery.data]
  )

  const chatBarState = useMemo<ChatBarState>(
    () => ({
      model: {
        model: currentModel,
        provider: currentProvider,
        canSwitch: gatewayOpen,
        loading: !gatewayOpen || (!currentModel && !currentProvider),
        quickModels
      },
      tools: {
        enabled: true,
        label: 'Add context',
        suggestions: contextSuggestions
      },
      voice: {
        enabled: true,
        active: false
      }
    }),
    [contextSuggestions, currentModel, currentProvider, gatewayOpen, quickModels]
  )

  const onDropFiles = useCallback(
    (candidates: DroppedFile[]) => {
      const { inAppRefs, osDrops } = partitionDroppedFiles(candidates)
      const refs = droppedFileInlineRefs(inAppRefs, currentCwd)

      if (refs.length) {
        requestComposerInsert(refs.join(' '), { mode: 'inline', target: 'main' })
      }

      if (osDrops.length) {
        void onAttachDroppedItems(osDrops)
      }
    },
    [currentCwd, onAttachDroppedItems]
  )

  const onDropSession = useCallback((session: SessionDragPayload) => {
    requestComposerInsertRefs([sessionInlineRef(session)], { target: 'main' })
  }, [])

  const { dragKind, dropHandlers } = useFileDropZone({ enabled: showChatBar, onDropFiles, onDropSession })

  return (
    <div
      className={cn(
        'relative isolate flex h-full min-w-0 flex-col overflow-hidden bg-(--ui-chat-surface-background)',
        className
      )}
      data-dsl-chat-renderer
    >
      <Backdrop />
      <ChatHeader
        activeSessionId={activeSessionId}
        isRoutedSessionView={isRoutedSessionView}
        leadingContent={primaryViewToggle}
        onDeleteSelectedSession={onDeleteSelectedSession}
        onToggleSelectedPin={onToggleSelectedPin}
        selectedSessionId={selectedSessionId}
      />
      <PromptOverlays />
      <div
        className="relative min-h-0 max-w-full flex-1 overflow-hidden bg-(--ui-chat-surface-background) contain-[layout_paint]"
        {...dropHandlers}
      >
        <ChatRuntimeBoundary
          busy={busy}
          onCancel={onCancel}
          onEdit={onEdit}
          onReload={onReload}
          onThreadMessagesChange={onThreadMessagesChange}
          suppressMessages={routeSessionMismatch}
        >
          <DslConversationRendererBoundary
            onSelectWorkspaceBlock={onSelectWorkspaceBlock}
            onWorkspaceBlockAction={onWorkspaceBlockAction}
            rawWorkspaceEvents={rawWorkspaceEvents}
            selectedWorkspaceObjectId={selectedWorkspaceObjectId}
            showChatBar={showChatBar}
            suppressMessages={routeSessionMismatch}
            workspaceBlocks={workspaceBlocks}
            workspaceObjects={workspaceObjects}
          />
          {showChatBar && (
            <Suspense fallback={<ChatBarFallback />}>
              <ChatBar
                busy={busy}
                cwd={currentCwd}
                disabled={!gatewayOpen}
                focusKey={activeSessionId}
                gateway={gateway}
                maxRecordingSeconds={maxVoiceRecordingSeconds}
                onAddContextRef={onAddContextRef}
                onAddUrl={onAddUrl}
                onAttachDroppedItems={onAttachDroppedItems}
                onAttachImageBlob={onAttachImageBlob}
                onCancel={onCancel}
                onPasteClipboardImage={onPasteClipboardImage}
                onPickFiles={onPickFiles}
                onPickFolders={onPickFolders}
                onPickImages={onPickImages}
                onRemoveAttachment={onRemoveAttachment}
                onSteer={onSteer}
                onSubmit={onSubmit}
                onTranscribeAudio={onTranscribeAudio}
                queueSessionKey={selectedSessionId}
                sessionId={activeSessionId}
                state={chatBarState}
              />
            </Suspense>
          )}
        </ChatRuntimeBoundary>
        {threadLoading && <DslChatLoadingOverlay kind={threadLoading} />}
        {showChatBar && <ScrollToBottomButton />}
        <ChatDropOverlay kind={dragKind} />
        <ChatSwapOverlay profile={gatewaySwapTarget} />
      </div>
    </div>
  )
}
