import type {
  WorkspaceDebugRef,
  WorkspaceDecisionObject,
  WorkspaceObject,
  WorkspaceRunObject,
  WorkspaceTraceObject
} from './workspace-events'

type WorkspaceBlockStatus = WorkspaceObject['status']

export interface WorkspaceBlockAction {
  id: string
  kind: 'answer' | 'approve' | 'open_debug' | 'reject'
  label: string
  metadata?: Record<string, unknown>
}

export interface WorkspaceBlockBase {
  actions: WorkspaceBlockAction[]
  created_at: string
  debug_refs: WorkspaceDebugRef[]
  id: string
  priority?: 'high' | 'medium' | 'low'
  source_object_ids: string[]
  source_event_ids: string[]
  status?: WorkspaceBlockStatus
  title: string
  type: 'LIST' | 'NOTE' | 'RUN' | 'TOPIC'
  updated_at: string
}

export interface WorkspaceListItem {
  actions?: WorkspaceBlockAction[]
  content: string
  debug_refs?: WorkspaceDebugRef[]
  id: string
  source_object_id: string
  source_ref?: string
  status: 'blocked' | 'cancelled' | 'completed' | 'pending'
}

export interface WorkspaceListBlock extends WorkspaceBlockBase {
  items: WorkspaceListItem[]
  list_kind: 'confirmations' | 'plan'
  summary: {
    completed: number
    pending: number
    total: number
  }
  type: 'LIST'
}

export interface WorkspaceNoteBlock extends WorkspaceBlockBase {
  body: string
  note_kind: 'artifact' | 'error' | 'subagent_result' | 'summary'
  severity?: 'error' | 'info'
  type: 'NOTE'
}

export interface WorkspaceRunValue {
  debug_refs?: WorkspaceDebugRef[]
  label: string
  value_preview: string
}

export interface WorkspaceRunBlock extends WorkspaceBlockBase {
  child_run_ids?: string[]
  error?: {
    message: string
  }
  outputs?: WorkspaceRunValue[]
  progress?: {
    duration_s?: number
    heartbeat_at?: string
    phase?: string
    started_at?: string
    ended_at?: string
  }
  run_kind: 'agent_turn' | 'subagent' | 'tool_activity'
  runtime?: {
    model?: string
    provider?: string
    run_id?: string
    session_id?: string
    turn_id?: string
  }
  type: 'RUN'
}

export interface WorkspaceTopicBullet {
  debug_refs?: WorkspaceDebugRef[]
  id: string
  source_event_ids?: string[]
  text: string
}

export interface WorkspaceTopicBlock extends WorkspaceBlockBase {
  bullets: WorkspaceTopicBullet[]
  state: 'decided' | 'exploring' | 'stale'
  thesis?: string
  topic_kind: 'findings' | 'reasoning' | 'subagent_result'
  type: 'TOPIC'
}

export type WorkspaceBlock = WorkspaceListBlock | WorkspaceNoteBlock | WorkspaceRunBlock | WorkspaceTopicBlock

