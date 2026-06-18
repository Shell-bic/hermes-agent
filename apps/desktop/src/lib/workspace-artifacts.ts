import { chatMessageText, type ChatMessage } from './chat-messages'
import type {
  WorkspaceBlock,
  WorkspaceBlockAction,
  WorkspaceListBlock,
  WorkspaceNoteBlock,
  WorkspaceRunBlock,
  WorkspaceTopicBlock
} from './workspace-blocks'

export type CanvasArtifactKind =
  | 'artifact'
  | 'confirmation'
  | 'context'
  | 'error'
  | 'findings'
  | 'output'
  | 'plan'
  | 'run'
  | 'task'

export type CanvasArtifactRenderer = 'checklist' | 'code' | 'markdown' | 'outline' | 'table' | 'task' | 'timeline'

export type CanvasArtifactStatus = 'active' | 'done' | 'error' | 'pending' | 'waiting'

export interface CanvasArtifactDebugRefs {
  blockIds: string[]
  objectIds: string[]
}

export interface CanvasRunTimelineEntry {
  id: string
  label: string
  status?: string
  summary?: string
}

export interface CanvasArtifact {
  actions: WorkspaceBlockAction[]
  content?: string
  debugRefs: CanvasArtifactDebugRefs
  id: string
  kind: CanvasArtifactKind
  renderer: CanvasArtifactRenderer
  sourceBlockId?: string
  sourceEventIds: string[]
  status: CanvasArtifactStatus
  summary?: string
  title: string
  updatedAt: string
}

export interface CanvasRunArtifact extends CanvasArtifact {
  content?: never
  entries: CanvasRunTimelineEntry[]
  kind: 'run'
  renderer: 'timeline'
}

type AnyCanvasArtifact = CanvasArtifact | CanvasRunArtifact
type AssistantMarkdownSection = {
  content: string
  title: string
}

const MAX_ASSISTANT_SECTION_ARTIFACTS = 6
const MIN_ASSISTANT_SECTION_COUNT = 3
const MIN_ASSISTANT_SECTION_CHARS = 80
const MIN_ASSISTANT_SPLIT_CHARS = 700

export function projectWorkspaceToCanvasArtifacts(
  blocks: readonly WorkspaceBlock[],
  messages: readonly ChatMessage[] = []
): AnyCanvasArtifact[] {
  const assistantArtifacts = latestAssistantArtifacts(messages)

  return [...assistantArtifacts, latestTaskArtifact(messages, assistantArtifacts.length > 0), ...blocks.flatMap(blockToArtifacts)]
    .filter((artifact): artifact is AnyCanvasArtifact => Boolean(artifact))
    .sort(sortCanvasArtifacts)
}

function latestAssistantArtifacts(messages: readonly ChatMessage[]): CanvasArtifact[] {
  const message = [...messages]
    .reverse()
    .find(candidate => candidate.role === 'assistant' && chatMessageText(candidate).trim())

  if (!message) {
    return []
  }

  const content = chatMessageText(message).trim()
  const renderer = assistantRenderer(content)
  const updatedAt = message.timestamp ? new Date(message.timestamp).toISOString() : '1970-01-01T00:00:00.000Z'
  const baseArtifact: CanvasArtifact = {
    actions: [],
    content,
    debugRefs: { blockIds: [], objectIds: [] },
    id: `artifact:assistant:${message.id}`,
    kind: 'artifact',
    renderer,
    sourceEventIds: [],
    status: message.pending ? 'active' : 'done',
    summary: compactText(content, 220),
    title: 'Answer',
    updatedAt
  }

  return [baseArtifact]
}

function latestTaskArtifact(messages: readonly ChatMessage[], hasAssistantArtifact = false): CanvasArtifact | undefined {
  const message = [...messages].reverse().find(candidate => candidate.role === 'user' && chatMessageText(candidate).trim())

  if (!message) {
    return undefined
  }

  const updatedAt = message.timestamp ? new Date(message.timestamp).toISOString() : '1970-01-01T00:00:00.000Z'
  const content = chatMessageText(message).trim()

  return {
    actions: [],
    content,
    debugRefs: { blockIds: [], objectIds: [] },
    id: `artifact:task:${message.id}`,
    kind: hasAssistantArtifact ? 'context' : 'task',
    renderer: 'task',
    sourceEventIds: [],
    status: message.pending ? 'active' : 'done',
    summary: compactText(content, 180),
    title: hasAssistantArtifact ? 'User context' : 'Current task',
    updatedAt
  }
}

