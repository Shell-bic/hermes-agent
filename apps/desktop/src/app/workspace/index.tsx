import type { ComponentProps, ReactNode } from 'react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { type ChatMessage, chatMessageText } from '@/lib/chat-messages'
import { cn } from '@/lib/utils'
import { projectWorkspaceToCanvasArtifacts } from '@/lib/workspace-artifacts'
import type { WorkspaceBlock } from '@/lib/workspace-blocks'
import type { WorkspaceObject } from '@/lib/workspace-events'

import {
  ArtifactCanvas as HorizontalArtifactCanvas,
  type WorkspaceArtifact as HorizontalWorkspaceArtifact,
  type WorkspaceArtifactAction as HorizontalWorkspaceArtifactAction
} from './artifact-canvas'

export { ArtifactCanvas } from './artifact-canvas'
export type { ArtifactCanvasProps, WorkspaceArtifact, WorkspaceArtifactAction } from './artifact-canvas'

export type WorkspacePanelTab = 'detail' | 'events' | 'transcript'
type BlockKind = 'LIST' | 'NOTE' | 'RUN' | 'TOPIC'
type AnyRecord = Record<string, unknown>
type WorkspaceBlockRecord = WorkspaceBlock & AnyRecord
type WorkspaceCanvasArtifact = ReturnType<typeof projectWorkspaceToCanvasArtifacts>[number]
type WorkspaceArtifactKind = WorkspaceCanvasArtifact['kind']
type WorkspaceArtifactRecord = {
  block?: WorkspaceBlockRecord
  canvasArtifact: WorkspaceCanvasArtifact
  id: string
  kind: WorkspaceArtifactKind
  sourceBlockId?: string
  status: string
  summary: string
  title: string
  updatedAt: number
}

const CARD_PREVIEW_CHARS = 360
const DETAIL_PREVIEW_CHARS = 1600
const LIST_PREVIEW_CHARS = 150
const ROW_PREVIEW_CHARS = 96

interface RawWorkspaceEventLike {
  id?: string
  payload?: unknown
  receivedAt?: number
  sessionId?: string
  timestamp?: string
  type: string
}

export interface WorkspaceViewProps extends Omit<ComponentProps<'div'>, 'onSelect'> {
  blocks: readonly WorkspaceBlock[]
  composer?: ReactNode
  messages?: readonly ChatMessage[]
  objects: Record<string, WorkspaceObject> | readonly WorkspaceObject[]
  onBlockAction?: (action: WorkspaceBlock['actions'][number], block: WorkspaceBlock) => void
  onSelectBlock?: (blockId: string) => void
  preview?: ReactNode
  primaryViewToggle?: ReactNode
  rawEvents?: readonly RawWorkspaceEventLike[]
  selectedBlockId?: null | string
  statusbar?: ReactNode
}

export interface WorkspaceConversationRendererProps extends Omit<ComponentProps<'div'>, 'onSelect'> {
  blocks: readonly WorkspaceBlock[]
  messages?: readonly ChatMessage[]
  objects: Record<string, WorkspaceObject> | readonly WorkspaceObject[]
  onBlockAction?: (action: WorkspaceBlock['actions'][number], block: WorkspaceBlock) => void
  onPanelTabChange?: (tab: WorkspacePanelTab) => void
  onSelectBlock?: (blockId: string) => void
  panelTab?: WorkspacePanelTab
  preview?: ReactNode
  rawEvents?: readonly RawWorkspaceEventLike[]
  selectedBlockId?: null | string
}

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === 'object' ? (value as AnyRecord) : undefined
}

function objectArray(objects: WorkspaceViewProps['objects']): WorkspaceObject[] {
  return Array.isArray(objects) ? [...objects] : Object.values(objects)
}

function blockString(block: WorkspaceBlockRecord, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = block[key]

    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }

  return fallback
}

function blockNumber(block: WorkspaceBlockRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = block[key]

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }

  return undefined
}

function blockArray(block: WorkspaceBlockRecord, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = block[key]

    if (Array.isArray(value)) {
      return value
    }
  }

  return []
}

function blockId(block: WorkspaceBlockRecord | undefined): string {
  if (!block) {
    return ''
  }

  return blockString(block, ['id', 'block_id'])
}

function blockKind(block: WorkspaceBlockRecord): BlockKind {
  const value = blockString(block, ['kind', 'block_kind', 'type'], 'NOTE').toUpperCase()

  if (value === 'LIST' || value === 'NOTE' || value === 'RUN' || value === 'TOPIC') {
    return value
  }

  return 'NOTE'
}

function blockStatus(block: WorkspaceBlockRecord): string {
  return blockString(block, ['status', 'state'], 'new')
}

function blockSubtype(block: WorkspaceBlockRecord, keys: string[]): string {
  return blockString(block, keys).toLowerCase()
}

function blockTime(block: WorkspaceBlockRecord): number {
  return Date.parse(blockString(block, ['updated_at', 'updatedAt', 'created_at', 'createdAt'])) || 0
}

function blockTitle(block: WorkspaceBlockRecord): string {
  const kind = blockKind(block)

  return compactText(blockString(block, ['title', 'label', 'name'], kind[0] + kind.slice(1).toLowerCase()), 72)
}

function blockSummary(block: WorkspaceBlockRecord): string {
  const kind = blockKind(block)

  if (kind === 'LIST') {
    const items = blockArray(block, ['items'])
    const summary = asRecord(block.summary)

    if (summary) {
      const total = typeof summary.total === 'number' ? summary.total : items.length
      const pending = typeof summary.pending === 'number' ? summary.pending : undefined
      const completed = typeof summary.completed === 'number' ? summary.completed : undefined

      return [
        `${total} item${total === 1 ? '' : 's'}`,
        pending !== undefined && `${pending} pending`,
        completed !== undefined && `${completed} completed`
      ]
        .filter(Boolean)
        .join(' · ')
    }

    return previewText(
      blockString(block, ['summary', 'body', 'description'], items.length ? `${items.length} items` : ''),
      {
        maxChars: LIST_PREVIEW_CHARS,
        singleLine: true,
        stripMarkdown: true
      }
    )
  }

  if (kind === 'RUN') {
    const outputs = toPreviewItems(block.outputs ?? block.output ?? block.result)
    const firstOutput = asRecord(outputs[0])

    return previewText(
      blockString(block, ['summary', 'output_summary', 'phase']) ||
        String(firstOutput?.value_preview ?? '') ||
        previewValue(block.outputs ?? block.output ?? block.result, { maxChars: LIST_PREVIEW_CHARS }) ||
        blockString(block, ['run_kind']),
      { maxChars: LIST_PREVIEW_CHARS, singleLine: true, stripMarkdown: true }
    )
  }

  if (kind === 'TOPIC') {
    const bullets = blockArray(block, ['bullets'])

    return previewText(
      blockString(block, ['thesis', 'summary', 'body'], bullets.length ? `${bullets.length} bullets` : ''),
      {
        maxChars: LIST_PREVIEW_CHARS,
        singleLine: true,
        stripMarkdown: true
      }
    )
  }

  return previewText(blockString(block, ['body', 'summary', 'description']), {
    maxChars: LIST_PREVIEW_CHARS,
    singleLine: true,
    stripMarkdown: true
  })
}

function blockSourceObjectIds(block: WorkspaceBlockRecord): string[] {
  const refs = [
    ...blockArray(block, ['object_ids', 'objectIds', 'source_object_ids', 'sourceObjectIds']),
    ...blockArray(block, ['object_refs', 'objectRefs']),
    ...blockArray(block, ['child_run_ids', 'childRunIds'])
  ]

  return refs
    .map(ref => {
      if (typeof ref === 'string') {
        return ref
      }

      const record = asRecord(ref)

      return record ? String(record.id ?? record.object_id ?? '') : ''
    })
    .filter(Boolean)
}

function blockSourceEventIds(block: WorkspaceBlockRecord): string[] {
  return blockArray(block, ['source_event_ids', 'sourceEventIds'])
    .map(value => (typeof value === 'string' ? value : ''))
    .filter(Boolean)
}

function blockIcon(kind: BlockKind): string {
  if (kind === 'LIST') {
    return 'list-unordered'
  }

  if (kind === 'RUN') {
    return 'debug-start'
  }

  if (kind === 'TOPIC') {
    return 'symbol-class'
  }

  return 'note'
}

function statusClassName(status: string): string {
  if (status === 'active' || status === 'running') {
    return 'bg-(--ui-blue)'
  }

  if (status === 'waiting' || status === 'blocked' || status === 'requested' || status === 'pending') {
    return 'bg-amber-500'
  }

  if (status === 'done' || status === 'complete' || status === 'completed') {
    return 'bg-(--ui-green)'
  }

  if (status === 'error' || status === 'failed') {
    return 'bg-destructive'
  }

  return 'bg-(--ui-text-quaternary)'
}