export function projectWorkspaceObjectsToBlocks(
  objects: Record<string, WorkspaceObject> | WorkspaceObject[]
): WorkspaceBlock[] {
  const rows = objectArray(objects).sort(sortObjectsStable)
  const blocks: WorkspaceBlock[] = []
  const agentRuns = rows.filter(isAgentTurnRun)
  const subagentRuns = rows.filter(isSubagentRun)
  const toolRunsByParent = groupBy(rows.filter(isToolRun), toolActivityGroupKey)
  const textNotesByParent = new Map<string, WorkspaceTraceObject[]>()
  const reasoningByParent = new Map<string, WorkspaceTraceObject[]>()
  const errorsByParent = new Map<string, WorkspaceObject[]>()
  const decisions = rows.filter(isDecisionObject)

  for (const object of rows) {
    if (object.object_type === 'trace' && object.trace_kind === 'text' && object.body?.trim()) {
      pushGroup(textNotesByParent, object.parent_id || sessionGroupKey(object), object)
    }

    if (object.object_type === 'trace' && object.trace_kind === 'reasoning' && object.body?.trim()) {
      pushGroup(reasoningByParent, object.parent_id || sessionGroupKey(object), object)
    }

    if (object.object_type === 'trace' && object.trace_kind === 'error') {
      pushGroup(errorsByParent, object.parent_id || sessionGroupKey(object), object)
    }

    if (object.object_type === 'run' && object.status === 'error') {
      pushGroup(errorsByParent, errorRunGroupKey(object), object)
    }
  }

  if (decisions.length) {
    blocks.push(confirmationsBlock(decisions))
  }

  for (const run of [...agentRuns, ...subagentRuns]) {
    blocks.push(runBlock(run))

    if (run.run_kind === 'subagent') {
      const resultBlock = subagentResultBlock(run)

      if (resultBlock) {
        blocks.push(resultBlock)
      }
    }
  }

  for (const [parentId, toolRuns] of sortedEntries(toolRunsByParent)) {
    blocks.push(toolActivityBlock(parentId, toolRuns))
  }

  const assistantNoteParentIds = new Set([
    ...agentRuns.filter(run => run.result_view?.output_text?.trim()).map(run => run.id),
    ...textNotesByParent.keys()
  ])

  for (const parentId of [...assistantNoteParentIds].sort()) {
    blocks.push(...assistantSemanticBlocks(parentId, textNotesByParent.get(parentId) ?? [], agentRuns))
  }

  for (const [parentId, traces] of sortedEntries(reasoningByParent)) {
    const assistantText = assistantTextForParent(parentId, textNotesByParent.get(parentId) ?? [], agentRuns)

    if (assistantText && traces.some(trace => textLooksDuplicate(trace.body || '', assistantText))) {
      continue
    }

    blocks.push(reasoningTopicBlock(parentId, traces))
  }

  for (const [parentId, errorObjects] of sortedEntries(errorsByParent)) {
    blocks.push(errorNoteBlock(parentId, errorObjects))
  }

  return blocks.sort(sortBlocks)
}

function confirmationsBlock(decisions: WorkspaceDecisionObject[]): WorkspaceListBlock {
  const sorted = [...decisions].sort(sortObjectsStable)
  const pending = sorted.filter(decision => decision.state === 'requested').length
  const completed = sorted.filter(decision => decision.state === 'resolved').length

  return {
    actions: [{ id: 'open-debug:confirmations', kind: 'open_debug', label: 'Open debug' }],
    created_at: minTime(sorted),
    debug_refs: mergeDebugRefs(sorted),
    id: `block:list:confirmations:${stableHash(sorted.map(decision => decision.id).join('|'))}`,
    items: sorted.map(decision => ({
      actions: decision.state === 'requested' ? decisionActions(decision) : [],
      content: decisionContent(decision),
      debug_refs: decision.debug_refs,
      id: `block:item:confirmation:${decision.view_model.request_id}`,
      source_object_id: decision.id,
      source_ref: decision.view_model.request_id,
      status: decision.state === 'requested' ? 'pending' : decision.state === 'cancelled' ? 'cancelled' : 'completed'
    })),
    list_kind: 'confirmations',
    priority: pending ? 'high' : 'medium',
    source_object_ids: sorted.map(decision => decision.id),
    source_event_ids: mergeSourceEventIds(sorted),
    status: pending ? 'waiting' : 'done',
    summary: { completed, pending, total: sorted.length },
    title: pending ? 'Confirmations waiting' : 'Confirmations',
    type: 'LIST',
    updated_at: maxTime(sorted)
  }
}

function planBlock(parentId: string, sources: WorkspaceObject[], items: string[]): WorkspaceListBlock {
  const uniqueItems = uniqueTexts(items).slice(0, 8)

  return {
    actions: [{ id: `open-debug:${parentId}:plan`, kind: 'open_debug', label: 'Open debug' }],
    created_at: minTime(sources),
    debug_refs: mergeDebugRefs(sources),
    id: `block:list:plan:${parentId}`,
    items: uniqueItems.map((content, index) => ({
      content,
      debug_refs: mergeDebugRefs(sources),
      id: `block:item:plan:${parentId}:${index}`,
      source_object_id: sources[0]?.id ?? parentId,
      status: 'pending'
    })),
    list_kind: 'plan',
    priority: 'medium',
    source_object_ids: sources.map(source => source.id),
    source_event_ids: mergeSourceEventIds(sources),
    status: 'active',
    summary: { completed: 0, pending: uniqueItems.length, total: uniqueItems.length },
    title: 'Plan',
    type: 'LIST',
    updated_at: maxTime(sources)
  }
}