function blockToArtifacts(block: WorkspaceBlock): AnyCanvasArtifact[] {
  if (block.type === 'LIST') {
    return [listBlockToArtifact(block)]
  }

  if (block.type === 'RUN') {
    if (shouldSuppressRunArtifact(block)) {
      return []
    }

    return [runBlockToArtifact(block)]
  }

  if (block.type === 'TOPIC') {
    return topicBlockToArtifacts(block)
  }

  return [noteBlockToArtifact(block)]
}

function shouldSuppressRunArtifact(block: WorkspaceRunBlock): boolean {
  const hasOutputs = Boolean(block.outputs?.length)
  const hasError = Boolean(block.error?.message)
  const isActive = block.status === 'active' || block.status === 'waiting'

  return block.run_kind === 'agent_turn' && !isActive && !hasOutputs && !hasError
}

function listBlockToArtifact(block: WorkspaceListBlock): CanvasArtifact {
  const pendingItems = block.items.filter(item => item.status === 'pending')
  const items = block.list_kind === 'confirmations' && pendingItems.length ? pendingItems : block.items
  const kind = block.list_kind === 'confirmations' ? 'confirmation' : 'plan'

  return {
    ...baseArtifact(block),
    actions:
      block.list_kind === 'confirmations'
        ? pendingItems.length
          ? mergeActions(items.flatMap(item => item.actions ?? []))
          : []
        : mergeActions(block.actions, items.flatMap(item => item.actions ?? [])),
    content: items.map(item => checklistLine(item.status === 'completed', item.content)).join('\n'),
    kind,
    renderer: 'checklist',
    status: block.list_kind === 'confirmations' && pendingItems.length ? 'pending' : normalizeStatus(block.status),
    summary: `${block.summary.pending} pending, ${block.summary.completed} completed`,
    title: block.title
  }
}

function runBlockToArtifact(block: WorkspaceRunBlock): CanvasRunArtifact {
  const entries: CanvasRunTimelineEntry[] = [
    {
      id: block.id,
      label: block.title,
      status: block.status,
      summary: compactText(block.progress?.phase || block.error?.message || runKindLabel(block.run_kind), 140)
    },
    ...(block.outputs ?? []).map(output => ({
      id: `${block.id}:output:${output.label}`,
      label: output.label,
      status: block.status,
      summary: compactText(output.value_preview, 140)
    }))
  ]

  return {
    ...baseArtifact(block),
    entries,
    kind: 'run',
    renderer: 'timeline',
    status: normalizeStatus(block.status),
    summary: compactText(block.error?.message || block.progress?.phase || runKindLabel(block.run_kind), 180),
    title: block.title
  }
}

function topicBlockToArtifacts(block: WorkspaceTopicBlock): CanvasArtifact[] {
  if (block.topic_kind !== 'findings' && block.topic_kind !== 'subagent_result') {
    return []
  }

  return [
    {
      ...baseArtifact(block),
      content: block.bullets.map(bullet => `- ${bullet.text}`).join('\n'),
      kind: 'findings',
      renderer: 'outline',
      status: block.state === 'exploring' ? 'active' : 'done',
      summary: block.thesis ? compactText(block.thesis, 180) : `${block.bullets.length} findings`,
      title: block.title
    }
  ]
}

function noteBlockToArtifact(block: WorkspaceNoteBlock): CanvasArtifact {
  if (block.note_kind === 'error') {
    return {
      ...baseArtifact(block),
      content: block.body,
      kind: 'error',
      renderer: 'markdown',
      status: 'error',
      summary: compactText(block.body, 180),
      title: block.title || 'Error'
    }
  }

  const isArtifact = block.note_kind === 'artifact'
  const renderer = isArtifact ? artifactRenderer(block.body) : 'markdown'

  return {
    ...baseArtifact(block),
    content: block.body,
    kind: isArtifact ? 'artifact' : 'output',
    renderer,
    status: normalizeStatus(block.status),
    summary: compactText(block.body, 180),
    title: isArtifact ? block.title || 'Artifact preview' : block.title || 'Summary'
  }
}

function baseArtifact(block: WorkspaceBlock): Pick<
  CanvasArtifact,
  'actions' | 'debugRefs' | 'id' | 'sourceBlockId' | 'sourceEventIds' | 'updatedAt'
> {
  return {
    actions: block.actions,
    debugRefs: {
      blockIds: [block.id],
      objectIds: block.source_object_ids
    },
    id: `artifact:${block.id}`,
    sourceBlockId: block.id,
    sourceEventIds: block.source_event_ids,
    updatedAt: block.updated_at
  }
}

