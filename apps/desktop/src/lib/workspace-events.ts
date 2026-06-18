import type { GatewayEvent } from '@hermes/shared'

export type WorkspaceGatewayEvent = GatewayEvent & {
  error?: { message?: unknown } | null
  event_id?: string
  payload?: unknown
  run_id?: string
  session_id?: string
  timestamp?: string
  tool_call_id?: string
  turn_id?: string
}

type ObjectStatus = 'active' | 'blocked' | 'done' | 'error' | 'new' | 'queued' | 'stale' | 'waiting'

type WorkspaceObjectType = 'artifact' | 'capability' | 'decision' | 'preview' | 'run' | 'session' | 'task' | 'trace'

export interface WorkspaceDebugRef {
  id?: string
  kind: 'gateway_event' | 'raw_payload' | 'run' | 'session' | 'tool_call'
  label?: string
}

interface WorkspaceObjectBase {
  child_ids?: string[]
  completed_at?: string
  created_at: string
  debug_refs: WorkspaceDebugRef[]
  id: string
  object_type: WorkspaceObjectType
  parent_id?: string
  parent_type?: WorkspaceObjectType
  related_object_ids?: string[]
  schema_version: 'workspace-object.v2'
  source_event_ids: string[]
  started_at?: string
  status: ObjectStatus
  title: string
  updated_at: string
}

export interface WorkspaceSessionObject extends WorkspaceObjectBase {
  object_type: 'session'
  runtime?: {
    branch?: string
    cwd?: string
    fast?: boolean
    model?: string
    personality?: string
    provider?: string
    reasoning_effort?: string
    service_tier?: string
    yolo?: boolean
  }
  usage?: Record<string, unknown>
}

export interface WorkspaceRunObject extends WorkspaceObjectBase {
  object_type: 'run'
  progress?: {
    duration_s?: number
    heartbeat_at?: string
    phase?: string
  }
  result_view?: {
    args?: Record<string, unknown>
    error?: string | boolean
    inline_diff?: string
    output_text?: string
    preview?: string
    result?: unknown
    summary?: string
  }
  run_kind: 'agent_turn' | 'command' | 'pipeline' | 'subagent' | 'task_run' | 'tool_call'
  runtime?: {
    model?: string
    provider?: string
    run_id?: string
    session_id?: string
    tool_call_id?: string
    turn_id?: string
  }
}

export interface WorkspaceDecisionObject extends WorkspaceObjectBase {
  blocks_object_ids?: string[]
  decision_kind: 'approval' | 'clarification' | 'policy' | 'secret'
  object_type: 'decision'
  state: 'cancelled' | 'expired' | 'requested' | 'resolved'
  view_model: {
    allow_permanent?: boolean
    choices?: string[] | null
    command?: string
    description?: string
    env_var?: string
    prompt?: string
    question?: string
    request_id: string
  }
}

export interface WorkspaceTaskObject extends WorkspaceObjectBase {
  assignee?: 'assistant' | 'subagent' | 'system' | 'user'
  instructions?: string
  object_type: 'task'
  task_kind: 'follow_up' | 'plan_step' | 'remediation' | 'subagent_task' | 'todo' | 'user_request'
}

export interface WorkspaceTraceObject extends WorkspaceObjectBase {
  body?: string
  object_type: 'trace'
  trace_kind: 'error' | 'reasoning' | 'status' | 'text'
}

export type WorkspaceObject =
  | WorkspaceDecisionObject
  | WorkspaceRunObject
  | WorkspaceSessionObject
  | WorkspaceTaskObject
  | WorkspaceTraceObject

interface ActiveToolRun {
  key: string
  runId: string
}

export interface WorkspaceEventCompilerState {
  currentRunIdBySession: Record<string, string>
  activeToolRunsBySession: Record<string, ActiveToolRun[]>
  currentTurnIdBySession: Record<string, string>
  objects: Record<string, WorkspaceObject>
  toolCountersBySession: Record<string, number>
  turnCountersBySession: Record<string, number>
}

export interface WorkspaceEventCompilerOptions {
  /**
   * Used for foreground events that arrive without session_id, matching the
   * existing transcript router. Subagent events still require an explicit id.
   */
  activeSessionId?: string | null
  /**
   * Local fallback for events that do not carry backend timestamps.
   */
  nowIso?: string
}