function runBlock(run: WorkspaceRunObject): WorkspaceRunBlock {
  const title = run.run_kind === 'subagent' ? subagentRunTitle(run) : 'Assistant turn'

  return {
    actions: [{ id: `open-debug:${run.id}`, kind: 'open_debug', label: 'Open debug', metadata: { object_id: run.id } }],
    created_at: run.created_at,
    debug_refs: run.debug_refs,
    error: errorFromRun(run),
    id: `block:run:${run.run_kind}:${run.id}`,
    outputs: runOutputs(run),
    progress: {
      duration_s: run.progress?.duration_s,
      ended_at: run.completed_at,
      heartbeat_at: run.progress?.heartbeat_at,
      phase: run.progress?.phase,
      started_at: run.started_at
    },
    run_kind: run.run_kind === 'subagent' ? 'subagent' : 'agent_turn',
    runtime: {
      model: run.runtime?.model,
      provider: run.runtime?.provider,
      run_id: run.runtime?.run_id,
      session_id: run.runtime?.session_id,
      turn_id: run.runtime?.turn_id
    },
    source_object_ids: [run.id],
    source_event_ids: run.source_event_ids,
    status: run.status,
    title,
    type: 'RUN',
    updated_at: run.updated_at
  }
}

function toolActivityBlock(parentId: string, toolRuns: WorkspaceRunObject[]): WorkspaceRunBlock {
  const sorted = latestToolRuns(toolRuns)
  const active = sorted.some(run => run.status === 'active' || run.status === 'waiting')
  const failed = sorted.some(run => run.status === 'error')
  const totalDuration = sorted.reduce((sum, run) => sum + (run.progress?.duration_s ?? 0), 0)

  return {
    actions: [
      { id: `open-debug:${parentId}:tools`, kind: 'open_debug', label: 'Open debug', metadata: { parent_id: parentId } }
    ],
    child_run_ids: sorted.map(run => run.id),
    created_at: minTime(sorted),
    debug_refs: mergeDebugRefs(sorted),
    error: failed ? { message: firstErrorMessage(sorted) || 'Tool activity failed' } : undefined,
    id: `block:run:tool_activity:${parentId}`,
    outputs: sorted.map(run => ({
      debug_refs: run.debug_refs,
      label: run.title || 'Tool',
      value_preview: shortPreview(
        run.result_view?.summary || run.result_view?.preview || run.progress?.phase || run.status
      )
    })),
    progress: {
      duration_s: totalDuration || undefined,
      heartbeat_at: maxUpdatedAt(sorted),
      phase: active ? 'running' : failed ? 'error' : 'complete',
      started_at: minStartedAt(sorted),
      ended_at: active ? undefined : maxCompletedAt(sorted)
    },
    run_kind: 'tool_activity',
    runtime: { session_id: sorted[0]?.runtime?.session_id, turn_id: sorted[0]?.runtime?.turn_id },
    source_object_ids: sorted.map(run => run.id),
    source_event_ids: mergeSourceEventIds(sorted),
    status: failed ? 'error' : active ? 'active' : 'done',
    title: sorted.length === 1 ? 'Tool activity' : `Tool activity (${sorted.length})`,
    type: 'RUN',
    updated_at: maxTime(sorted)
  }
}

