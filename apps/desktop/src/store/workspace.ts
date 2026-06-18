import { atom } from 'nanostores'

import { chatMessageText, type ChatMessage } from '@/lib/chat-messages'
import { projectWorkspaceObjectsToBlocks, type WorkspaceBlock } from '@/lib/workspace-blocks'
import {
  applyGatewayEventToWorkspace,
  createInitialWorkspaceEventState,
  type WorkspaceEventCompilerOptions,
  type WorkspaceEventCompilerState,
  type WorkspaceGatewayEvent,
  type WorkspaceObject
} from '@/lib/workspace-events'

type Updater<T> = T | ((current: T) => T)

interface AppAtom<T> {
  get: () => T
  set: (value: T) => void
}

export interface RawWorkspaceEvent {
  id: string
  payload?: unknown
  receivedAt: number
  sessionId?: string
  timestamp?: string
  type: string
}

export interface ApplyWorkspaceGatewayEventOptions extends WorkspaceEventCompilerOptions {
  receivedAt?: number
}

export interface ResolveWorkspaceSessionIdOptions {
  activeSessionId?: null | string
  newChatPath: string
  pathname: string
  routedSessionId?: null | string
  selectedStoredSessionId?: null | string
}

const RAW_WORKSPACE_EVENT_LIMIT = 200
const TRANSCRIPT_WORKSPACE_TURN_LIMIT = 4

function updateAtom<T>(store: AppAtom<T>, next: Updater<T>) {
  store.set(typeof next === 'function' ? (next as (current: T) => T)(store.get()) : next)
}

function rawWorkspaceEvent(event: WorkspaceGatewayEvent, receivedAt = Date.now()): RawWorkspaceEvent {
  return {
    id: event.event_id || `${receivedAt}:${event.session_id ?? 'global'}:${event.type}`,
    payload: event.payload,
    receivedAt,
    sessionId: event.session_id,
    timestamp: event.timestamp,
    type: event.type
  }
}

function appendRawWorkspaceEvent(event: WorkspaceGatewayEvent, receivedAt?: number): void {
  $rawWorkspaceEvents.set(
    [...$rawWorkspaceEvents.get(), rawWorkspaceEvent(event, receivedAt)].slice(-RAW_WORKSPACE_EVENT_LIMIT)
  )
}

function commitCompilerState(state: WorkspaceEventCompilerState): void {
  $workspaceCompilerState.set(state)
  $workspaceObjects.set(state.objects)
  $workspaceBlocks.set(projectWorkspaceObjectsToBlocks(state.objects))
}

function commitHydratedSessionState(
  sessionId: string,
  sessionState: WorkspaceEventCompilerState
): WorkspaceEventCompilerState {
  const base = workspaceCompilerStateWithoutSession($workspaceCompilerState.get(), sessionId)
  const next: WorkspaceEventCompilerState = {
    activeToolRunsBySession: {
      ...base.activeToolRunsBySession,
      ...sessionState.activeToolRunsBySession
    },
    currentRunIdBySession: {
      ...base.currentRunIdBySession,
      ...sessionState.currentRunIdBySession
    },
    currentTurnIdBySession: {
      ...base.currentTurnIdBySession,
      ...sessionState.currentTurnIdBySession
    },
    objects: {
      ...base.objects,
      ...workspaceObjectsForSession(sessionState.objects, sessionId)
    },
    toolCountersBySession: {
      ...base.toolCountersBySession,
      ...sessionState.toolCountersBySession
    },
    turnCountersBySession: {
      ...base.turnCountersBySession,
      ...sessionState.turnCountersBySession
    }
  }

  commitCompilerState(next)

  return next
}

export const $workspaceCompilerState = atom<WorkspaceEventCompilerState>(createInitialWorkspaceEventState())
export const $workspaceBlocks = atom<WorkspaceBlock[]>([])
export const $workspaceObjects = atom<Record<string, WorkspaceObject>>({})
export const $selectedWorkspaceObjectId = atom<null | string>(null)
export const $rawWorkspaceEvents = atom<RawWorkspaceEvent[]>([])

export const setSelectedWorkspaceObjectId = (next: Updater<null | string>) =>
  updateAtom($selectedWorkspaceObjectId, next)