type GatewayWorkspacePayload = {
  allow_permanent?: boolean
  args?: unknown
  arguments?: unknown
  branch?: string
  choices?: string[] | null
  command?: string
  context?: string
  cwd?: string
  description?: string
  duration_s?: number
  env_var?: string
  error?: boolean | string
  fast?: boolean
  id?: string
  inline_diff?: string
  input?: unknown
  kind?: string
  message?: string
  model?: string
  name?: string
  personality?: string
  preview?: string
  prompt?: string
  provider?: string
  question?: string
  reasoning_effort?: string
  rendered?: string
  request_id?: string
  result?: unknown
  run_id?: string
  running?: boolean
  service_tier?: string
  status?: string
  subagent_id?: string
  summary?: string
  text?: string
  tool_call_id?: string
  tool_id?: string
  turn_id?: string
  usage?: Record<string, unknown>
  yolo?: boolean
}

const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z'

export function createInitialWorkspaceEventState(): WorkspaceEventCompilerState {
  return {
    activeToolRunsBySession: {},
    currentRunIdBySession: {},
    currentTurnIdBySession: {},
    objects: {},
    toolCountersBySession: {},
    turnCountersBySession: {}
  }
}

export function applyGatewayEventToWorkspace(
  state: WorkspaceEventCompilerState,
  event: WorkspaceGatewayEvent,
  options: WorkspaceEventCompilerOptions = {}
): WorkspaceEventCompilerState {
  const payload = asPayload(event.payload)
  const sessionId = event.session_id || options.activeSessionId || ''

  if (!sessionId && event.type !== 'session.info') {
    return state
  }

  if (!event.session_id && event.type.startsWith('subagent.')) {
    return state
  }

  const now = stringValue(event.timestamp) || options.nowIso || DEFAULT_TIMESTAMP
  const sourceEventId = gatewaySourceEventId(event)
  let next = cloneState(state)

  if (event.type === 'session.info') {
    next = upsertObject(next, sessionObject(sessionId || 'global', payload, sourceEventId, now))
    const runId = currentTurnId(next, sessionId)

    if (runId && typeof payload.running === 'boolean') {
      next = patchRun(next, runId, sourceEventId, now, run => ({
        ...run,
        status: payload.running ? 'active' : run.status === 'active' ? 'done' : run.status,
        updated_at: now,
        ...(payload.running ? {} : { completed_at: now })
      }))
    }

    return next
  }

  if (event.type === 'message.start') {
    const turnId = gatewayTurnId(event, payload) || nextTurnId(next, sessionId)
    const backendRunId = gatewayRunId(event, payload)
    const runId = agentTurnRunId(sessionId, backendRunId || turnId)
    next.currentRunIdBySession[sessionId] = runId
    next.currentTurnIdBySession[sessionId] = turnId

    return upsertObject(
      next,
      runObject({
        id: runId,
        kind: 'agent_turn',
        parentId: sessionObjectId(sessionId),
        phase: 'running',
        sessionId,
        sourceEventId,
        status: 'active',
        title: 'Assistant turn',
        turnId,
        backendRunId,
        now
      })
    )
  }

  if (event.type === 'message.delta' || event.type === 'reasoning.delta' || event.type === 'reasoning.available') {
    const runId = ensureTurnRun(next, sessionId, sourceEventId, now)
    const text = stringValue(payload.text)
    const traceKind = event.type === 'message.delta' ? 'text' : 'reasoning'
    const traceId = `${runId}:trace:${traceKind}`

    return upsertTrace(next, traceId, {
      bodyDelta: text,
      kind: traceKind,
      parentId: runId,
      sourceEventId,
      title: traceKind === 'reasoning' ? 'Reasoning' : 'Assistant output',
      now
    })
  }

  if (event.type === 'message.complete') {
    const runId = ensureTurnRun(next, sessionId, sourceEventId, now)
    const outputText = stringValue(payload.text) || stringValue(payload.rendered)

    return patchRun(next, runId, sourceEventId, now, run => ({
      ...run,
      completed_at: now,
      progress: { ...run.progress, phase: 'complete' },
      result_view: { ...run.result_view, output_text: outputText },
      status: 'done',
      updated_at: now
    }))
  }

  if (event.type === 'tool.start' || event.type === 'tool.progress' || event.type === 'tool.generating') {
    return upsertToolRun(next, sessionId, payload, sourceEventId, now, event.type, gatewayToolCallId(event, payload))
  }

  if (event.type === 'tool.complete') {
    return upsertToolRun(next, sessionId, payload, sourceEventId, now, event.type, gatewayToolCallId(event, payload))
  }

  if (
    event.type === 'approval.request' ||
    event.type === 'clarify.request' ||
    event.type === 'secret.request' ||
    event.type === 'sudo.request'
  ) {
    return upsertDecision(next, sessionId, payload, sourceEventId, now, event.type)
  }

  if (
    event.type === 'approval.resolved' ||
    event.type === 'clarify.resolved' ||
    event.type === 'secret.resolved' ||
    event.type === 'sudo.resolved'
  ) {
    return resolveDecision(next, sessionId, payload, sourceEventId, now)
  }

  if (event.type === 'status.update') {
    const runId = currentRunObjectId(next, sessionId)
    const traceId = `${sessionObjectId(sessionId)}:status:${payload.status || payload.message || payload.kind || 'update'}`
    next = upsertTrace(next, traceId, {
      bodyDelta: stringValue(payload.message || payload.status || payload.kind),
      kind: 'status',
      parentId: runId || sessionObjectId(sessionId),
      sourceEventId,
      title: 'Status update',
      now
    })

    return payload.kind === 'compacting' && runId
      ? patchRun(next, runId, sourceEventId, now, run => ({ ...run, progress: { ...run.progress, phase: 'compacting' } }))
      : next
  }

  if (event.type === 'error') {
    const runId = currentRunObjectId(next, sessionId)
    const errorMessage = gatewayErrorMessage(event, payload) || 'Hermes reported an error'
    next = upsertTrace(next, `${runId || sessionObjectId(sessionId)}:error`, {
      bodyDelta: errorMessage,
      kind: 'error',
      parentId: runId || sessionObjectId(sessionId),
      sourceEventId,
      title: 'Hermes error',
      now
    })

    return runId
      ? patchRun(next, runId, sourceEventId, now, run => ({
          ...run,
          completed_at: now,
          progress: { ...run.progress, phase: 'error' },
          result_view: { ...run.result_view, error: errorMessage },
          status: 'error',
          updated_at: now
        }))
      : next
  }

  if (event.type.startsWith('subagent.')) {
    return upsertSubagentRun(next, sessionId, payload, sourceEventId, now, event.type)
  }

  return state
}