function assistantSemanticBlocks(
  parentId: string,
  traces: WorkspaceTraceObject[],
  runs: WorkspaceRunObject[]
): WorkspaceBlock[] {
  const relatedRun = runs.find(run => run.id === parentId)
  const body = assistantTextForParent(parentId, traces, runs)

  if (!body) {
    return []
  }

  const sources: WorkspaceObject[] = relatedRun ? [...traces, relatedRun] : traces
  const blocks: WorkspaceBlock[] = []
  const planItems = extractPlanItems(body)
  const findingItems = extractFindingItems(body)
  const artifactText = extractArtifactPreview(body)
  const summaryText = extractSummaryText(body)

  if (planItems.length) {
    blocks.push(planBlock(parentId, sources, planItems))
  }

  if (findingItems.length || looksLikeTopic(body)) {
    const bullets = (findingItems.length ? findingItems : [summarizeText(body)]).slice(0, 6)

    blocks.push({
      actions: [{ id: `open-debug:${parentId}:findings`, kind: 'open_debug', label: 'Open debug' }],
      bullets: bullets.map((text, index) => ({
        debug_refs: mergeDebugRefs(sources),
        id: `block:topic:findings:${parentId}:${index}`,
        source_event_ids: mergeSourceEventIds(sources),
        text
      })),
      created_at: minTime(sources),
      debug_refs: mergeDebugRefs(sources),
      id: `block:topic:findings:${parentId}`,
      source_object_ids: sources.map(source => source.id),
      source_event_ids: mergeSourceEventIds(sources),
      state: relatedRun?.status === 'active' || relatedRun?.status === 'waiting' ? 'exploring' : 'decided',
      thesis: bullets[0] ?? summarizeText(body),
      title: 'Findings',
      topic_kind: 'findings',
      type: 'TOPIC',
      updated_at: maxTime(sources)
    })
  }

  if (artifactText) {
    blocks.push({
      actions: [{ id: `open-debug:${parentId}:artifact`, kind: 'open_debug', label: 'Open debug' }],
      body: artifactText,
      created_at: minTime(sources),
      debug_refs: mergeDebugRefs(sources),
      id: `block:note:artifact:${parentId}`,
      note_kind: 'artifact',
      severity: 'info',
      source_object_ids: sources.map(source => source.id),
      source_event_ids: mergeSourceEventIds(sources),
      status: relatedRun?.status === 'error' ? 'error' : 'done',
      title: 'Artifact preview',
      type: 'NOTE',
      updated_at: maxTime(sources)
    })
  }

  if (summaryText) {
    blocks.push({
      actions: [{ id: `open-debug:${parentId}:summary`, kind: 'open_debug', label: 'Open debug' }],
      body: summaryText,
      created_at: minTime(sources),
      debug_refs: mergeDebugRefs(sources),
      id: `block:note:summary:${parentId}`,
      note_kind: 'summary',
      severity: 'info',
      source_object_ids: [...traces.map(trace => trace.id), ...(relatedRun ? [relatedRun.id] : [])],
      source_event_ids: mergeSourceEventIds(sources),
      status: relatedRun?.status === 'error' ? 'error' : 'done',
      title: 'Summary',
      type: 'NOTE',
      updated_at: relatedRun ? maxTime([...sources, relatedRun]) : maxTime(sources)
    })
  }

  return blocks
}

function subagentResultBlock(run: WorkspaceRunObject): WorkspaceNoteBlock | WorkspaceTopicBlock | null {
  const resultText = subagentResultText(run)

  if (!resultText || !isLongText(resultText)) {
    return null
  }

  const body = resultText.trim()
  const base: Pick<
    WorkspaceBlockBase,
    | 'actions'
    | 'created_at'
    | 'debug_refs'
    | 'source_object_ids'
    | 'source_event_ids'
    | 'status'
    | 'title'
    | 'updated_at'
  > = {
    actions: [
      {
        id: `open-debug:${run.id}:subagent-result`,
        kind: 'open_debug' as const,
        label: 'Open debug',
        metadata: { object_id: run.id }
      }
    ],
    created_at: run.created_at,
    debug_refs: run.debug_refs,
    source_object_ids: [run.id],
    source_event_ids: [...run.source_event_ids].sort(),
    status: run.status === 'error' ? 'error' : 'done',
    title: looksLikeTopic(body) ? 'Findings' : 'Summary',
    updated_at: run.updated_at
  }

  if (looksLikeTopic(body)) {
    const findingItems = extractFindingItems(body)
    const thesis = extractSummaryText(body) || summarizeText(body)
    const bullets = (findingItems.length ? findingItems : [thesis]).slice(0, 6)

    return {
      ...base,
      bullets: bullets.map((text, index) => ({
        debug_refs: run.debug_refs,
        id: `block:topic:findings:${run.id}:${index}`,
        source_event_ids: run.source_event_ids,
        text
      })),
      id: `block:topic:findings:${run.id}`,
      state: run.status === 'active' || run.status === 'waiting' ? 'exploring' : 'decided',
      thesis,
      topic_kind: 'findings',
      type: 'TOPIC'
    }
  }

  return {
    ...base,
    body,
    id: `block:note:summary:${run.id}`,
    note_kind: 'summary',
    severity: run.status === 'error' ? 'error' : 'info',
    type: 'NOTE'
  }
}