export function splitAssistantMarkdownSections(content: string): AssistantMarkdownSection[] {
  if (content.length < MIN_ASSISTANT_SPLIT_CHARS) {
    return []
  }

  const lines = content.split(/\r?\n/)
  const headings: { lineIndex: number; title: string }[] = []
  let inFence = false

  lines.forEach((line, lineIndex) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return
    }

    if (inFence) {
      return
    }

    const headingMatch = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line)

    if (!headingMatch) {
      return
    }

    headings.push({
      lineIndex,
      title: headingMatch[2].trim()
    })
  })

  if (headings.length < MIN_ASSISTANT_SECTION_COUNT) {
    return []
  }

  const sections = headings
    .map((heading, index) => {
      const nextHeading = headings[index + 1]
      const sectionLines = lines.slice(heading.lineIndex, nextHeading?.lineIndex)
      const sectionContent = sectionLines.join('\n').trim()

      return {
        content: sectionContent,
        title: heading.title
      }
    })
    .filter(section => section.content.length >= MIN_ASSISTANT_SECTION_CHARS)

  if (sections.length < MIN_ASSISTANT_SECTION_COUNT) {
    return []
  }

  return sections.slice(0, MAX_ASSISTANT_SECTION_ARTIFACTS)
}

function artifactRenderer(body: string): CanvasArtifactRenderer {
  const trimmed = body.trim()

  if (isWholeCodeFence(trimmed) || /^ {4}\S/m.test(body)) {
    return 'code'
  }

  if (isStandaloneMarkdownTable(body)) {
    return 'table'
  }

  return 'markdown'
}

function assistantRenderer(body: string): CanvasArtifactRenderer {
  const trimmed = body.trim()

  if (isWholeCodeFence(trimmed) || /^ {4}\S/m.test(body)) {
    return 'code'
  }

  if (isStandaloneMarkdownTable(body)) {
    return 'table'
  }

  return 'markdown'
}

function hasCodeFence(trimmed: string): boolean {
  return isWholeCodeFence(trimmed) || /(?:^|\n)```[\s\S]*?\n```(?:\n|$)/.test(trimmed)
}

function isWholeCodeFence(trimmed: string): boolean {
  return /^```[\s\S]*```$/.test(trimmed)
}

function hasMarkdownTable(body: string): boolean {
  const tableLines = body.split(/\r?\n/).filter(line => /^\s*\|.+\|\s*$/.test(line))

  return tableLines.length >= 2 && tableLines.some(line => /\|\s*:?-{3,}:?\s*\|/.test(line))
}

function isStandaloneMarkdownTable(body: string): boolean {
  const meaningfulLines = body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  if (meaningfulLines.length < 2) {
    return false
  }

  return meaningfulLines.every(line => /^\|.+\|$/.test(line)) && hasMarkdownTable(body)
}

function normalizeStatus(status: WorkspaceBlock['status']): CanvasArtifactStatus {
  if (status === 'active') {
    return 'active'
  }

  if (status === 'waiting') {
    return 'waiting'
  }

  if (status === 'error') {
    return 'error'
  }

  return 'done'
}

function sortCanvasArtifacts(left: AnyCanvasArtifact, right: AnyCanvasArtifact): number {
  return (
    artifactRank(left) - artifactRank(right) ||
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    left.id.localeCompare(right.id)
  )
}

function artifactRank(artifact: AnyCanvasArtifact): number {
  if (artifact.kind === 'confirmation' && artifact.status === 'pending') {
    return 0
  }

  if (artifact.kind === 'run' && (artifact.status === 'active' || artifact.status === 'waiting')) {
    return 1
  }

  if (artifact.id.startsWith('artifact:assistant:')) {
    return 2
  }

  if (artifact.kind === 'task') {
    return 3
  }

  if (artifact.kind === 'plan') {
    return 4
  }

  if (artifact.kind === 'run') {
    return 5
  }

  if (artifact.kind === 'findings') {
    return 6
  }

  if (artifact.kind === 'output') {
    return 7
  }

  if (artifact.kind === 'artifact') {
    return 8
  }

  if (artifact.kind === 'context') {
    return 9
  }

  return 10
}

function checklistLine(done: boolean, content: string): string {
  return `- [${done ? 'x' : ' '}] ${content}`
}

function mergeActions(...groups: WorkspaceBlockAction[][]): WorkspaceBlockAction[] {
  const seen = new Set<string>()
  const actions: WorkspaceBlockAction[] = []

  for (const action of groups.flat()) {
    if (seen.has(action.id)) {
      continue
    }

    seen.add(action.id)
    actions.push(action)
  }

  return actions
}

function runKindLabel(kind: WorkspaceRunBlock['run_kind']): string {
  if (kind === 'tool_activity') {
    return 'Tool activity'
  }

  if (kind === 'subagent') {
    return 'Subagent run'
  }

  return 'Assistant turn'
}

function compactText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()

  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3).trimEnd()}...` : compact
}