function cloneState(state: WorkspaceEventCompilerState): WorkspaceEventCompilerState {
  return {
    activeToolRunsBySession: Object.fromEntries(
      Object.entries(state.activeToolRunsBySession).map(([key, value]) => [key, value.map(row => ({ ...row }))])
    ),
    currentRunIdBySession: { ...state.currentRunIdBySession },
    currentTurnIdBySession: { ...state.currentTurnIdBySession },
    objects: { ...state.objects },
    toolCountersBySession: { ...state.toolCountersBySession },
    turnCountersBySession: { ...state.turnCountersBySession }
  }
}

function asPayload(payload: unknown): GatewayWorkspacePayload {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as GatewayWorkspacePayload)
    : {}
}

function sessionObject(sessionId: string, payload: GatewayWorkspacePayload, sourceEventId: string, now: string) {
  const id = sessionObjectId(sessionId)

  return {
    created_at: now,
    debug_refs: [{ id: sourceEventId, kind: 'gateway_event' }],
    id,
    object_type: 'session',
    runtime: {
      branch: payload.branch,
      cwd: payload.cwd,
      fast: payload.fast,
      model: payload.model,
      personality: payload.personality,
      provider: payload.provider,
      reasoning_effort: payload.reasoning_effort,
      service_tier: payload.service_tier,
      yolo: payload.yolo
    },
    schema_version: 'workspace-object.v2',
    source_event_ids: [sourceEventId],
    status: payload.running ? 'active' : 'new',
    title: sessionId === 'global' ? 'Gateway session defaults' : `Session ${sessionId}`,
    updated_at: now,
    usage: payload.usage
  } satisfies WorkspaceSessionObject
}