function reasoningTopicBlock(parentId: string, traces: WorkspaceTraceObject[]): WorkspaceTopicBlock {
  const sorted = [...traces].sort(sortObjectsStable)
  const selected = [...sorted].sort((left, right) => {
    const lengthDelta = (right.body?.length ?? 0) - (left.body?.length ?? 0)

    return lengthDelta || objectTime(right) - objectTime(left) || right.id.localeCompare(left.id)
  })[0]
  const text = summarizeText(selected?.body || 'Reasoning available')

  return {
    actions: [{ id: `open-debug:${parentId}:reasoning`, kind: 'open_debug', label: 'Open debug' }],
    bullets: [
      {
        debug_refs: selected?.debug_refs,
        id: `block:topic:reasoning:${parentId}:summary`,
        source_event_ids: selected?.source_event_ids,
        text
      }
    ],
    created_at: minTime(sorted),
    debug_refs: mergeDebugRefs(sorted),
    id: `block:topic:reasoning:${parentId}`,
    source_object_ids: sorted.map(trace => trace.id),
    source_event_ids: mergeSourceEventIds(sorted),
    state: sorted.some(trace => trace.status === 'active') ? 'exploring' : 'stale',
    thesis: text,
    title: 'Reasoning',
    topic_kind: 'reasoning',
    type: 'TOPIC',
    updated_at: maxTime(sorted)
  }
}

function errorNoteBlock(parentId: string, objects: WorkspaceObject[]): WorkspaceNoteBlock {
  const sorted = [...objects].sort(sortObjectsStable)
  const body = uniqueTexts(sorted.map(errorBody)).join('\n\n') || 'Hermes reported an error'

  return {
    actions: [{ id: `open-debug:${parentId}:error`, kind: 'open_debug', label: 'Open debug' }],
    body,
    created_at: minTime(sorted),
    debug_refs: mergeDebugRefs(sorted),
    id: `block:note:error:${parentId}`,
    note_kind: 'error',
    priority: 'high',
    severity: 'error',
    source_object_ids: sorted.map(object => object.id),
    source_event_ids: mergeSourceEventIds(sorted),
    status: 'error',
    title: 'Error',
    type: 'NOTE',
    updated_at: maxTime(sorted)
  }
}

function decisionActions(decision: WorkspaceDecisionObject): WorkspaceBlockAction[] {
  const metadata = {
    decision_id: decision.id,
    decision_kind: decision.decision_kind,
    request_id: decision.view_model.request_id,
    session_id: sessionIdFromObjectId(decision.id)
  }

  return [
    { id: `approve:${decision.view_model.request_id}`, kind: 'approve', label: 'Approve', metadata },
    { id: `reject:${decision.view_model.request_id}`, kind: 'reject', label: 'Reject', metadata },
    ...(decision.decision_kind === 'clarification'
      ? [{ id: `answer:${decision.view_model.request_id}`, kind: 'answer' as const, label: 'Answer', metadata }]
      : [])
  ]
}

function decisionContent(decision: WorkspaceDecisionObject): string {
  return (
    decision.view_model.question ||
    decision.view_model.description ||
    decision.view_model.command ||
    decision.view_model.prompt ||
    decision.view_model.env_var ||
    decision.title
  )
}