export function resetWorkspaceState(): void {
  commitCompilerState(createInitialWorkspaceEventState())
  $selectedWorkspaceObjectId.set(null)
  $rawWorkspaceEvents.set([])
}

export function workspaceBlocksForSession(
  blocks: readonly WorkspaceBlock[],
  sessionId: string | null | undefined
): WorkspaceBlock[] {
  const sid = sessionId?.trim()

  if (!sid) {
    return []
  }

  return blocks.filter(block => workspaceBlockBelongsToSession(block, sid))
}

export function workspaceObjectsForSession(
  objects: Record<string, WorkspaceObject>,
  sessionId: string | null | undefined
): Record<string, WorkspaceObject> {
  const sid = sessionId?.trim()

  if (!sid) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(objects).filter(([, object]) => workspaceObjectBelongsToSession(object, sid))
  )
}

export function rawWorkspaceEventsForSession(
  events: readonly RawWorkspaceEvent[],
  sessionId: string | null | undefined
): RawWorkspaceEvent[] {
  const sid = sessionId?.trim()

  if (!sid) {
    return []
  }

  return events.filter(event => event.sessionId === sid)
}

export function selectedWorkspaceObjectForSession(
  selectedId: string | null,
  blocks: readonly WorkspaceBlock[],
  sessionId: string | null | undefined
): string | null {
  if (!selectedId) {
    return null
  }

  return workspaceBlocksForSession(blocks, sessionId).some(
    block => block.id === selectedId || block.source_object_ids.includes(selectedId)
  )
    ? selectedId
    : null
}

export function resolveWorkspaceSessionIdForRoute({
  activeSessionId,
  newChatPath,
  pathname,
  routedSessionId,
  selectedStoredSessionId
}: ResolveWorkspaceSessionIdOptions): string | null {
  if (pathname === newChatPath) {
    return null
  }

  return routedSessionId?.trim() || activeSessionId?.trim() || selectedStoredSessionId?.trim() || null
}

export function applyWorkspaceGatewayEvent(
  event: WorkspaceGatewayEvent,
  options: ApplyWorkspaceGatewayEventOptions = {}
): WorkspaceEventCompilerState {
  appendRawWorkspaceEvent(event, options.receivedAt)

  const next = applyGatewayEventToWorkspace($workspaceCompilerState.get(), event, options)
  commitCompilerState(next)

  return next
}

export function hydrateWorkspaceFromMessages(
  sessionId: string | null | undefined,
  messages: readonly ChatMessage[],
  options: { force?: boolean } = {}
): WorkspaceEventCompilerState {
  const sid = sessionId?.trim()

  if (!sid || (!options.force && workspaceHasSessionObjects($workspaceCompilerState.get(), sid))) {
    return $workspaceCompilerState.get()
  }

  let state = createInitialWorkspaceEventState()
  const rawEvents: RawWorkspaceEvent[] = []

  for (const event of transcriptWorkspaceEvents(sid, messages)) {
    rawEvents.push(rawWorkspaceEvent(event, rawEvents.length + 1))
    state = applyGatewayEventToWorkspace(state, event, { activeSessionId: sid })
  }

  const next = commitHydratedSessionState(sid, state)
  const selectedId = $selectedWorkspaceObjectId.get()

  if (
    selectedId &&
    !selectedWorkspaceObjectForSession(selectedId, projectWorkspaceObjectsToBlocks(next.objects), sid)
  ) {
    $selectedWorkspaceObjectId.set(null)
  }

  $rawWorkspaceEvents.set(
    [...$rawWorkspaceEvents.get().filter(event => event.sessionId !== sid), ...rawEvents].slice(
      -RAW_WORKSPACE_EVENT_LIMIT
    )
  )

  return next
}

function workspaceHasSessionObjects(state: WorkspaceEventCompilerState, sessionId: string): boolean {
  const prefix = `session:${sessionId}`

  return Object.values(state.objects).some(object => {
    const runtimeSessionId = object.object_type === 'run' ? object.runtime?.session_id : undefined

    return object.id.startsWith(prefix) || runtimeSessionId === sessionId
  })
}