function runObject({
  id,
  kind,
  parentId,
  phase,
  sessionId,
  sourceEventId,
  status,
  title,
  toolCallId,
  turnId,
  backendRunId,
  now
}: {
  id: string
  kind: WorkspaceRunObject['run_kind']
  parentId?: string
  phase: string
  sessionId: string
  sourceEventId: string
  status: ObjectStatus
  title: string
  toolCallId?: string
  turnId?: string
  backendRunId?: string
  now: string
}): WorkspaceRunObject {
  return {
    created_at: now,
    debug_refs: [{ id: sourceEventId, kind: 'gateway_event' }],
    id,
    object_type: 'run',
    parent_id: parentId,
    parent_type: parentId ? (parentId.includes(':run:') ? 'run' : 'session') : undefined,
    progress: { heartbeat_at: now, phase },
    run_kind: kind,
    runtime: { session_id: sessionId, run_id: backendRunId, tool_call_id: toolCallId, turn_id: turnId },
    schema_version: 'workspace-object.v2',
    source_event_ids: [sourceEventId],
    started_at: now,
    status,
    title,
    updated_at: now
  }
}

function upsertToolRun(
  state: WorkspaceEventCompilerState,
  sessionId: string,
  payload: GatewayWorkspacePayload,
  sourceEventId: string,
  now: string,
  eventType: string,
  toolCallId: string
): WorkspaceEventCompilerState {
  const name = payload.name || 'tool'
  const key = toolRunKey(name, toolCallId, payload)
  const runId = toolCallId
    ? `${sessionObjectId(sessionId)}:run:tool:${toolCallId}`
    : activeOrNextToolRunId(state, sessionId, key, name)
  const parentId = currentRunObjectId(state, sessionId) || sessionObjectId(sessionId)
  const phase = eventType === 'tool.generating' ? 'generating' : eventType === 'tool.complete' ? 'complete' : 'running'
  const status = eventType === 'tool.complete' ? (payload.error ? 'error' : 'done') : 'active'

  const next = upsertObject(
    state,
    runObject({
      id: runId,
      kind: 'tool_call',
      parentId,
      phase,
      sessionId,
      sourceEventId,
      status,
      title: name,
      toolCallId,
      now
    })
  )

  rememberToolRun(next, sessionId, key, runId)

  const patched = patchRun(next, runId, sourceEventId, now, run => ({
    ...run,
    completed_at: eventType === 'tool.complete' ? now : run.completed_at,
    progress: { ...run.progress, duration_s: payload.duration_s, heartbeat_at: now, phase },
    result_view: {
      ...run.result_view,
      args: { ...run.result_view?.args, ...toolArgs(payload) },
      error: payload.error,
      inline_diff: payload.inline_diff,
      output_text: stringValue(payload.message || payload.context),
      preview: payload.preview,
      result: eventType === 'tool.complete' ? payload.result : run.result_view?.result,
      summary: payload.summary
    },
    status,
    updated_at: now
  }))

  if (eventType === 'tool.complete') {
    forgetToolRun(patched, sessionId, key, runId)
  }

  return patched
}

function upsertDecision(
  state: WorkspaceEventCompilerState,
  sessionId: string,
  payload: GatewayWorkspacePayload,
  sourceEventId: string,
  now: string,
  eventType: string
): WorkspaceEventCompilerState {
  const requestId = payload.request_id || `${eventType}:${stableStringify(payload)}`
  const runId = currentRunObjectId(state, sessionId)
  const kind: WorkspaceDecisionObject['decision_kind'] =
    eventType === 'approval.request'
      ? 'approval'
      : eventType === 'clarify.request'
        ? 'clarification'
        : eventType === 'secret.request' || eventType === 'sudo.request'
          ? 'secret'
          : 'policy'
  const title =
    kind === 'approval'
      ? 'Approval required'
      : kind === 'clarification'
        ? 'Clarification needed'
        : eventType === 'sudo.request'
          ? 'Sudo password required'
          : 'Secret required'
  const decision: WorkspaceDecisionObject = {
    blocks_object_ids: runId ? [runId] : undefined,
    created_at: now,
    debug_refs: [{ id: sourceEventId, kind: 'gateway_event' }],
    decision_kind: kind,
    id: `${sessionObjectId(sessionId)}:decision:${requestId}`,
    object_type: 'decision',
    parent_id: runId || sessionObjectId(sessionId),
    parent_type: runId ? 'run' : 'session',
    schema_version: 'workspace-object.v2',
    source_event_ids: [sourceEventId],
    state: 'requested',
    status: 'waiting',
    title,
    updated_at: now,
    view_model: {
      allow_permanent: payload.allow_permanent !== false,
      choices: Array.isArray(payload.choices) ? payload.choices.filter(choice => typeof choice === 'string') : null,
      command: payload.command,
      description: payload.description,
      env_var: payload.env_var,
      prompt: payload.prompt,
      question: payload.question,
      request_id: requestId
    }
  }

  const next = upsertObject(state, decision)

  return runId
    ? patchRun(next, runId, sourceEventId, now, run => ({ ...run, status: 'waiting', updated_at: now }))
    : next
}