function runOutputs(run: WorkspaceRunObject): WorkspaceRunValue[] | undefined {
  const values = [
    shortRunValue('Summary', run.result_view?.summary),
    shortRunValue('Preview', run.result_view?.preview)
  ].filter(Boolean) as WorkspaceRunValue[]

  return values.length ? values : undefined
}

function shortRunValue(label: string, value: string | undefined): WorkspaceRunValue | undefined {
  if (!value?.trim() || isLongText(value)) {
    return undefined
  }

  return { label, value_preview: shortPreview(value) }
}

function errorFromRun(run: WorkspaceRunObject): WorkspaceRunBlock['error'] {
  const error = run.result_view?.error

  if (typeof error === 'string' && error.trim()) {
    return { message: error }
  }

  return error ? { message: 'Run failed' } : undefined
}

function firstErrorMessage(runs: WorkspaceRunObject[]): string {
  for (const run of runs) {
    const error = errorFromRun(run)?.message

    if (error) {
      return error
    }
  }

  return ''
}

function errorBody(object: WorkspaceObject): string {
  if (object.object_type === 'trace') {
    return object.body || object.title
  }

  if (object.object_type === 'run') {
    return errorFromRun(object)?.message || object.result_view?.summary || object.title
  }

  return object.title
}

function summarizeText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()

  return compact.length > 240 ? `${compact.slice(0, 237).trimEnd()}...` : compact
}

function assistantTextForParent(parentId: string, traces: WorkspaceTraceObject[], runs: WorkspaceRunObject[]): string {
  const relatedRun = runs.find(run => run.id === parentId)
  const bodies = uniqueTexts([...traces.map(trace => trace.body || ''), relatedRun?.result_view?.output_text || ''])

  return bodies.join('\n\n').trim()
}

function extractPlanItems(value: string): string[] {
  return extractBulletsAfterHeadings(value, ['plan', 'steps', 'todo', 'next', '下一步', '计划', '步骤', '待办'], false)
}

function extractFindingItems(value: string): string[] {
  return extractBulletsAfterHeadings(
    value,
    ['finding', 'findings', 'decision', 'summary', 'conclusion', '发现', '结论', '建议', '总结'],
    true
  )
}

function extractBulletsAfterHeadings(
  value: string,
  headingKeywords: string[],
  fallbackToAllBullets: boolean
): string[] {
  const lines = value.split(/\r?\n/)
  const items: string[] = []
  let collecting = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    const headingText = line
      .replace(/^#{1,6}\s*/, '')
      .replace(/\*\*/g, '')
      .toLowerCase()
    const isHeading = /^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*$/.test(line)

    if (isHeading) {
      collecting = headingKeywords.some(keyword => headingText.includes(keyword.toLowerCase()))
      continue
    }

    const bullet = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line)

    if (collecting && bullet?.[1]) {
      items.push(cleanListItem(bullet[1]))
    }
  }

  if (items.length) {
    return items
  }

  return fallbackToAllBullets
    ? lines
        .map(line => /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line.trim())?.[1])
        .filter((item): item is string => Boolean(item))
        .map(cleanListItem)
        .slice(0, 5)
    : []
}