function isPendingConfirmationBlock(block: WorkspaceBlockRecord): boolean {
  const summary = asRecord(block.summary)

  const text = `${blockKind(block)} ${blockStatus(block)} ${blockString(block, [
    'list_kind',
    'decision_kind',
    'state',
    'title',
    'summary'
  ])}`.toLowerCase()

  return (
    (text.includes('confirmation') || text.includes('approval') || text.includes('requested')) &&
    (blockStatus(block) === 'waiting' ||
      blockStatus(block) === 'requested' ||
      blockArray(block, ['items']).some(item => itemStatus(item) === 'pending') ||
      (typeof summary?.pending === 'number' && summary.pending > 0))
  )
}

function isActiveRunBlock(block: WorkspaceBlockRecord): boolean {
  return blockKind(block) === 'RUN' && ['active', 'running', 'waiting'].includes(blockStatus(block))
}

function isPlanBlock(block: WorkspaceBlockRecord): boolean {
  return blockKind(block) === 'LIST' && blockSubtype(block, ['list_kind', 'listKind']).includes('plan')
}

function isFindingsBlock(block: WorkspaceBlockRecord): boolean {
  return blockKind(block) === 'TOPIC' && blockSubtype(block, ['topic_kind', 'topicKind']).includes('findings')
}

function isSummaryBlock(block: WorkspaceBlockRecord): boolean {
  return blockKind(block) === 'NOTE' && blockSubtype(block, ['note_kind', 'noteKind']).includes('summary')
}

function canvasPriority(block: WorkspaceBlockRecord): number {
  if (isPendingConfirmationBlock(block)) {
    return 0
  }

  if (isActiveRunBlock(block)) {
    return 1
  }

  if (isPlanBlock(block)) {
    return 2
  }

  if (isFindingsBlock(block)) {
    return 3
  }

  if (isSummaryBlock(block)) {
    return 4
  }

  return 5
}

function sortCanvasBlocks(blocks: readonly WorkspaceBlockRecord[]): WorkspaceBlockRecord[] {
  return blocks
    .map((block, index) => ({ block, index }))
    .sort((left, right) => {
      const priority = canvasPriority(left.block) - canvasPriority(right.block)

      if (priority !== 0) {
        return priority
      }

      const time = blockTime(right.block) - blockTime(left.block)

      return time || left.index - right.index
    })
    .map(row => row.block)
}

function defaultSelectedBlockId(blocks: readonly WorkspaceBlock[]): string | null {
  const records = blocks as readonly WorkspaceBlockRecord[]

  if (!records.length) {
    return null
  }

  const pending = records.find(isPendingConfirmationBlock)
  const active = records.find(block => ['active', 'running', 'waiting'].includes(blockStatus(block)))

  return blockId(pending ?? active ?? records[0]) || null
}

function artifactIcon(kind: WorkspaceArtifactKind): string {
  if (kind === 'confirmation') {
    return 'shield'
  }

  if (kind === 'plan') {
    return 'list-unordered'
  }

  if (kind === 'run') {
    return 'debug-start'
  }

  if (kind === 'findings') {
    return 'symbol-class'
  }

  if (kind === 'error') {
    return 'error'
  }

  if (kind === 'task' || kind === 'context') {
    return 'checklist'
  }

  return 'note'
}

function artifactPriority(artifact: WorkspaceArtifactRecord): number {
  if (artifact.kind === 'confirmation' && artifact.status === 'pending') {
    return 0
  }

  if (artifact.kind === 'run' && (artifact.status === 'active' || artifact.status === 'waiting')) {
    return 1
  }

  if (artifact.id.startsWith('artifact:assistant:')) {
    return 2
  }

  if (artifact.kind === 'output') {
    return 3
  }

  if (artifact.kind === 'artifact') {
    return 4
  }

  if (artifact.kind === 'findings') {
    return 5
  }

  if (artifact.kind === 'plan') {
    return 6
  }

  if (artifact.kind === 'run') {
    return 7
  }

  if (artifact.kind === 'error') {
    return 8
  }

  if (artifact.kind === 'context') {
    return 9
  }

  if (artifact.kind === 'task') {
    return 10
  }

  return artifact.block ? canvasPriority(artifact.block) + 1 : 11
}

function projectBlocksToArtifacts(
  blocks: readonly WorkspaceBlockRecord[],
  messages: readonly ChatMessage[]
): WorkspaceArtifactRecord[] {
  const blocksById = new Map(blocks.map(block => [blockId(block), block]))
  const projectedSourceBlocks = blocks.map(normalizeBlockForArtifactProjection)
  const records: WorkspaceArtifactRecord[] = []

  for (const canvasArtifact of projectWorkspaceToCanvasArtifacts(projectedSourceBlocks, messages)) {
    const sourceBlockId = canvasArtifact.sourceBlockId
    const block = sourceBlockId ? blocksById.get(sourceBlockId) : undefined

    if (sourceBlockId && !block) {
      continue
    }

    records.push({
      block,
      canvasArtifact,
      id: canvasArtifact.id,
      kind: canvasArtifact.kind,
      sourceBlockId,
      status: canvasArtifact.status,
      summary: canvasArtifact.summary ?? (block ? blockSummary(block) : ''),
      title: compactText(canvasArtifact.title, 72),
      updatedAt: Date.parse(canvasArtifact.updatedAt) || (block ? blockTime(block) : 0)
    })
  }

  if (!records.some(isAnswerArtifact)) {
    const assistantArtifact = latestAssistantAnswerArtifact(messages)

    if (assistantArtifact) {
      records.push({
        canvasArtifact: assistantArtifact,
        id: assistantArtifact.id,
        kind: assistantArtifact.kind,
        status: assistantArtifact.status,
        summary: assistantArtifact.summary ?? '',
        title: compactText(assistantArtifact.title, 72),
        updatedAt: Date.parse(assistantArtifact.updatedAt) || 0
      })
    }
  }

  const artifactSourceIds = new Set(records.map(artifact => artifact.sourceBlockId))

  for (const block of blocks) {
    const sourceBlockId = blockId(block)

    if (!sourceBlockId || artifactSourceIds.has(sourceBlockId)) {
      continue
    }

    const normalizedBlock = normalizeBlockForArtifactProjection(block)

    if (normalizedBlock.type === 'RUN' && shouldSuppressFallbackRunArtifact(normalizedBlock)) {
      continue
    }

    const canvasArtifact = fallbackCanvasArtifact(block)

    records.push({
      block,
      canvasArtifact,
      id: canvasArtifact.id,
      kind: canvasArtifact.kind,
      sourceBlockId,
      status: canvasArtifact.status,
      summary: canvasArtifact.summary ?? blockSummary(block),
      title: compactText(canvasArtifact.title, 72),
      updatedAt: Date.parse(canvasArtifact.updatedAt) || blockTime(block)
    })
  }

  return records.sort((left, right) => {
    const priority = artifactPriority(left) - artifactPriority(right)

    if (priority !== 0) {
      return priority
    }

    return right.updatedAt - left.updatedAt
  })
}

function isAnswerArtifact(artifact: WorkspaceArtifactRecord): boolean {
  return artifact.kind === 'output' || artifact.kind === 'artifact' || artifact.kind === 'findings'
}

function latestAssistantAnswerArtifact(messages: readonly ChatMessage[]): WorkspaceCanvasArtifact | undefined {
  const message = [...messages]
    .reverse()
    .find(candidate => candidate.role === 'assistant' && !candidate.hidden && chatMessageText(candidate).trim())

  if (!message) {
    return undefined
  }

  const content = chatMessageText(message).trim()
  const timestamp =
    typeof message.timestamp === 'number'
      ? message.timestamp
      : typeof message.timestamp === 'string'
        ? Date.parse(message.timestamp)
        : 0
  const updatedAt =
    Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : '1970-01-01T00:00:00.000Z'

  return {
    actions: [],
    content,
    debugRefs: { blockIds: [], objectIds: [] },
    id: `artifact:assistant:${message.id}`,
    kind: 'output',
    renderer: answerRenderer(content),
    sourceEventIds: [],
    status: message.pending ? 'active' : 'done',
    summary: compactText(content, 180),
    title: 'Assistant answer',
    updatedAt
  } as WorkspaceCanvasArtifact
}

function answerRenderer(content: string): WorkspaceCanvasArtifact['renderer'] {
  const trimmed = content.trim()

  if (/^```[\s\S]*```$/.test(trimmed) || /^ {4}\S/m.test(content)) {
    return 'code'
  }

  const tableLines = content.split(/\r?\n/).filter(line => /^\s*\|.+\|\s*$/.test(line))

  if (tableLines.length >= 2 && tableLines.some(line => /\|\s*:?-{3,}:?\s*\|/.test(line))) {
    return 'table'
  }

  return 'markdown'
}

function shouldSuppressFallbackRunArtifact(block: Extract<WorkspaceBlock, { type: 'RUN' }>): boolean {
  const hasOutputs = Boolean(block.outputs?.length)
  const hasError = Boolean(block.error?.message)
  const isActive = block.status === 'active' || block.status === 'waiting'

  return block.run_kind === 'agent_turn' && !isActive && !hasOutputs && !hasError
}