function resolveDecision(
  state: WorkspaceEventCompilerState,
  sessionId: string,
  payload: GatewayWorkspacePayload,
  sourceEventId: string,
  now: string
): WorkspaceEventCompilerState {
  const requestId = payload.request_id

  if (!requestId) {
    return state
  }

  const decisionId = `${sessionObjectId(sessionId)}:decision:${requestId}`
  const decision = state.objects[decisionId]

  if (!decision || decision.object_type !== 'decision') {
    return state
  }

  state.objects[decisionId] = {
    ...decision,
    completed_at: now,
    debug_refs: mergeDebugRefs(decision.debug_refs, [{ id: sourceEventId, kind: 'gateway_event' }]),
    source_event_ids: mergeIds(decision.source_event_ids, [sourceEventId]),
    state: 'resolved',
    status: 'done',
    updated_at: now
  }

  return state
}

function upsertSubagentRun(
  state: WorkspaceEventCompilerState,
  sessionId: string,
  payload: GatewayWorkspacePayload,
  sourceEventId: string,
  now: string,
  eventType: string
): WorkspaceEventCompilerState {
  const subagentId = payload.subagent_id || payload.id || `${eventType}:${stableStringify(payload)}`
  const runId = `${sessionObjectId(sessionId)}:run:subagent:${subagentId}`
  const existing = state.objects[runId]
  const status: ObjectStatus = eventType === 'subagent.complete' ? (payload.error ? 'error' : 'done') : 'active'
  const phase = eventType.slice('subagent.'.length)

  return patchRun(
    upsertObject(
      state,
      runObject({
        id: runId,
        kind: 'subagent',
        parentId: currentRunObjectId(state, sessionId) || sessionObjectId(sessionId),
        phase,
        sessionId,
        sourceEventId,
        status,
        title: subagentRunTitle(payload, subagentId, existing?.object_type === 'run' ? existing.title : undefined),
        now
      })
    ),
    runId,
    sourceEventId,
    now,
    run => ({
      ...run,
      completed_at: eventType === 'subagent.complete' ? now : run.completed_at,
      progress: { ...run.progress, duration_s: payload.duration_s, heartbeat_at: now, phase },
      result_view: {
        ...run.result_view,
        error: payload.error,
        output_text: stringValue(payload.text || payload.message),
        preview: payload.preview,
        result: payload.result,
        summary: payload.summary
      },
      status
    })
  )
}

function subagentRunTitle(payload: GatewayWorkspacePayload, subagentId: string, previousTitle?: string): string {
  const previous = compactTitle(previousTitle)

  if (previous) {
    return previous
  }

  return (
    compactTitle(stringValue(payload.message)) ||
    compactTitle(stringValue(payload.text)) ||
    compactTitle(stringValue(payload.summary)) ||
    'Subagent'
  )
}