function cleanListItem(value: string): string {
  return value
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

function extractArtifactPreview(value: string): string {
  const fenced = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/.exec(value)

  if (fenced?.[1]?.trim()) {
    return summarizeText(fenced[1].trim())
  }

  const tableLines = value
    .split(/\r?\n/)
    .filter(line => /^\s*\|.+\|\s*$/.test(line))
    .slice(0, 8)

  return tableLines.length >= 2 ? tableLines.join('\n') : ''
}

function extractSummaryText(value: string): string {
  const withoutFenced = value.replace(/```[\s\S]*?```/g, '').trim()
  const paragraphs = withoutFenced
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
  const proseParagraph = paragraphs.find(paragraph => {
    const lines = paragraph
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)

    return (
      lines.length > 0 &&
      lines.every(line => !/^#{1,6}\s/.test(line)) &&
      lines.every(line => !/^(?:[-*+]|\d+[.)])\s+/.test(line)) &&
      lines.every(line => !/^\|.+\|$/.test(line))
    )
  })

  if (proseParagraph) {
    return summarizeText(proseParagraph)
  }

  const firstTextLine = withoutFenced
    .split(/\r?\n/)
    .map(line =>
      line
        .trim()
        .replace(/^#{1,6}\s*/, '')
        .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
        .trim()
    )
    .find(Boolean)

  return firstTextLine ? summarizeText(firstTextLine) : ''
}

function textLooksDuplicate(left: string, right: string): boolean {
  const a = normalizeComparableText(left)
  const b = normalizeComparableText(right)

  if (!a || !b) {
    return false
  }

  if (Math.min(a.length, b.length) > 80 && (a.includes(b) || b.includes(a))) {
    return true
  }

  const short = a.length <= b.length ? a : b
  const long = short === a ? b : a

  if (short.length < 40) {
    return false
  }

  let overlap = 0

  for (const char of new Set(short)) {
    if (long.includes(char)) {
      overlap += 1
    }
  }

  return overlap / new Set(short).size > 0.82
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[\s`*_#[\](){}.,;:!?'"，。；：！？、|~-]+/g, '')
    .trim()
}

function shortPreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()

  return compact.length > 120 ? `${compact.slice(0, 117).trimEnd()}...` : compact
}

function isLongText(value: string): boolean {
  const trimmed = value.trim()

  return trimmed.length > 280 || /\n\s*\n/.test(trimmed) || /^#{1,6}\s/m.test(trimmed) || /^[-*]\s.+/m.test(trimmed)
}

function subagentRunTitle(run: WorkspaceRunObject): string {
  const candidate = (run.title || '').trim()

  if (!candidate || candidate === 'Subagent') {
    return 'Subagent'
  }

  return isLongText(candidate) || candidate.length > 96 ? 'Subagent' : shortPreview(candidate)
}

function subagentResultText(run: WorkspaceRunObject): string {
  return uniqueTexts([
    run.result_view?.summary || '',
    run.result_view?.output_text || '',
    resultToText(run.result_view?.result)
  ]).join('\n\n')
}

function resultToText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (!value) {
    return ''
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function looksLikeTopic(value: string): boolean {
  return /^#{1,6}\s/m.test(value) || /^[-*]\s.+/m.test(value)
}

function uniqueTexts(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const trimmed = value.trim()
    const key = trimmed.replace(/\s+/g, ' ')

    if (!trimmed || seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(trimmed)
  }

  return result
}

function objectArray(objects: Record<string, WorkspaceObject> | WorkspaceObject[]): WorkspaceObject[] {
  return Array.isArray(objects) ? [...objects] : Object.values(objects)
}

function isAgentTurnRun(object: WorkspaceObject): object is WorkspaceRunObject {
  return object.object_type === 'run' && object.run_kind === 'agent_turn'
}

function isSubagentRun(object: WorkspaceObject): object is WorkspaceRunObject {
  return object.object_type === 'run' && object.run_kind === 'subagent'
}

function isToolRun(object: WorkspaceObject): object is WorkspaceRunObject {
  return object.object_type === 'run' && object.run_kind === 'tool_call'
}

function isDecisionObject(object: WorkspaceObject): object is WorkspaceDecisionObject {
  return object.object_type === 'decision'
}

function toolActivityGroupKey(run: WorkspaceRunObject): string {
  return run.parent_id || run.runtime?.turn_id || sessionGroupKey(run)
}

function latestToolRuns(runs: WorkspaceRunObject[]): WorkspaceRunObject[] {
  const latestByKey = new Map<string, WorkspaceRunObject>()

  for (const run of [...runs].sort(sortRunsByUpdateStable)) {
    latestByKey.set(toolRunSemanticKey(run), run)
  }

  return [...latestByKey.values()].sort(sortObjectsStable)
}

function toolRunSemanticKey(run: WorkspaceRunObject): string {
  return run.runtime?.tool_call_id || run.title || run.id
}

function sortRunsByUpdateStable(left: WorkspaceRunObject, right: WorkspaceRunObject): number {
  return (
    Date.parse(left.updated_at) - Date.parse(right.updated_at) ||
    Date.parse(left.created_at) - Date.parse(right.created_at) ||
    left.id.localeCompare(right.id)
  )
}

function errorRunGroupKey(run: WorkspaceRunObject): string {
  return run.run_kind === 'agent_turn' ? run.id : run.parent_id || run.id
}

function sessionGroupKey(object: WorkspaceObject): string {
  if (object.object_type === 'run' && object.runtime?.session_id) {
    return `session:${object.runtime.session_id}`
  }

  const match = /^session:[^:]+/.exec(object.id)

  return match?.[0] || object.id
}

function sessionIdFromObjectId(id: string): string | undefined {
  const match = /^session:([^:]+)/.exec(id)

  return match?.[1]
}

function groupBy<T>(values: T[], keyOf: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()

  for (const value of values) {
    pushGroup(groups, keyOf(value), value)
  }

  return groups
}

function pushGroup<T>(groups: Map<string, T[]>, key: string, value: T): void {
  groups.set(key, [...(groups.get(key) ?? []), value])
}

function sortedEntries<T>(groups: Map<string, T[]>): [string, T[]][] {
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
}

function sortObjectsStable(left: WorkspaceObject, right: WorkspaceObject): number {
  return objectTime(left) - objectTime(right) || left.id.localeCompare(right.id)
}

function objectTime(object: WorkspaceObject): number {
  return Date.parse(object.created_at || object.updated_at) || 0
}

function sortBlocks(left: WorkspaceBlock, right: WorkspaceBlock): number {
  return (
    blockRank(left) - blockRank(right) ||
    Date.parse(right.updated_at) - Date.parse(left.updated_at) ||
    left.id.localeCompare(right.id)
  )
}

function blockRank(block: WorkspaceBlock): number {
  if (block.type === 'LIST' && block.list_kind === 'confirmations' && block.status === 'waiting') {
    return 0
  }

  if (block.status === 'error') {
    return 1
  }

  if (block.type === 'RUN' && (block.status === 'active' || block.status === 'waiting')) {
    return block.run_kind === 'agent_turn' ? 2 : 3
  }

  if (block.type === 'LIST' && block.list_kind === 'plan') {
    return 4
  }

  if (block.type === 'RUN') {
    return block.run_kind === 'agent_turn' ? 5 : 6
  }

  if (block.type === 'TOPIC') {
    return block.topic_kind === 'findings' ? 7 : 8
  }

  if (block.type === 'NOTE') {
    return block.note_kind === 'summary' ? 9 : 10
  }

  return 11
}

function minTime(objects: WorkspaceObject[]): string {
  return [...objects].sort(sortObjectsStable)[0]?.created_at ?? '1970-01-01T00:00:00.000Z'
}

function maxTime(objects: WorkspaceObject[]): string {
  return (
    [...objects].sort(
      (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at) || right.id.localeCompare(left.id)
    )[0]?.updated_at ?? minTime(objects)
  )
}

function maxUpdatedAt(objects: WorkspaceObject[]): string | undefined {
  return maxTime(objects)
}

function minStartedAt(runs: WorkspaceRunObject[]): string | undefined {
  return runs
    .map(run => run.started_at)
    .filter(Boolean)
    .sort()[0]
}

function maxCompletedAt(runs: WorkspaceRunObject[]): string | undefined {
  return runs
    .map(run => run.completed_at)
    .filter(Boolean)
    .sort()
    .at(-1)
}

function mergeSourceEventIds(objects: WorkspaceObject[]): string[] {
  return [...new Set(objects.flatMap(object => object.source_event_ids))].sort()
}

function mergeDebugRefs(objects: WorkspaceObject[]): WorkspaceDebugRef[] {
  const seen = new Set<string>()
  const refs: WorkspaceDebugRef[] = []

  for (const ref of objects.flatMap(object => object.debug_refs)) {
    const key = `${ref.kind}:${ref.id || ''}:${ref.label || ''}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    refs.push(ref)
  }

  return refs
}

function stableHash(value: string): string {
  let hash = 5381

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index)
  }

  return (hash >>> 0).toString(36)
}