function normalizeBlockForArtifactProjection(block: WorkspaceBlockRecord): WorkspaceBlock {
  const kind = blockKind(block)
  const sourceBlockId = blockId(block)
  const base = {
    ...block,
    actions: Array.isArray(block.actions) ? block.actions : [],
    created_at: blockString(block, ['created_at', 'createdAt'], blockString(block, ['updated_at', 'updatedAt'])),
    debug_refs: Array.isArray(block.debug_refs) ? block.debug_refs : [],
    id: sourceBlockId,
    source_event_ids: blockSourceEventIds(block),
    source_object_ids: blockSourceObjectIds(block),
    status: blockStatus(block),
    title: blockTitle(block),
    type: kind,
    updated_at: blockString(block, ['updated_at', 'updatedAt', 'created_at', 'createdAt'])
  }

  if (kind === 'LIST') {
    return {
      ...base,
      items: blockArray(block, ['items']).map((item, index) => {
        const record = asRecord(item)

        return {
          actions: record && Array.isArray(record.actions) ? (record.actions as WorkspaceBlock['actions']) : [],
          content: formatItem(item),
          debug_refs: record && Array.isArray(record.debug_refs) ? record.debug_refs : [],
          id: record ? String(record.id ?? `${sourceBlockId}:item:${index}`) : `${sourceBlockId}:item:${index}`,
          source_object_id: record ? String(record.source_object_id ?? record.sourceObjectId ?? '') : '',
          source_ref: record ? String(record.source_ref ?? record.sourceRef ?? '') : undefined,
          status: itemStatus(item) || 'pending'
        }
      }),
      list_kind: blockSubtype(block, ['list_kind', 'listKind']).includes('confirmation') ? 'confirmations' : 'plan',
      summary: asRecord(block.summary) ?? { completed: 0, pending: 0, total: blockArray(block, ['items']).length },
      type: 'LIST'
    } as WorkspaceBlock
  }

  if (kind === 'RUN') {
    const outputs = toPreviewItems(block.outputs ?? block.output ?? block.result).map((output, index) => {
      const record = asRecord(output)

      return {
        debug_refs: record && Array.isArray(record.debug_refs) ? record.debug_refs : [],
        label: record ? recordLabel(record, `Output ${index + 1}`) : `Output ${index + 1}`,
        value_preview: record ? recordText(record) || previewValue(record) : previewValue(output)
      }
    })

    return {
      ...base,
      outputs,
      run_kind: blockSubtype(block, ['run_kind', 'runKind']) || 'agent_turn',
      type: 'RUN'
    } as WorkspaceBlock
  }

  if (kind === 'TOPIC') {
    return {
      ...base,
      bullets: blockArray(block, ['bullets']).map((bullet, index) => {
        const record = asRecord(bullet)

        return {
          debug_refs: record && Array.isArray(record.debug_refs) ? record.debug_refs : [],
          id: record ? String(record.id ?? `${sourceBlockId}:bullet:${index}`) : `${sourceBlockId}:bullet:${index}`,
          source_event_ids: record && Array.isArray(record.source_event_ids) ? record.source_event_ids : [],
          text: record ? String(record.text ?? record.content ?? record.title ?? '') : formatItem(bullet)
        }
      }),
      state: blockString(block, ['state'], 'decided'),
      thesis: blockString(block, ['thesis', 'summary', 'body']),
      topic_kind: blockSubtype(block, ['topic_kind', 'topicKind']) || 'findings',
      type: 'TOPIC'
    } as WorkspaceBlock
  }

  return {
    ...base,
    body: blockString(block, ['body', 'text', 'summary', 'description'], blockSummary(block)),
    note_kind: blockSubtype(block, ['note_kind', 'noteKind']) || (blockStatus(block) === 'error' ? 'error' : 'summary'),
    type: 'NOTE'
  } as WorkspaceBlock
}

function fallbackCanvasArtifact(block: WorkspaceBlockRecord): WorkspaceCanvasArtifact {
  const kind = blockKind(block)
  const sourceBlockId = blockId(block)
  const status = blockStatus(block)
  const summary = blockSummary(block)
  const updatedAt =
    blockString(block, ['updated_at', 'updatedAt', 'created_at', 'createdAt']) || new Date(0).toISOString()

  const canvasKind =
    kind === 'LIST'
      ? isPendingConfirmationBlock(block)
        ? 'confirmation'
        : 'plan'
      : kind === 'RUN'
        ? 'run'
        : kind === 'TOPIC'
          ? 'findings'
          : status === 'error'
            ? 'error'
            : 'output'

  const renderer =
    kind === 'LIST' ? 'checklist' : kind === 'RUN' ? 'timeline' : kind === 'TOPIC' ? 'outline' : 'markdown'

  return {
    actions: block.actions ?? [],
    content: blockString(block, ['body', 'summary', 'thesis']) || summary,
    debugRefs: {
      blockIds: [sourceBlockId],
      objectIds: blockSourceObjectIds(block)
    },
    id: `artifact:${sourceBlockId}`,
    kind: canvasKind,
    renderer,
    sourceBlockId,
    sourceEventIds: blockSourceEventIds(block),
    status: status === 'active' || status === 'waiting' || status === 'error' || status === 'pending' ? status : 'done',
    summary,
    title: blockTitle(block),
    updatedAt
  } as WorkspaceCanvasArtifact
}

function defaultSelectedArtifactId(artifacts: readonly WorkspaceArtifactRecord[]): string | null {
  return artifacts[0]?.id ?? null
}