function upsertTrace(
  state: WorkspaceEventCompilerState,
  traceId: string,
  {
    bodyDelta,
    kind,
    parentId,
    sourceEventId,
    title,
    now
  }: {
    bodyDelta: string
    kind: WorkspaceTraceObject['trace_kind']
    parentId: string
    sourceEventId: string
    title: string
    now: string
  }
): WorkspaceEventCompilerState {
  const prev = state.objects[traceId] as WorkspaceTraceObject | undefined
  const trace: WorkspaceTraceObject = {
    body: `${prev?.body ?? ''}${bodyDelta}`,
    created_at: prev?.created_at ?? now,
    debug_refs: mergeDebugRefs(prev?.debug_refs, [{ id: sourceEventId, kind: 'gateway_event' }]),
    id: traceId,
    object_type: 'trace',
    parent_id: parentId,
    parent_type: parentId.includes(':run:') ? 'run' : 'session',
    schema_version: 'workspace-object.v2',
    source_event_ids: mergeIds(prev?.source_event_ids, [sourceEventId]),
    status: kind === 'error' ? 'error' : 'active',
    title,
    trace_kind: kind,
    updated_at: now
  }

  return upsertObject(state, trace)
}

function upsertObject<T extends WorkspaceObject>(state: WorkspaceEventCompilerState, object: T): WorkspaceEventCompilerState {
  const prev = state.objects[object.id]
  const merged = prev
    ? ({
        ...prev,
        ...object,
        created_at: prev.created_at,
        debug_refs: mergeDebugRefs(prev.debug_refs, object.debug_refs),
        source_event_ids: mergeIds(prev.source_event_ids, object.source_event_ids)
      } as WorkspaceObject)
    : object

  state.objects[object.id] = merged
  linkParent(state, merged)

  return state
}

function patchRun(
  state: WorkspaceEventCompilerState,
  runId: string,
  sourceEventId: string,
  now: string,
  updater: (run: WorkspaceRunObject) => WorkspaceRunObject
): WorkspaceEventCompilerState {
  const run = state.objects[runId]

  if (!run || run.object_type !== 'run') {
    return state
  }

  const updated = updater(run)
  state.objects[runId] = {
    ...updated,
    debug_refs: mergeDebugRefs(updated.debug_refs, [{ id: sourceEventId, kind: 'gateway_event' }]),
    source_event_ids: mergeIds(updated.source_event_ids, [sourceEventId]),
    updated_at: now
  }

  return state
}

function linkParent(state: WorkspaceEventCompilerState, object: WorkspaceObject): void {
  if (!object.parent_id) {
    return
  }

  const parent = state.objects[object.parent_id]

  if (!parent) {
    return
  }

  const childIds = parent.child_ids ?? []

  if (childIds.includes(object.id)) {
    return
  }

  state.objects[parent.id] = { ...parent, child_ids: [...childIds, object.id] }
}

function ensureTurnRun(
  state: WorkspaceEventCompilerState,
  sessionId: string,
  sourceEventId: string,
  now: string
): string {
  const current = currentRunObjectId(state, sessionId)

  if (current) {
    return current
  }

  const turnId = nextTurnId(state, sessionId)
  const runId = agentTurnRunId(sessionId, turnId)
  state.currentRunIdBySession[sessionId] = runId
  state.currentTurnIdBySession[sessionId] = turnId
  upsertObject(
    state,
    runObject({
      id: runId,
      kind: 'agent_turn',
      parentId: sessionObjectId(sessionId),
      phase: 'running',
      sessionId,
      sourceEventId,
      status: 'active',
      title: 'Assistant turn',
      turnId,
      now
    })
  )

  return runId
}

function currentTurnId(state: WorkspaceEventCompilerState, sessionId: string): string {
  return sessionId ? (state.currentTurnIdBySession[sessionId] ?? '') : ''
}

function currentRunObjectId(state: WorkspaceEventCompilerState, sessionId: string): string {
  const runId = state.currentRunIdBySession[sessionId]

  if (runId) {
    return runId
  }

  const turnId = currentTurnId(state, sessionId)

  return turnId ? agentTurnRunId(sessionId, turnId) : ''
}

function nextTurnId(state: WorkspaceEventCompilerState, sessionId: string): string {
  const next = (state.turnCountersBySession[sessionId] ?? 0) + 1
  state.turnCountersBySession[sessionId] = next

  return `turn-${next}`
}

function activeOrNextToolRunId(
  state: WorkspaceEventCompilerState,
  sessionId: string,
  key: string,
  name: string
): string {
  const active = state.activeToolRunsBySession[sessionId]?.find(row => row.key === key)

  if (active) {
    return active.runId
  }

  const next = (state.toolCountersBySession[sessionId] ?? 0) + 1
  state.toolCountersBySession[sessionId] = next

  return `${sessionObjectId(sessionId)}:run:tool:${name}:${next}`
}