function workspaceCompilerStateWithoutSession(
  state: WorkspaceEventCompilerState,
  sessionId: string
): WorkspaceEventCompilerState {
  return {
    activeToolRunsBySession: omitSessionKey(state.activeToolRunsBySession, sessionId),
    currentRunIdBySession: omitSessionKey(state.currentRunIdBySession, sessionId),
    currentTurnIdBySession: omitSessionKey(state.currentTurnIdBySession, sessionId),
    objects: Object.fromEntries(
      Object.entries(state.objects).filter(([, object]) => !workspaceObjectBelongsToSession(object, sessionId))
    ),
    toolCountersBySession: omitSessionKey(state.toolCountersBySession, sessionId),
    turnCountersBySession: omitSessionKey(state.turnCountersBySession, sessionId)
  }
}

function omitSessionKey<T>(record: Record<string, T>, sessionId: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== sessionId))
}

function workspaceObjectBelongsToSession(object: WorkspaceObject, sessionId: string): boolean {
  const prefix = `session:${sessionId}`
  const runtimeSessionId = object.object_type === 'run' ? object.runtime?.session_id : undefined

  return object.id.startsWith(prefix) || runtimeSessionId === sessionId
}

function workspaceBlockBelongsToSession(block: WorkspaceBlock, sessionId: string): boolean {
  const prefix = `session:${sessionId}`

  return (
    block.id.includes(prefix) ||
    block.source_object_ids.some(id => id.startsWith(prefix)) ||
    block.source_event_ids.some(id => id.includes(`:${sessionId}:`) || id.includes(sessionId))
  )
}

function transcriptWorkspaceEvents(sessionId: string, messages: readonly ChatMessage[]): WorkspaceGatewayEvent[] {
  const events: WorkspaceGatewayEvent[] = []
  const assistantMessages = messages
    .filter(message => !message.hidden && message.role === 'assistant')
    .slice(-TRANSCRIPT_WORKSPACE_TURN_LIMIT)

  for (const [messageIndex, message] of assistantMessages.entries()) {
    const timestamp = messageTimestamp(message)
    const turnId = `transcript-turn-${message.id || messageIndex}`
    const base = `transcript:${sessionId}:${message.id || messageIndex}`

    events.push({
      event_id: `${base}:start`,
      payload: { turn_id: turnId },
      session_id: sessionId,
      timestamp,
      type: 'message.start'
    })

    for (const [partIndex, part] of message.parts.entries()) {
      if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
        events.push({
          event_id: `${base}:reasoning:${partIndex}`,
          payload: { text: part.text },
          session_id: sessionId,
          timestamp,
          type: 'reasoning.available'
        })
      }

      if (part.type === 'tool-call') {
        const tool = part as Extract<ChatMessage['parts'][number], { type: 'tool-call' }>
        const toolCallId = tool.toolCallId || `${message.id || messageIndex}:tool:${partIndex}`
        const toolName = tool.toolName || 'tool'

        events.push({
          event_id: `${base}:tool:${partIndex}:start`,
          payload: { args: tool.args, name: toolName, tool_id: toolCallId },
          session_id: sessionId,
          timestamp,
          type: 'tool.start'
        })
        events.push({
          event_id: `${base}:tool:${partIndex}:complete`,
          payload: {
            error: Boolean(tool.isError),
            name: toolName,
            result: tool.result,
            summary: transcriptToolSummary(tool.result),
            tool_id: toolCallId
          },
          session_id: sessionId,
          timestamp,
          type: 'tool.complete'
        })
      }
    }

    const text = chatMessageText(message).trim()

    if (text) {
      events.push({
        event_id: `${base}:delta`,
        payload: { text },
        session_id: sessionId,
        timestamp,
        type: 'message.delta'
      })
    }

    events.push({
      event_id: `${base}:complete`,
      payload: text ? { text } : {},
      session_id: sessionId,
      timestamp,
      type: 'message.complete'
    })
  }

  return events
}

function messageTimestamp(message: ChatMessage): string {
  const value = message.timestamp

  if (!value) {
    return new Date(0).toISOString()
  }

  return new Date(value < 1_000_000_000_000 ? value * 1000 : value).toISOString()
}

function transcriptToolSummary(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>

    for (const key of ['summary', 'message', 'context', 'text', 'preview']) {
      const candidate = record[key]

      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate
      }
    }
  }

  return ''
}