function jsonPreview(value: unknown): string {
  if (value === undefined) {
    return ''
  }

  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatItem(item: unknown): string {
  if (typeof item === 'string') {
    return item
  }

  const record = asRecord(item)

  if (record) {
    return String(record.content ?? record.text ?? record.label ?? record.title ?? record.summary ?? jsonPreview(item))
  }

  return String(item)
}

function itemStatus(item: unknown): string {
  const record = asRecord(item)

  return record && typeof record.status === 'string' ? record.status : ''
}

function itemActions(item: unknown): WorkspaceBlock['actions'] {
  const record = asRecord(item)

  return record && Array.isArray(record.actions) ? (record.actions as WorkspaceBlock['actions']) : []
}

function itemId(item: unknown, index: number): string {
  const record = asRecord(item)

  return record
    ? String(record.id ?? record.source_ref ?? `${index}:${formatItem(item)}`)
    : `${index}:${formatItem(item)}`
}

function stripMarkdownSyntax(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, match => match.replace(/```[a-zA-Z0-9_-]*\n?|```/g, ''))
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }

  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`
}

function previewText(
  value: string,
  options: { maxChars?: number; singleLine?: boolean; stripMarkdown?: boolean } = {}
): string {
  const normalized = (options.stripMarkdown ? stripMarkdownSyntax(value) : value).replace(/\r\n?/g, '\n').trim()
  const compacted = options.singleLine ? normalized.replace(/\s+/g, ' ') : normalized.replace(/\n{3,}/g, '\n\n')

  return truncateText(compacted, options.maxChars ?? CARD_PREVIEW_CHARS)
}

function compactText(value: string, maxChars = ROW_PREVIEW_CHARS): string {
  return previewText(value, { maxChars, singleLine: true, stripMarkdown: true })
}

function toPreviewItems(value: unknown): unknown[] {
  if (value === undefined || value === null || value === '') {
    return []
  }

  return Array.isArray(value) ? value : [value]
}

function recordText(record: AnyRecord): string {
  for (const key of ['value_preview', 'preview', 'summary', 'body', 'text', 'content', 'output', 'message', 'result']) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }

  return ''
}

function recordLabel(record: AnyRecord, fallback = 'Output'): string {
  for (const key of ['label', 'title', 'name', 'tool_name', 'kind', 'type']) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      return compactText(value, 44)
    }
  }

  return fallback
}

function previewValue(value: unknown, options: { maxChars?: number; maxItems?: number } = {}): string {
  const maxChars = options.maxChars ?? CARD_PREVIEW_CHARS

  if (value === undefined || value === null || value === '') {
    return ''
  }

  if (typeof value === 'string') {
    return previewText(value, { maxChars, stripMarkdown: true })
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (Array.isArray(value)) {
    const maxItems = options.maxItems ?? 3

    const items = value.slice(0, maxItems).map((item, index) => {
      const record = asRecord(item)

      if (!record) {
        return previewValue(item, { maxChars: Math.min(maxChars, ROW_PREVIEW_CHARS) })
      }

      const label = recordLabel(record, `Output ${index + 1}`)

      const body = previewText(recordText(record), {
        maxChars: Math.min(maxChars, ROW_PREVIEW_CHARS),
        singleLine: true,
        stripMarkdown: true
      })

      const state =
        typeof record.status === 'string' ? record.status : typeof record.state === 'string' ? record.state : ''

      return [label, state, body].filter(Boolean).join(' · ')
    })

    const suffix = value.length > maxItems ? ` · +${value.length - maxItems} more` : ''

    return truncateText(`${items.filter(Boolean).join(' · ')}${suffix}`, maxChars)
  }

  const record = asRecord(value)

  if (record) {
    const directText = recordText(record)

    if (directText) {
      return previewText(directText, { maxChars, singleLine: true, stripMarkdown: true })
    }

    return compactText(Object.keys(record).join(', '), maxChars)
  }

  return compactText(String(value), maxChars)
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim()
  const match = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/.exec(trimmed)

  return match ? match[1] : value
}

function tableRowsFromContent(content: string): {
  columns: { key: string; label?: string }[]
  rows: AnyRecord[]
} {
  const lines = content.split(/\r?\n/).filter(line => /^\s*\|.+\|\s*$/.test(line))

  if (lines.length < 2) {
    return { columns: [], rows: [] }
  }

  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map(cell => cell.trim())

  const headers = cells(lines[0])
  const columns = headers.map((label, index) => ({ key: `col${index}`, label }))

  const rows = lines.slice(2).map(line =>
    cells(line).reduce<AnyRecord>((row, value, index) => {
      row[`col${index}`] = value

      return row
    }, {})
  )

  return { columns, rows }
}

function formatTime(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatCompactValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return ''
  }

  return previewValue(value, { maxChars: ROW_PREVIEW_CHARS, maxItems: 2 })
}

export function WorkspaceView({
  blocks,
  className,
  composer,
  messages,
  objects,
  onBlockAction,
  onSelectBlock,
  preview,
  primaryViewToggle,
  rawEvents = [],
  selectedBlockId,
  statusbar,
  ...props
}: WorkspaceViewProps) {
  return (
    <div
      className={cn(
        'relative flex h-full min-w-0 flex-col overflow-hidden bg-(--ui-chat-surface-background) text-(--ui-text-primary)',
        className
      )}
      {...props}
    >
      <WorkspaceHeader primaryViewToggle={primaryViewToggle} />
      <WorkspaceConversationRenderer
        blocks={blocks}
        className="flex-1"
        messages={messages}
        objects={objects}
        onBlockAction={onBlockAction}
        onSelectBlock={onSelectBlock}
        preview={preview}
        rawEvents={rawEvents}
        selectedBlockId={selectedBlockId}
      />
      {composer && <div className="shrink-0 border-t border-(--ui-stroke-tertiary)">{composer}</div>}
      {statusbar}
    </div>
  )
}

export function WorkspaceConversationRenderer({
  blocks,
  className,
  messages = [],
  objects,
  onBlockAction,
  onPanelTabChange,
  onSelectBlock,
  panelTab,
  preview,
  rawEvents = [],
  selectedBlockId,
  ...props
}: WorkspaceConversationRendererProps) {
  const [localPanelTab, setLocalPanelTab] = useState<WorkspacePanelTab>('detail')
  const [localSelectedBlockId, setLocalSelectedBlockId] = useState<string | null>(null)
  const [localSelectedArtifactId, setLocalSelectedArtifactId] = useState<string | null>(null)
  const messageBlocks = useMemo(
    () => (blocks.length ? [] : projectChatMessagesToWorkspaceBlocks(messages)),
    [blocks.length, messages]
  )
  const effectiveBlocks = blocks.length ? blocks : messageBlocks
  const projectedBlocks = useMemo(() => sortCanvasBlocks(effectiveBlocks as readonly WorkspaceBlockRecord[]), [effectiveBlocks])
  const artifacts = useMemo(
    () => projectBlocksToArtifacts(projectedBlocks, blocks.length ? messages : []),
    [blocks.length, projectedBlocks, messages]
  )
  const rawObjects = useMemo(() => objectArray(objects), [objects])
  const selectedArtifactId = localSelectedArtifactId ?? defaultSelectedArtifactId(artifacts)
  const selectedArtifact =
    (selectedBlockId && artifacts.find(artifact => artifact.sourceBlockId === selectedBlockId)) ||
    artifacts.find(artifact => artifact.id === selectedArtifactId) ||
    null
  const selectedId =
    selectedBlockId ??
    localSelectedBlockId ??
    selectedArtifact?.sourceBlockId ??
    (selectedArtifact ? null : defaultSelectedBlockId(projectedBlocks))
  const selectedBlock = selectedId ? projectedBlocks.find(block => blockId(block) === selectedId) : undefined
  const detailArtifact =
    (selectedId && artifacts.find(artifact => artifact.sourceBlockId === selectedId)) || selectedArtifact || undefined
  const activePanelTab = panelTab ?? localPanelTab

  const selectBlock = (nextBlockId: string) => {
    setLocalSelectedBlockId(nextBlockId)
    setLocalSelectedArtifactId(artifacts.find(artifact => artifact.sourceBlockId === nextBlockId)?.id ?? null)
    onSelectBlock?.(nextBlockId)
  }

  const selectArtifact = (artifact: WorkspaceArtifactRecord) => {
    setLocalSelectedArtifactId(artifact.id)
    setLocalSelectedBlockId(artifact.sourceBlockId ?? null)

    if (artifact.sourceBlockId) {
      onSelectBlock?.(artifact.sourceBlockId)
    }
  }

  const selectPanelTab = (nextTab: WorkspacePanelTab) => {
    setLocalPanelTab(nextTab)
    onPanelTabChange?.(nextTab)
  }

  return (
    <div
      className={cn(
        'grid min-h-0 grid-cols-1 grid-rows-[minmax(8rem,12rem)_minmax(0,1fr)_minmax(10rem,14rem)] overflow-hidden bg-(--ui-chat-surface-background) text-(--ui-text-primary) lg:grid-cols-[minmax(13rem,18rem)_minmax(0,1fr)_minmax(16rem,24rem)] lg:grid-rows-1',
        className
      )}
      {...props}
    >
      <BlockList blocks={projectedBlocks} onSelect={selectBlock} selectedBlockId={selectedId} />
      <WorkspaceArtifactCanvas
        artifacts={artifacts}
        onAction={onBlockAction}
        onSelect={selectArtifact}
        preview={preview}
        selectedArtifactId={detailArtifact?.id ?? null}
      />
      <WorkspaceRightPanel
        artifact={detailArtifact}
        block={selectedBlock}
        messages={messages}
        objects={rawObjects}
        onAction={onBlockAction}
        onTabChange={selectPanelTab}
        rawEvents={rawEvents}
        tab={activePanelTab}
      />
    </div>
  )
}

function projectChatMessagesToWorkspaceBlocks(messages: readonly ChatMessage[]): WorkspaceBlock[] {
  const assistant = [...messages]
    .reverse()
    .find(message => message.role === 'assistant' && chatMessageText(message).trim())

  if (!assistant) {
    const user = [...messages].reverse().find(message => message.role === 'user' && chatMessageText(message).trim())

    return user ? [chatTaskBlock(user)] : []
  }

  const text = chatMessageText(assistant).trim()
  const updatedAt = messageTime(assistant)
  const sections = splitMessageSections(text)
  const summaryIsArtifact = !sections.length && sectionRenderer(text) === 'artifact'
  const blocks: WorkspaceBlock[] = []

  blocks.push({
    actions: [],
    body: sections.length ? firstMeaningfulParagraph(text) : text,
    created_at: updatedAt,
    debug_refs: [],
    id: `block:chat:summary:${assistant.id}`,
    note_kind: summaryIsArtifact ? 'artifact' : 'summary',
    source_event_ids: [],
    source_object_ids: [],
    status: assistant.pending ? 'active' : 'done',
    title: summaryIsArtifact ? 'Answer' : 'Answer summary',
    type: 'NOTE',
    updated_at: updatedAt
  })

  const sectionBlocks = sections.slice(0, 8).map((section, index): WorkspaceBlock => {
    const renderer = sectionRenderer(section.content)

    if (renderer === 'artifact') {
      return {
        actions: [],
        body: section.content,
        created_at: updatedAt,
        debug_refs: [],
        id: `block:chat:artifact:${assistant.id}:${index + 1}:${slugForBlockId(section.title)}`,
        note_kind: 'artifact',
        source_event_ids: [],
        source_object_ids: [],
        status: assistant.pending ? 'active' : 'done',
        title: section.title,
        type: 'NOTE',
        updated_at: updatedAt
      }
    }

    return {
      actions: [],
      bullets: sectionBullets(section.content),
      created_at: updatedAt,
      debug_refs: [],
      id: `block:chat:topic:${assistant.id}:${index + 1}:${slugForBlockId(section.title)}`,
      source_event_ids: [],
      source_object_ids: [],
      state: assistant.pending ? 'exploring' : 'decided',
      thesis: compactText(stripMarkdown(section.content), 180),
      title: section.title,
      topic_kind: 'findings',
      type: 'TOPIC',
      updated_at: updatedAt
    }
  })

  blocks.push(...sectionBlocks)

  return blocks
}

function chatTaskBlock(message: ChatMessage): WorkspaceBlock {
  const text = chatMessageText(message).trim()
  const updatedAt = messageTime(message)

  return {
    actions: [],
    body: text,
    created_at: updatedAt,
    debug_refs: [],
    id: `block:chat:task:${message.id}`,
    note_kind: 'summary',
    source_event_ids: [],
    source_object_ids: [],
    status: message.pending ? 'active' : 'done',
    title: 'Current task',
    type: 'NOTE',
    updated_at: updatedAt
  }
}

function messageTime(message: ChatMessage): string {
  return message.timestamp ? new Date(message.timestamp).toISOString() : '1970-01-01T00:00:00.000Z'
}

function splitMessageSections(content: string): { content: string; title: string }[] {
  if (content.length < 500) {
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

    const match = /^(#{2,4})\s+(.+?)\s*#*\s*$/.exec(line)

    if (match) {
      headings.push({ lineIndex, title: match[2].trim() })
    }
  })

  return headings
    .map((heading, index) => {
      const nextHeading = headings[index + 1]
      const sectionContent = lines.slice(heading.lineIndex, nextHeading?.lineIndex).join('\n').trim()

      return {
        content: sectionContent,
        title: heading.title
      }
    })
    .filter(section => section.content.length >= 80)
}

function firstMeaningfulParagraph(content: string): string {
  const paragraph =
    content
      .split(/\n{2,}/)
      .map(part => stripMarkdown(part).trim())
      .find(Boolean) || stripMarkdown(content)

  return compactText(paragraph, 420)
}

function sectionRenderer(content: string): 'artifact' | 'topic' {
  return hasMarkdownTable(content) || hasCodeFence(content) ? 'artifact' : 'topic'
}

function sectionBullets(content: string): WorkspaceBlock extends infer _ ? { id: string; text: string }[] : never {
  const stripped = stripMarkdown(content)
  const explicit = content
    .split(/\r?\n/)
    .map(line => /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(line)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))

  const candidates = explicit.length
    ? explicit
    : stripped
        .split(/[。.!?]\s+|\n+/)
        .map(line => line.trim())
        .filter(Boolean)

  return candidates.slice(0, 6).map((text, index) => ({
    id: `bullet:${index + 1}`,
    text: compactText(text, 180)
  })) as never
}

function hasCodeFence(content: string): boolean {
  return /(?:^|\n)```[\s\S]*?\n```(?:\n|$)/.test(content.trim())
}

function hasMarkdownTable(content: string): boolean {
  const tableLines = content.split(/\r?\n/).filter(line => /^\s*\|.+\|\s*$/.test(line))

  return tableLines.length >= 2 && tableLines.some(line => /\|\s*:?-{3,}:?\s*\|/.test(line))
}

function stripMarkdown(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function slugForBlockId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  return slug || 'section'
}

function WorkspaceHeader({ primaryViewToggle }: { primaryViewToggle?: ReactNode }) {
  return (
    <header className="flex h-(--titlebar-height) shrink-0 items-center justify-between border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) px-3">
      <div className="flex min-w-0 items-center gap-2">{primaryViewToggle}</div>
    </header>
  )
}

function BlockList({
  blocks,
  onSelect,
  selectedBlockId
}: {
  blocks: readonly WorkspaceBlockRecord[]
  onSelect: (blockId: string) => void
  selectedBlockId: null | string
}) {
  return (
    <aside className="scrollbar-dt min-h-0 overflow-auto border-r border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) p-2">
      <div className="mb-2 px-1 text-[0.65rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
        Blocks
      </div>
      <div className="grid gap-1">
        {blocks.map(block => (
          <BlockRow
            active={blockId(block) === selectedBlockId}
            block={block}
            key={blockId(block)}
            onSelect={onSelect}
          />
        ))}
        {!blocks.length && <EmptyState label="No workspace blocks yet" />}
      </div>
    </aside>
  )
}

function BlockRow({
  active,
  block,
  onSelect
}: {
  active?: boolean
  block: WorkspaceBlockRecord
  onSelect: (blockId: string) => void
}) {
  const kind = blockKind(block)
  const status = blockStatus(block)
  const summary = blockSummary(block)

  return (
    <button
      className={cn(
        'group flex min-w-0 items-start gap-2 rounded-[4px] px-2 py-1.5 text-left transition-colors hover:bg-(--ui-row-hover-background)',
        active && 'bg-(--ui-row-active-background)'
      )}
      onClick={() => onSelect(blockId(block))}
      type="button"
    >
      <span className="relative mt-0.5 grid size-4 shrink-0 place-items-center text-(--ui-text-tertiary)">
        <Codicon name={blockIcon(kind)} size="0.8125rem" />
        <span
          className={cn(
            'absolute -right-0.5 -top-0.5 size-1.5 rounded-full ring-1 ring-(--ui-sidebar-surface-background)',
            statusClassName(status)
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.75rem] font-medium leading-4 text-(--ui-text-secondary)">
          {blockTitle(block)}
        </span>
        {summary && (
          <span className="line-clamp-2 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">{summary}</span>
        )}
      </span>
    </button>
  )
}

function WorkspaceArtifactCanvas({
  artifacts,
  onAction,
  onSelect,
  preview,
  selectedArtifactId
}: {
  artifacts: readonly WorkspaceArtifactRecord[]
  onAction?: (action: WorkspaceBlock['actions'][number], block: WorkspaceBlock) => void
  onSelect: (artifact: WorkspaceArtifactRecord) => void
  preview?: ReactNode
  selectedArtifactId: null | string
}) {
  const artifactById = useMemo(() => new Map(artifacts.map(artifact => [artifact.id, artifact])), [artifacts])
  const renderedArtifacts = useMemo(() => artifacts.map(toHorizontalArtifact), [artifacts])

  return (
    <section className="scrollbar-dt min-h-0 overflow-auto bg-(--ui-chat-surface-background) p-3">
      <div className="flex min-h-full min-w-0 gap-3">
        {preview && (
          <div className="min-h-36 w-[min(24rem,80vw)] shrink-0 overflow-hidden rounded-[6px] border border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background)">
            {preview}
          </div>
        )}
        <HorizontalArtifactCanvas
          artifacts={renderedArtifacts}
          className="min-w-0 flex-1 p-0"
          onArtifactAction={(action, artifact) => {
            const source = artifactById.get(artifact.id)

            if (source?.block) {
              onAction?.(action as WorkspaceBlock['actions'][number], source.block)
            }
          }}
          onSelectArtifact={artifactId => {
            const artifact = artifactById.get(artifactId)

            if (artifact) {
              onSelect(artifact)
            }
          }}
          selectedArtifactId={selectedArtifactId}
          showDetail={false}
        />
      </div>
    </section>
  )
}

function toHorizontalArtifact(artifact: WorkspaceArtifactRecord): HorizontalWorkspaceArtifact {
  const canvasArtifact = artifact.canvasArtifact
  const content = canvasArtifact.content ?? ''
  const base = {
    actions: artifact.kind === 'confirmation' ? (canvasArtifact.actions as HorizontalWorkspaceArtifactAction[]) : [],
    code: canvasArtifact.renderer === 'code' ? stripCodeFence(content) : undefined,
    columns: canvasArtifact.renderer === 'table' ? tableRowsFromContent(content).columns : undefined,
    content,
    id: artifact.id,
    markdown: canvasArtifact.renderer === 'markdown' ? content : undefined,
    renderer: canvasArtifact.renderer,
    rows: canvasArtifact.renderer === 'table' ? tableRowsFromContent(content).rows : undefined,
    sourceBlockId: artifact.sourceBlockId,
    status: artifact.status,
    summary: artifact.summary,
    title: artifact.title,
    type: canvasArtifact.renderer,
    updatedAt: canvasArtifact.updatedAt
  } satisfies HorizontalWorkspaceArtifact

  if ('entries' in canvasArtifact) {
    return {
      ...base,
      entries: canvasArtifact.entries.map(entry => ({
        id: entry.id,
        status: entry.status,
        summary: entry.summary,
        title: entry.label
      }))
    }
  }

  return base
}

function ArtifactCard({
  active,
  artifact,
  onAction,
  onSelect
}: {
  active?: boolean
  artifact: WorkspaceArtifactRecord
  onAction?: (action: WorkspaceBlock['actions'][number], block: WorkspaceBlock) => void
  onSelect: (artifact: WorkspaceArtifactRecord) => void
}) {
  const { block } = artifact

  if (!block) {
    return null
  }

  const kind = blockKind(block)
  const status = artifact.status
  const isError = kind === 'NOTE' && (status === 'error' || blockString(block, ['note_kind', 'tone']) === 'error')

  return (
    <div
      className={cn(
        'min-h-[17rem] w-[min(22rem,82vw)] shrink-0 rounded-[6px] border border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) p-3 text-left shadow-xs transition-colors hover:bg-(--ui-bg-quinary)',
        active && 'border-(--ui-stroke-primary) bg-(--ui-bg-quaternary)',
        isError && 'border-destructive/70 bg-destructive/5'
      )}
      data-workspace-artifact-card={artifact.id}
      data-workspace-source-block={artifact.sourceBlockId}
      onClick={() => onSelect(artifact)}
      role="button"
      tabIndex={0}
    >
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <span className="grid size-5 shrink-0 place-items-center rounded-[4px] bg-(--ui-bg-tertiary) text-(--ui-text-tertiary)">
          <Codicon name={artifactIcon(artifact.kind)} size="0.8125rem" />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium leading-5 text-(--ui-text-primary)">
          {artifact.title}
        </h3>
        <MetaPill label={artifact.kind} />
        <span className={cn('size-2 shrink-0 rounded-full', statusClassName(artifact.status))} />
      </div>
      <BlockBody block={block} onAction={onAction} />
      <BlockActions actions={block.actions} block={block} onAction={onAction} />
    </div>
  )
}

function BlockActions({
  actions,
  block,
  onAction
}: {
  actions?: WorkspaceBlock['actions']
  block: WorkspaceBlockRecord
  onAction?: (action: WorkspaceBlock['actions'][number], block: WorkspaceBlock) => void
}) {
  const visibleActions = (actions ?? []).filter(
    action => (action.kind === 'approve' || action.kind === 'reject') && isPendingConfirmationBlock(block)
  )

  if (!visibleActions.length) {
    return null
  }

  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {visibleActions.map(action => (
        <Button
          className="h-6 px-2 text-[0.6875rem]"
          key={action.id}
          onClick={event => {
            event.stopPropagation()
            onAction?.(action, block)
          }}
          size="xs"
          type="button"
          variant={action.kind === 'approve' ? 'default' : 'secondary'}
        >
          {action.label}
        </Button>
      ))}
    </div>
  )
}

function BlockBody({
  block,
  onAction
}: {
  block: WorkspaceBlockRecord
  onAction?: (action: WorkspaceBlock['actions'][number], block: WorkspaceBlock) => void
}) {
  const kind = blockKind(block)

  if (kind === 'LIST') {
    return <ListBlockBody block={block} onAction={onAction} />
  }

  if (kind === 'RUN') {
    return <RunBlockBody block={block} />
  }

  if (kind === 'TOPIC') {
    return <TopicBlockBody block={block} />
  }

  return <NoteBlockBody block={block} />
}

function ListBlockBody({
  block,
  onAction
}: {
  block: WorkspaceBlockRecord
  onAction?: (action: WorkspaceBlock['actions'][number], block: WorkspaceBlock) => void
}) {
  const items = blockArray(block, ['items'])
  const summary = blockSummary(block)
  const listKind = blockSubtype(block, ['list_kind', 'listKind'])
  const isConfirmations = listKind === 'confirmations' || blockTitle(block).toLowerCase().includes('confirmation')

  return (
    <div className="grid gap-2">
      {summary && <p className="m-0 text-[0.75rem] leading-5 text-(--ui-text-secondary)">{summary}</p>}
      {items.length > 0 && (
        <div className="grid gap-1.5">
          {items.map((item, index) => (
            <ListItemRow
              block={block}
              isConfirmations={isConfirmations}
              item={item}
              key={itemId(item, index)}
              onAction={onAction}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ListItemRow({
  block,
  isConfirmations,
  item,
  onAction
}: {
  block: WorkspaceBlockRecord
  isConfirmations: boolean
  item: unknown
  onAction?: (action: WorkspaceBlock['actions'][number], block: WorkspaceBlock) => void
}) {
  const status = itemStatus(item) || 'pending'
  const pending = status === 'pending' || status === 'requested'
  const actions =
    isConfirmations && pending
      ? itemActions(item).filter(action => action.kind === 'approve' || action.kind === 'reject')
      : []

  return (
    <div
      className={cn(
        'grid min-w-0 gap-1 rounded-[4px] border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-2 py-1.5',
        isConfirmations && pending && 'border-amber-500/70 bg-amber-500/10'
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn('mt-1 size-1.5 shrink-0 rounded-full', statusClassName(status))} />
        <span className="min-w-0 flex-1 line-clamp-2 text-[0.75rem] leading-5 text-(--ui-text-secondary)">
          {previewText(formatItem(item), { maxChars: ROW_PREVIEW_CHARS, singleLine: true, stripMarkdown: true })}
        </span>
        <span className="shrink-0 rounded-[3px] border border-(--ui-stroke-tertiary) px-1.5 py-0.5 text-[0.625rem] uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
          {status || 'step'}
        </span>
      </div>
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-3.5">
          {actions.map(action => (
            <Button
              className="h-6 px-2 text-[0.6875rem]"
              key={action.id}
              onClick={event => {
                event.stopPropagation()
                onAction?.(action, block)
              }}
              size="xs"
              type="button"
              variant={action.kind === 'approve' ? 'default' : 'secondary'}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function RunBlockBody({ block }: { block: WorkspaceBlockRecord }) {
  const progress = asRecord(block.progress)
  const runKind = blockString(block, ['run_kind', 'runKind', 'kind'])
  const outputValue = block.outputs ?? block.output ?? block.result
  const outputs = toPreviewItems(outputValue)

  const toolActivity =
    runKind === 'tool_activity' && outputs.length
      ? outputs
      : blockArray(block, ['tool_activity', 'toolActivity', 'tools'])

  const rows: [string, unknown][] = [
    ['kind', runKind],
    ['status', blockStatus(block)],
    ['progress', progress?.phase ?? blockNumber(block, ['progress_percent', 'progressPercent'])],
    ['outputs', outputValue]
  ]

  return (
    <div className="grid gap-2">
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {rows
          .filter(([, value]) => formatCompactValue(value))
          .map(([label, value]) => (
            <div className="min-w-0 rounded-[4px] bg-(--ui-bg-quinary) px-2 py-1.5" key={label}>
              <dt className="text-[0.625rem] uppercase tracking-[0.08em] text-(--ui-text-tertiary)">{label}</dt>
              <dd className="m-0 truncate text-[0.75rem] leading-5 text-(--ui-text-secondary)">
                {formatCompactValue(value)}
              </dd>
            </div>
          ))}
      </dl>
      {toolActivity.length > 0 && (
        <div className="rounded-[4px] border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-2">
          <div className="mb-1 text-[0.65rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
            Tool activity
          </div>
          <div className="grid gap-1">
            {toolActivity.map((tool, index) => {
              const record = asRecord(tool)
              const label = record ? recordLabel(record, `Tool ${index + 1}`) : compactText(formatItem(tool), 56)
              const state = record ? String(record.status ?? record.state ?? '') : ''

              const body = record
                ? previewText(recordText(record), {
                    maxChars: ROW_PREVIEW_CHARS,
                    singleLine: true,
                    stripMarkdown: true
                  })
                : ''

              return (
                <div className="flex min-w-0 items-center gap-2 text-[0.75rem] leading-5" key={`${index}:${label}`}>
                  <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="tools" size="0.75rem" />
                  <span className="min-w-0 flex-1 truncate text-(--ui-text-secondary)">{label}</span>
                  {body && (
                    <span className="hidden min-w-0 flex-[1.5] truncate text-(--ui-text-tertiary) md:block">
                      {body}
                    </span>
                  )}
                  {state && <span className="shrink-0 text-(--ui-text-tertiary)">{state}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function NoteBlockBody({ block }: { block: WorkspaceBlockRecord }) {
  const body = blockString(block, ['body', 'text', 'summary', 'description'])

  return (
    <p className="m-0 line-clamp-6 whitespace-pre-wrap text-[0.75rem] leading-5 text-(--ui-text-secondary)">
      {previewText(body, { maxChars: CARD_PREVIEW_CHARS, stripMarkdown: true })}
    </p>
  )
}

function TopicBlockBody({ block }: { block: WorkspaceBlockRecord }) {
  const thesis = blockString(block, ['thesis', 'summary', 'body'])
  const bullets = blockArray(block, ['bullets'])

  return (
    <div className="grid gap-2">
      {thesis && (
        <p className="m-0 line-clamp-4 whitespace-pre-wrap text-[0.75rem] leading-5 text-(--ui-text-secondary)">
          {previewText(thesis, { maxChars: CARD_PREVIEW_CHARS, stripMarkdown: true })}
        </p>
      )}
      {bullets.length > 0 && (
        <ul className="m-0 grid max-h-24 gap-1 overflow-hidden pl-4 text-[0.75rem] leading-5 text-(--ui-text-secondary)">
          {bullets.slice(0, 4).map((bullet, index) => (
            <li key={`${index}:${formatItem(bullet)}`}>
              {previewText(formatItem(bullet), { maxChars: ROW_PREVIEW_CHARS, singleLine: true, stripMarkdown: true })}
            </li>
          ))}
          {bullets.length > 4 && <li className="text-(--ui-text-tertiary)">+{bullets.length - 4} more</li>}
        </ul>
      )}
    </div>
  )
}

function WorkspaceRightPanel({
  artifact,
  block,
  messages,
  objects,
  onAction,
  onTabChange,
  rawEvents,
  tab
}: {
  artifact?: WorkspaceArtifactRecord
  block?: WorkspaceBlockRecord
  messages: readonly ChatMessage[]
  objects: readonly WorkspaceObject[]
  onAction?: (action: WorkspaceBlock['actions'][number], block: WorkspaceBlock) => void
  onTabChange: (tab: WorkspacePanelTab) => void
  rawEvents: readonly RawWorkspaceEventLike[]
  tab: WorkspacePanelTab
}) {
  return (
    <aside className="scrollbar-dt min-h-0 overflow-auto border-l border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) p-3">
      <PanelTabs activeTab={tab} messagesCount={messages.length} onChange={onTabChange} />
      {tab === 'transcript' && <TranscriptPanel messages={messages} />}
      {tab === 'events' && <EventsPanel events={rawEvents} objects={objects} />}
      {tab === 'detail' && (
        <DetailPanel artifact={artifact} block={block} messages={messages} objects={objects} onAction={onAction} />
      )}
    </aside>
  )
}

function PanelTabs({
  activeTab,
  messagesCount,
  onChange
}: {
  activeTab: WorkspacePanelTab
  messagesCount: number
  onChange: (tab: WorkspacePanelTab) => void
}) {
  return (
    <div className="mb-3 flex min-w-0 items-center gap-1 rounded-[4px] border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-0.5">
      {(['transcript', 'detail', 'events'] as const).map(tab => (
        <Button
          aria-pressed={activeTab === tab}
          className={cn(
            'h-6 min-w-0 flex-1 px-1.5 py-0 text-[0.6875rem]',
            activeTab === tab && 'bg-(--ui-bg-secondary)'
          )}
          key={tab}
          onClick={() => onChange(tab)}
          size="xs"
          type="button"
          variant="ghost"
        >
          {tab === 'transcript' ? `Transcript${messagesCount ? ` ${messagesCount}` : ''}` : titleCase(tab)}
        </Button>
      ))}
    </div>
  )
}

function TranscriptPanel({ messages }: { messages: readonly ChatMessage[] }) {
  const visibleMessages = messages.filter(message => !message.hidden)

  return (
    <div className="grid gap-2">
      {visibleMessages.map(message => {
        const text = previewText(chatMessageText(message), {
          maxChars: 280,
          singleLine: false,
          stripMarkdown: true
        })

        return (
          <div
            className="min-w-0 rounded-[4px] border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-2 py-1.5"
            key={message.id}
          >
            <div className="mb-1 flex min-w-0 items-center gap-2">
              <MetaPill label={message.role} />
              {message.pending && <MetaPill label="pending" />}
            </div>
            <p className="m-0 whitespace-pre-wrap text-[0.75rem] leading-5 text-(--ui-text-secondary)">
              {text || 'No text content'}
            </p>
          </div>
        )
      })}
      {!visibleMessages.length && <EmptyState label="Transcript will appear here" />}
    </div>
  )
}

function DetailPanel({
  artifact,
  block,
  messages,
  objects,
  onAction
}: {
  artifact?: WorkspaceArtifactRecord
  block?: WorkspaceBlockRecord
  messages: readonly ChatMessage[]
  objects: readonly WorkspaceObject[]
  onAction?: (action: WorkspaceBlock['actions'][number], block: WorkspaceBlock) => void
}) {
  const detailBlock = artifact?.block ?? block
  const objectIds = detailBlock ? blockSourceObjectIds(detailBlock) : []
  const userContext = latestUserContext(messages)
  const showUserContext = Boolean(userContext && artifact?.kind !== 'task' && artifact?.kind !== 'context')

  const relatedObjects = objectIds
    .map(objectId => objects.find(object => object.id === objectId))
    .filter((object): object is WorkspaceObject => Boolean(object))

  return (
    <div>
      <div className="mb-2 text-[0.65rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
        Detail
      </div>
      {artifact && !detailBlock ? (
        <div className="grid gap-3">
          <div>
            <div className="flex min-w-0 items-center gap-2">
              <Codicon
                className="shrink-0 text-(--ui-text-tertiary)"
                name={artifactIcon(artifact.kind)}
                size="0.875rem"
              />
              <h3 className="min-w-0 truncate text-[0.8125rem] font-medium leading-5">{artifact.title}</h3>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <MetaPill label="artifact" />
              <MetaPill label={artifact.kind} />
              <MetaPill label={artifact.status} />
            </div>
          </div>
          <ArtifactDetail artifact={artifact} />
          {showUserContext && <UserContextDetail content={userContext} />}
        </div>
      ) : detailBlock ? (
        <div className="grid gap-3">
          <div>
            <div className="flex min-w-0 items-center gap-2">
              <Codicon
                className="shrink-0 text-(--ui-text-tertiary)"
                name={artifact ? artifactIcon(artifact.kind) : blockIcon(blockKind(detailBlock))}
                size="0.875rem"
              />
              <h3 className="min-w-0 truncate text-[0.8125rem] font-medium leading-5">
                {artifact?.title ?? blockTitle(detailBlock)}
              </h3>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {artifact && <MetaPill label="artifact" />}
              <MetaPill label={artifact?.kind ?? blockKind(detailBlock)} />
              <MetaPill label={artifact?.status ?? blockStatus(detailBlock)} />
              {blockString(detailBlock, ['updated_at', 'updatedAt']) && (
                <MetaPill label={formatTime(blockString(detailBlock, ['updated_at', 'updatedAt']))} />
              )}
            </div>
          </div>
          {artifact && <ArtifactDetail artifact={artifact} />}
          {showUserContext && <UserContextDetail content={userContext} />}
          {!artifact?.sourceBlockId?.startsWith('block:chat:summary:') && <BlockDetail block={detailBlock} />}
          <ArtifactActions artifact={artifact} onAction={onAction} />
          <BlockActions actions={detailBlock.actions} block={detailBlock} onAction={onAction} />
          <DebugRefs block={detailBlock} relatedObjects={relatedObjects} />
        </div>
      ) : (
        <EmptyState label="Select an artifact" />
      )}
    </div>
  )
}

function latestUserContext(messages: readonly ChatMessage[]): string {
  const message = [...messages]
    .reverse()
    .find(candidate => candidate.role === 'user' && chatMessageText(candidate).trim())

  return message ? chatMessageText(message).trim() : ''
}

function UserContextDetail({ content }: { content: string }) {
  return (
    <DetailSection label="User context">
      <p className="m-0 whitespace-pre-wrap break-words text-[0.75rem] leading-5 text-(--ui-text-secondary)">
        {content}
      </p>
    </DetailSection>
  )
}

function ArtifactDetail({ artifact }: { artifact: WorkspaceArtifactRecord }) {
  const rows = [
    ['Source block', artifact.sourceBlockId],
    ['Artifact kind', artifact.kind],
    ['Status', artifact.status]
  ].filter(([, value]) => Boolean(value)) as [string, string][]
  const content = artifact.canvasArtifact.content ?? ''
  const runEntries = 'entries' in artifact.canvasArtifact ? artifact.canvasArtifact.entries : []
  const contentDuplicatesSummary =
    Boolean(artifact.summary) && normalizeDetailText(content) === normalizeDetailText(artifact.summary)

  return (
    <div className="grid gap-2">
      {artifact.summary && (
        <DetailSection label="Summary">
          <p className="m-0 whitespace-pre-wrap break-words text-[0.75rem] leading-5 text-(--ui-text-secondary)">
            {artifact.summary}
          </p>
        </DetailSection>
      )}
      {content && !runEntries.length && !contentDuplicatesSummary && (
        <DetailSection label="Content">
          <ArtifactContentPreview artifact={artifact} content={content} />
        </DetailSection>
      )}
      {runEntries.length > 0 && (
        <DetailSection label="Run">
          <div className="grid gap-1.5">
            {runEntries.map(entry => (
              <div className="flex min-w-0 items-center gap-2 text-[0.75rem] leading-5" key={entry.id}>
                <span
                  className={cn('size-1.5 shrink-0 rounded-full', statusClassName(entry.status ?? artifact.status))}
                />
                <span className="min-w-0 flex-1 truncate text-(--ui-text-secondary)">{entry.label}</span>
                {entry.summary && (
                  <span className="hidden min-w-0 flex-[1.4] truncate text-(--ui-text-tertiary) md:block">
                    {entry.summary}
                  </span>
                )}
              </div>
            ))}
          </div>
        </DetailSection>
      )}
      <dl className="grid gap-2">
        {rows.map(([label, value]) => (
          <div className="min-w-0" key={label}>
            <dt className="mb-0.5 text-[0.65rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
              {label}
            </dt>
            <dd className="m-0 overflow-auto whitespace-pre-wrap rounded-[4px] bg-(--ui-bg-quinary) px-2 py-1.5 text-[0.75rem] leading-5 text-(--ui-text-secondary)">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function normalizeDetailText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function DetailSection({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-[0.65rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
        {label}
      </div>
      <div className="scrollbar-dt max-h-72 overflow-auto rounded-[4px] bg-(--ui-bg-quinary) px-2 py-1.5">
        {children}
      </div>
    </div>
  )
}

function ArtifactContentPreview({ artifact, content }: { artifact: WorkspaceArtifactRecord; content: string }) {
  if (artifact.canvasArtifact.renderer === 'table') {
    const { columns, rows } = tableRowsFromContent(content)

    if (columns.length && rows.length) {
      return (
        <table className="min-w-full border-collapse text-[0.75rem] leading-5">
          <thead className="text-(--ui-text-tertiary)">
            <tr>
              {columns.map(column => (
                <th className="border-b border-(--ui-stroke-tertiary) px-2 py-1 text-left font-medium" key={column.key}>
                  {column.label ?? column.key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-(--ui-text-secondary)">
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {columns.map(column => (
                  <td
                    className="max-w-[18rem] border-t border-(--ui-stroke-tertiary) px-2 py-1 align-top"
                    key={column.key}
                  >
                    <span className="whitespace-pre-wrap break-words">{String(row[column.key] ?? '')}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    }
  }

  if (artifact.canvasArtifact.renderer === 'code') {
    return (
      <pre className="m-0 text-[0.75rem] leading-5 text-(--ui-text-secondary)">
        <code>{stripCodeFence(content)}</code>
      </pre>
    )
  }

  return (
    <p className="m-0 whitespace-pre-wrap break-words text-[0.75rem] leading-5 text-(--ui-text-secondary)">{content}</p>
  )
}

function ArtifactActions({
  artifact,
  onAction
}: {
  artifact?: WorkspaceArtifactRecord
  onAction?: (action: WorkspaceBlock['actions'][number], block: WorkspaceBlock) => void
}) {
  if (!artifact || !artifact.block || artifact.kind !== 'confirmation') {
    return null
  }

  const actions = artifact.canvasArtifact.actions.filter(
    action => action.kind === 'approve' || action.kind === 'reject'
  )

  if (!actions.length) {
    return null
  }

  return (
    <div className="grid gap-1.5">
      <div className="text-[0.65rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
        Confirmation
      </div>
      <div className="flex flex-wrap gap-1.5">
        {actions.map(action => {
          const block = artifact.block

          if (!block) {
            return null
          }

          return (
            <Button
              className="h-6 px-2 text-[0.6875rem]"
              key={action.id}
              onClick={() => onAction?.(action, block)}
              size="xs"
              type="button"
              variant={action.kind === 'approve' ? 'default' : 'secondary'}
            >
              {action.label}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

function BlockDetail({ block }: { block: WorkspaceBlockRecord }) {
  const rows = detailRows(block)

  return (
    <dl className="grid gap-2">
      {rows.map(([label, value]) => (
        <div className="min-w-0" key={label}>
          <dt className="mb-0.5 text-[0.65rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
            {label}
          </dt>
          <dd className="m-0 max-h-72 overflow-auto whitespace-pre-wrap rounded-[4px] bg-(--ui-bg-quinary) px-2 py-1.5 text-[0.75rem] leading-5 text-(--ui-text-secondary)">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function detailRows(block: WorkspaceBlockRecord): [string, string][] {
  const kind = blockKind(block)
  const summary = blockSummary(block)
  const thesis = blockString(block, ['thesis'])
  const body = blockString(block, ['body', 'text'])
  const outputValue = block.outputs ?? block.output ?? block.result
  const rows: [string, string][] = []
  const seen: string[] = []

  const addRow = (label: string, value: string) => {
    const cleaned = previewText(value, { maxChars: DETAIL_PREVIEW_CHARS, stripMarkdown: true })
    const signature = compactText(cleaned, DETAIL_PREVIEW_CHARS).toLowerCase()

    if (
      !cleaned ||
      seen.some(existing => existing === signature || existing.startsWith(signature) || signature.startsWith(existing))
    ) {
      return
    }

    rows.push([label, cleaned])
    seen.push(signature)
  }

  if (kind === 'RUN') {
    addRow('Run kind', blockString(block, ['run_kind', 'runKind']))
    addRow('Status', blockStatus(block))
    addRow('Summary', summary)
    addRow('Outputs', previewValue(outputValue, { maxChars: DETAIL_PREVIEW_CHARS, maxItems: 8 }))
    addRow(
      'Inputs',
      previewValue(block.inputs ?? block.input ?? block.args, { maxChars: DETAIL_PREVIEW_CHARS, maxItems: 8 })
    )

    return rows
  }

  if (kind === 'LIST') {
    addRow('List kind', blockString(block, ['list_kind', 'listKind']))
  }

  if (kind === 'TOPIC') {
    addRow('Topic kind', blockString(block, ['topic_kind', 'topicKind']))
  }

  if (kind === 'NOTE') {
    addRow('Note kind', blockString(block, ['note_kind', 'noteKind']))
  }

  addRow('Thesis', thesis)
  addRow('Body', body)
  addRow('Summary', summary)

  if (kind === 'TOPIC') {
    const bullets = blockArray(block, ['bullets'])
      .map(item =>
        previewText(formatItem(item), { maxChars: ROW_PREVIEW_CHARS, singleLine: true, stripMarkdown: true })
      )
      .filter(Boolean)

    addRow('Bullets', bullets.join('\n'))
  }

  if (kind === 'LIST') {
    const items = blockArray(block, ['items'])
      .map(item =>
        previewText(formatItem(item), { maxChars: ROW_PREVIEW_CHARS, singleLine: true, stripMarkdown: true })
      )
      .filter(Boolean)

    addRow('Items', items.join('\n'))
  }

  addRow('Outputs', previewValue(outputValue, { maxChars: DETAIL_PREVIEW_CHARS, maxItems: 8 }))

  return rows
}

function DebugRefs({
  block,
  relatedObjects
}: {
  block: WorkspaceBlockRecord
  relatedObjects: readonly WorkspaceObject[]
}) {
  const sourceEventIds = blockSourceEventIds(block)

  if (!sourceEventIds.length && !relatedObjects.length) {
    return null
  }

  return (
    <details className="rounded-[4px] border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-2">
      <summary className="cursor-pointer text-[0.65rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
        Debug
      </summary>
      <div className="mt-2 grid gap-2 text-[0.6875rem] leading-4 text-(--ui-text-secondary)">
        {sourceEventIds.length > 0 && <DebugList label="Event refs" values={sourceEventIds} />}
        {relatedObjects.length > 0 && (
          <DebugList
            label="Object refs"
            values={relatedObjects.map(object => `${object.object_type}: ${object.title} (${object.id})`)}
          />
        )}
      </div>
    </details>
  )
}

function DebugList({ label, values }: { label: string; values: readonly string[] }) {
  return (
    <div>
      <div className="mb-1 text-(--ui-text-tertiary)">{label}</div>
      <ul className="m-0 grid gap-1 pl-4">
        {values.map(value => (
          <li className="break-all" key={value}>
            {value}
          </li>
        ))}
      </ul>
    </div>
  )
}

function EventsPanel({
  events,
  objects
}: {
  events: readonly RawWorkspaceEventLike[]
  objects: readonly WorkspaceObject[]
}) {
  return (
    <section className="scrollbar-dt min-h-0 overflow-auto bg-(--ui-chat-surface-background) p-3">
      <div className="mx-auto grid max-w-5xl gap-3">
        <RawEvents events={events} />
        <RawObjects objects={objects} />
      </div>
    </section>
  )
}

function RawEvents({ events }: { events: readonly RawWorkspaceEventLike[] }) {
  return (
    <div className="grid gap-2">
      <div className="text-[0.65rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)">Raw events</div>
      {events.map((event, index) => (
        <div
          className="rounded-[6px] border border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) p-2"
          key={event.id ?? `${event.type}:${index}`}
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="truncate font-mono text-[0.75rem] text-(--ui-text-secondary)">{event.type}</span>
            {event.sessionId && (
              <span className="shrink-0 font-mono text-[0.625rem] text-(--ui-text-tertiary)">{event.sessionId}</span>
            )}
          </div>
          {event.payload !== undefined && (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">
              {jsonPreview(event.payload)}
            </pre>
          )}
        </div>
      ))}
      {!events.length && <EmptyState label="Raw workspace events will appear here" />}
    </div>
  )
}

function RawObjects({ objects }: { objects: readonly WorkspaceObject[] }) {
  return (
    <div className="grid gap-2">
      <div className="text-[0.65rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
        Raw objects
      </div>
      {objects.map(object => (
        <pre
          className="max-h-56 overflow-auto rounded-[6px] border border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) p-2 whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-4 text-(--ui-text-tertiary)"
          key={object.id}
        >
          {jsonPreview(object)}
        </pre>
      ))}
      {!objects.length && <EmptyState label="Raw workspace objects will appear here" />}
    </div>
  )
}

function MetaPill({ label }: { label: string }) {
  return (
    <span className="rounded-[3px] bg-(--ui-bg-tertiary) px-1.5 py-0.5 text-[0.625rem] leading-4 text-(--ui-text-tertiary)">
      {label}
    </span>
  )
}

function titleCase(value: string): string {
  return value[0] ? value[0].toUpperCase() + value.slice(1) : value
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="grid min-h-24 place-items-center rounded-[6px] border border-dashed border-(--ui-stroke-tertiary) px-3 text-center text-[0.75rem] text-(--ui-text-tertiary)">
      {label}
    </div>
  )
}