function toolRunKey(name: string, toolCallId: string, payload: GatewayWorkspacePayload): string {
  if (toolCallId) {
    return toolCallId
  }

  if (isDelegationToolName(name)) {
    const raw = payload as Record<string, unknown>

    return `delegate:${name}:${stringValue(payload.subagent_id) || stringValue(raw.parent_id) || 'active'}`
  }

  return `${name}:${stableStringify(toolArgs(payload)) || stringValue(payload.context || payload.preview)}`
}

function isDelegationToolName(name: string): boolean {
  return name === 'delegate_task' || name === 'delegate' || name === 'subagent'
}

function rememberToolRun(state: WorkspaceEventCompilerState, sessionId: string, key: string, runId: string): void {
  const rows = state.activeToolRunsBySession[sessionId] ?? []

  if (rows.some(row => row.key === key && row.runId === runId)) {
    return
  }

  state.activeToolRunsBySession[sessionId] = [...rows, { key, runId }]
}

function forgetToolRun(state: WorkspaceEventCompilerState, sessionId: string, key: string, runId: string): void {
  const rows = state.activeToolRunsBySession[sessionId] ?? []
  const next = rows.filter(row => row.key !== key || row.runId !== runId)

  if (next.length) {
    state.activeToolRunsBySession[sessionId] = next
  } else {
    delete state.activeToolRunsBySession[sessionId]
  }
}

function agentTurnRunId(sessionId: string, turnId: string): string {
  return `${sessionObjectId(sessionId)}:run:agent_turn:${turnId}`
}

function sessionObjectId(sessionId: string): string {
  return `session:${sessionId || 'unknown'}`
}

function toolArgs(payload: GatewayWorkspacePayload): Record<string, unknown> {
  return {
    ...recordFromUnknown(payload.input),
    ...recordFromUnknown(payload.args),
    ...recordFromUnknown(payload.arguments),
    ...(payload.context ? { context: payload.context } : {}),
    ...(payload.preview ? { preview: payload.preview } : {})
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  if (typeof value !== 'string' || !value.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(value)

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function compactTitle(value: string | undefined): string {
  const compact = stringValue(value).replace(/\s+/g, ' ').trim()

  if (!compact || compact.length > 79 || compact.includes('#') || compact.includes('- ')) {
    return ''
  }

  return compact
}

function gatewayRunId(event: WorkspaceGatewayEvent, payload: GatewayWorkspacePayload): string {
  return stringValue(event.run_id) || stringValue(payload.run_id)
}

function gatewaySourceEventId(event: WorkspaceGatewayEvent): string {
  if (event.event_id) {
    return event.event_id
  }

  return `gateway:${event.session_id || 'unscoped'}:${event.type}:${stableStringify(event.payload)}`
}

function gatewayToolCallId(event: WorkspaceGatewayEvent, payload: GatewayWorkspacePayload): string {
  return (
    stringValue(event.tool_call_id) ||
    stringValue(payload.tool_call_id) ||
    stringValue(payload.tool_id) ||
    stringValue(payload.id)
  )
}

function gatewayTurnId(event: WorkspaceGatewayEvent, payload: GatewayWorkspacePayload): string {
  return stringValue(event.turn_id) || stringValue(payload.turn_id) || stringValue(payload.id)
}

function gatewayErrorMessage(event: WorkspaceGatewayEvent, payload: GatewayWorkspacePayload): string {
  return stringValue(event.error?.message) || stringValue(payload.message)
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }

  if (typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`
}

function mergeIds(left: readonly string[] | undefined, right: readonly string[]): string[] {
  return [...new Set([...(left ?? []), ...right])]
}

function mergeDebugRefs(
  left: readonly WorkspaceDebugRef[] | undefined,
  right: readonly WorkspaceDebugRef[]
): WorkspaceDebugRef[] {
  const seen = new Set<string>()
  const refs: WorkspaceDebugRef[] = []

  for (const ref of [...(left ?? []), ...right]) {
    const key = `${ref.kind}:${ref.id || ''}:${ref.label || ''}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    refs.push(ref)
  }

  return refs
}
