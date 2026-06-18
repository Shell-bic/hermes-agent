import { useRef, useState } from 'react'
import type { ComponentProps, MouseEvent, PointerEvent, ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { cn } from '@/lib/utils'
import type { CanvasArtifactRenderer } from '@/lib/workspace-artifacts'

type AnyRecord = Record<string, unknown>

export type WorkspaceArtifactType = CanvasArtifactRenderer

export interface WorkspaceArtifactAction {
  id: string
  kind?: string
  label: string
  metadata?: AnyRecord
}

export interface WorkspaceArtifactItem {
  actions?: WorkspaceArtifactAction[]
  children?: WorkspaceArtifactItem[]
  content?: ReactNode
  id?: string
  label?: string
  summary?: string
  status?: string
  text?: string
  time?: string
  title?: string
}

export interface WorkspaceArtifactTableColumn {
  key: string
  label?: string
}

export interface WorkspaceArtifact {
  actions?: WorkspaceArtifactAction[]
  body?: string
  code?: string
  columns?: WorkspaceArtifactTableColumn[]
  content?: string
  entries?: WorkspaceArtifactItem[]
  id: string
  items?: WorkspaceArtifactItem[]
  language?: string
  markdown?: string
  renderer?: WorkspaceArtifactType
  rows?: AnyRecord[]
  sourceBlockId?: string
  status?: string
  summary?: string
  title: string
  type?: WorkspaceArtifactType
  updatedAt?: string
}

export interface ArtifactCanvasProps extends Omit<ComponentProps<'section'>, 'onSelect'> {
  artifacts: readonly WorkspaceArtifact[]
  onArtifactAction?: (action: WorkspaceArtifactAction, artifact: WorkspaceArtifact) => void
  onSelectArtifact?: (artifactId: string) => void
  selectedArtifactId?: null | string
  showDetail?: boolean
}

const ROW_PREVIEW_CHARS = 88
const DRAG_SCROLL_THRESHOLD = 4

function compactText(value: string, maxChars = ROW_PREVIEW_CHARS): string {
  const normalized = value
    .replace(/```[\s\S]*?```/g, match => match.replace(/```[a-zA-Z0-9_-]*\n?|```/g, ''))
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

  if (normalized.length <= maxChars) {
    return normalized
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`
}

function artifactRenderer(artifact: WorkspaceArtifact): WorkspaceArtifactType {
  return artifact.renderer ?? artifact.type ?? 'markdown'
}

function artifactIcon(renderer: WorkspaceArtifactType): string {
  if (renderer === 'checklist' || renderer === 'task') {
    return 'checklist'
  }

  if (renderer === 'timeline') {
    return 'history'
  }

  if (renderer === 'outline') {
    return 'list-tree'
  }

  if (renderer === 'table') {
    return 'table'
  }

  if (renderer === 'code') {
    return 'code'
  }

  return 'markdown'
}

function statusClassName(status: string | undefined): string {
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

function actionVariant(action: WorkspaceArtifactAction): 'default' | 'secondary' {
  return action.kind === 'approve' || action.kind === 'confirm' || action.kind === 'accept' ? 'default' : 'secondary'
}

function artifactText(artifact: WorkspaceArtifact): string {
  return artifact.body ?? artifact.markdown ?? artifact.content ?? artifact.code ?? artifact.summary ?? ''
}

function artifactItems(artifact: WorkspaceArtifact): WorkspaceArtifactItem[] {
  if (artifact.items?.length) {
    return [...artifact.items]
  }

  if (artifact.entries?.length) {
    return artifact.entries.map(entry => ({
      ...entry,
      text: entry.text ?? entry.summary
    }))
  }

  const content = artifact.content ?? ''

  if (!content.trim()) {
    return []
  }

  return content
    .split(/\r?\n/)
    .map((line, index): WorkspaceArtifactItem | undefined => {
      const trimmed = line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim()

      if (!trimmed) {
        return undefined
      }

      const checked = /^\[[xX]\]\s+/.test(trimmed)
      const unchecked = /^\[ \]\s+/.test(trimmed)

      return {
        id: `${artifact.id}:line:${index}`,
        status: checked ? 'completed' : unchecked ? 'pending' : undefined,
        title: trimmed.replace(/^\[[ xX]\]\s+/, '')
      }
    })
    .filter((item): item is WorkspaceArtifactItem => Boolean(item))
}

function tableRowsFromContent(content: string): { columns: WorkspaceArtifactTableColumn[]; rows: AnyRecord[] } {
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

export function ArtifactCanvas({
  artifacts,
  className,
  onArtifactAction,
  onSelectArtifact,
  selectedArtifactId,
  showDetail = true,
  ...props
}: ArtifactCanvasProps) {
  const selectedArtifact =
    (selectedArtifactId && artifacts.find(artifact => artifact.id === selectedArtifactId)) || artifacts[0]

  const activeId = selectedArtifactId ?? selectedArtifact?.id ?? null
  const trackRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<{
    moved: boolean
    pointerId: number
    scrollLeft: number
    startX: number
  } | null>(null)
  const suppressNextClick = useRef(false)
  const [isDraggingTrack, setIsDraggingTrack] = useState(false)

  const startDragScroll = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement | null)?.closest('button,a,input,textarea,select,[role="button"]')
    ) {
      return
    }

    const track = trackRef.current

    if (!track) {
      return
    }

    dragState.current = {
      moved: false,
      pointerId: event.pointerId,
      scrollLeft: track.scrollLeft,
      startX: event.clientX
    }
    track.setPointerCapture?.(event.pointerId)
  }

  const dragScroll = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current
    const track = trackRef.current

    if (!drag || !track || drag.pointerId !== event.pointerId) {
      return
    }

    const deltaX = event.clientX - drag.startX

    if (!drag.moved && Math.abs(deltaX) >= DRAG_SCROLL_THRESHOLD) {
      drag.moved = true
      suppressNextClick.current = true
      setIsDraggingTrack(true)
    }

    if (drag.moved) {
      event.preventDefault()
      track.scrollLeft = drag.scrollLeft - deltaX
    }
  }

  const stopDragScroll = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current

    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }

    trackRef.current?.releasePointerCapture?.(event.pointerId)
    dragState.current = null
    setIsDraggingTrack(false)
  }

  const captureClickAfterDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (!suppressNextClick.current) {
      return
    }

    suppressNextClick.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <section
      className={cn(
        'flex min-h-0 flex-col gap-3 overflow-hidden bg-(--ui-chat-surface-background) p-3 text-(--ui-text-primary)',
        className
      )}
      {...props}
    >
      <div
        aria-label="Artifacts"
        className={cn(
          'scrollbar-dt flex min-h-0 cursor-grab gap-2 overflow-x-auto pb-1 select-none touch-pan-x',
          isDraggingTrack && 'cursor-grabbing'
        )}
        data-artifact-track
        data-dragging={isDraggingTrack ? 'true' : 'false'}
        onClickCapture={captureClickAfterDrag}
        onPointerCancel={stopDragScroll}
        onPointerDown={startDragScroll}
        onPointerMove={dragScroll}
        onPointerUp={stopDragScroll}
        ref={trackRef}
      >
        {artifacts.map(artifact => (
          <ArtifactCard
            artifact={artifact}
            key={artifact.id}
            onAction={onArtifactAction}
            onSelect={onSelectArtifact}
            selected={artifact.id === activeId}
          />
        ))}
        {!artifacts.length && <EmptyArtifactState />}
      </div>
      {showDetail && <ArtifactDetail artifact={selectedArtifact} onAction={onArtifactAction} />}
    </section>
  )
}

function EmptyArtifactState() {
  return (
    <div className="grid h-28 min-w-64 place-items-center rounded-[6px] border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) px-4 text-center text-[0.75rem] text-(--ui-text-tertiary)">
      Start a conversation to populate the workspace
    </div>
  )
}

function ArtifactCard({
  artifact,
  onAction,
  onSelect,
  selected
}: {
  artifact: WorkspaceArtifact
  onAction?: (action: WorkspaceArtifactAction, artifact: WorkspaceArtifact) => void
  onSelect?: (artifactId: string) => void
  selected: boolean
}) {
  const renderer = artifactRenderer(artifact)
  const variant = selected ? 'expanded' : 'compact'
  const isTask = renderer === 'task'

  return (
    <article
      aria-label={artifact.title}
      className={cn(
        'flex h-48 shrink-0 cursor-pointer flex-col rounded-[6px] border border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) p-3 text-left shadow-xs transition-colors hover:bg-(--ui-bg-quinary)',
        isTask ? 'min-w-56 max-w-64 opacity-80' : 'min-w-72 max-w-[24rem]',
        selected &&
          (isTask
            ? 'h-56 min-w-72 max-w-[22rem] border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) opacity-100'
            : 'h-[clamp(24rem,68vh,42rem)] min-w-[42rem] max-w-[64rem] border-(--ui-stroke-primary) bg-(--ui-bg-quaternary) shadow-sm')
      )}
      data-artifact-card={artifact.id}
      data-artifact-card-emphasis={isTask ? 'context' : 'answer'}
      data-artifact-card-variant={variant}
      data-workspace-artifact-card={artifact.id}
      data-workspace-source-block={artifact.sourceBlockId}
      onClick={() => onSelect?.(artifact.id)}
    >
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <span className="grid size-5 shrink-0 place-items-center rounded-[4px] bg-(--ui-bg-tertiary) text-(--ui-text-tertiary)">
          <Codicon name={artifactIcon(renderer)} size="0.8125rem" />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium leading-5 text-(--ui-text-primary)">
          {artifact.title}
        </h3>
        <span className="shrink-0 rounded-[3px] border border-(--ui-stroke-tertiary) px-1.5 py-0.5 text-[0.625rem] uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
          {renderer}
        </span>
        <span className={cn('size-2 shrink-0 rounded-full', statusClassName(artifact.status))} />
      </div>
      <div
        className={cn('min-h-0 flex-1', selected ? 'scrollbar-dt overflow-auto pr-1' : 'overflow-hidden')}
        data-artifact-card-scroll={selected ? artifact.id : undefined}
      >
        <ArtifactPreview artifact={artifact} onAction={onAction} selected={selected} />
      </div>
      <ArtifactActions artifact={artifact} onAction={onAction} />
    </article>
  )
}

function ArtifactPreview({
  artifact,
  onAction,
  selected
}: {
  artifact: WorkspaceArtifact
  onAction?: (action: WorkspaceArtifactAction, artifact: WorkspaceArtifact) => void
  selected: boolean
}) {
  const renderer = artifactRenderer(artifact)

  if (renderer === 'task') {
    return <TaskPreview artifact={artifact} selected={selected} />
  }

  if (renderer === 'checklist') {
    return <ChecklistPreview artifact={artifact} onAction={onAction} selected={selected} />
  }

  if (renderer === 'timeline') {
    return <TimelinePreview artifact={artifact} selected={selected} />
  }

  if (renderer === 'outline') {
    return <OutlinePreview artifact={artifact} selected={selected} />
  }

  if (renderer === 'table') {
    return <TablePreview artifact={artifact} selected={selected} />
  }

  if (renderer === 'code') {
    return <CodePreview artifact={artifact} selected={selected} />
  }

  const text = artifactText(artifact)

  return selected ? (
    <CompactMarkdown
      className="text-[0.8125rem] leading-5 text-(--ui-text-secondary)"
      text={text}
    />
  ) : (
    <p className="m-0 line-clamp-5 whitespace-pre-wrap text-[0.75rem] leading-5 text-(--ui-text-secondary)">
      {compactText(text, 180)}
    </p>
  )
}

function TaskPreview({ artifact, selected }: { artifact: WorkspaceArtifact; selected: boolean }) {
  return (
    <p className="m-0 line-clamp-6 whitespace-pre-wrap text-[0.75rem] leading-5 text-(--ui-text-secondary)">
      {compactText(artifact.content ?? artifact.summary ?? '', selected ? 360 : 180)}
    </p>
  )
}

function ChecklistPreview({
  artifact,
  onAction,
  selected
}: {
  artifact: WorkspaceArtifact
  onAction?: (action: WorkspaceArtifactAction, artifact: WorkspaceArtifact) => void
  selected: boolean
}) {
  const items = artifactItems(artifact)
  const visibleItems = selected ? items.slice(0, 12) : items.slice(0, 3)

  return (
    <div className="grid gap-1.5">
      {artifact.summary && (
        <p className="m-0 truncate text-[0.75rem] leading-5 text-(--ui-text-secondary)">{artifact.summary}</p>
      )}
      {visibleItems.map((item, index) => (
        <div
          className="flex min-w-0 items-center gap-2 text-[0.75rem] leading-5"
          key={item.id ?? `${index}:${item.title}`}
        >
          <span className={cn('size-1.5 shrink-0 rounded-full', statusClassName(item.status))} />
          <span className={cn('min-w-0 flex-1 text-(--ui-text-secondary)', !selected && 'truncate')}>
            {selected
              ? (item.title ?? item.text ?? item.label ?? String(item.content ?? ''))
              : compactText(item.title ?? item.text ?? item.label ?? String(item.content ?? ''), ROW_PREVIEW_CHARS)}
          </span>
          {item.status && (
            <span className="shrink-0 rounded-[3px] border border-(--ui-stroke-tertiary) px-1.5 py-0.5 text-[0.625rem] uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
              {item.status}
            </span>
          )}
          {selected &&
            item.actions?.slice(0, 2).map(action => (
              <Button
                className="h-6 px-2 text-[0.6875rem]"
                key={action.id}
                onClick={event => {
                  event.stopPropagation()
                  onAction?.(action, artifact)
                }}
                size="xs"
                type="button"
                variant={actionVariant(action)}
              >
                {action.label}
              </Button>
            ))}
        </div>
      ))}
      {items.length > visibleItems.length && (
        <div className="text-[0.6875rem] text-(--ui-text-tertiary)">+{items.length - visibleItems.length} more</div>
      )}
    </div>
  )
}

function TimelinePreview({ artifact, selected }: { artifact: WorkspaceArtifact; selected: boolean }) {
  const items = artifactItems(artifact).slice(0, selected ? 12 : 3)

  return (
    <div className="grid gap-1.5">
      {items.map((item, index) => (
        <div className="flex min-w-0 gap-2 text-[0.75rem] leading-5" key={item.id ?? `${index}:${item.title}`}>
          <span className="w-12 shrink-0 truncate text-[0.6875rem] text-(--ui-text-tertiary)">
            {item.time ?? item.status ?? ''}
          </span>
          <span className={cn('min-w-0 flex-1 text-(--ui-text-secondary)', !selected && 'truncate')}>
            {selected
              ? (item.title ?? item.label ?? item.text ?? '')
              : compactText(item.title ?? item.label ?? item.text ?? '', ROW_PREVIEW_CHARS)}
          </span>
          {item.summary && (
            <span className={cn('hidden min-w-0 flex-1 text-(--ui-text-tertiary) md:block', !selected && 'truncate')}>
              {selected ? item.summary : compactText(item.summary, ROW_PREVIEW_CHARS)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function OutlinePreview({ artifact, selected }: { artifact: WorkspaceArtifact; selected: boolean }) {
  const items = selected ? artifactItems(artifact) : artifactItems(artifact).slice(0, 4)

  return (
    <ol className="m-0 grid gap-1 pl-4 text-[0.75rem] leading-5 text-(--ui-text-secondary)">
      {items.map((item, index) => (
        <li className={cn(!selected && 'truncate')} key={item.id ?? `${index}:${item.title}`}>
          {selected
            ? (item.title ?? item.text ?? item.label ?? '')
            : compactText(item.title ?? item.text ?? item.label ?? '', ROW_PREVIEW_CHARS)}
        </li>
      ))}
    </ol>
  )
}

function TablePreview({ artifact, selected }: { artifact: WorkspaceArtifact; selected: boolean }) {
  const parsed = tableRowsFromContent(artifact.content ?? artifact.markdown ?? artifact.body ?? '')
  const rows = artifact.rows?.length ? artifact.rows : parsed.rows

  const columns: WorkspaceArtifactTableColumn[] = artifact.columns?.length
    ? artifact.columns
    : parsed.columns.length
      ? parsed.columns
      : Object.keys(rows[0] ?? {}).map(key => ({ key }))

  const visibleColumns = selected ? columns : columns.slice(0, 2)

  return (
    <div className={cn('rounded-[4px] border border-(--ui-stroke-tertiary)', selected ? 'overflow-auto' : 'overflow-hidden')}>
      <table className={cn('border-collapse text-[0.6875rem] leading-4', selected ? 'min-w-full' : 'w-full table-fixed')}>
        <thead className="bg-(--ui-bg-quinary) text-(--ui-text-tertiary)">
          <tr>
            {visibleColumns.map(column => (
              <th className="border-b border-(--ui-stroke-tertiary) px-2 py-1 text-left font-medium" key={column.key}>
                <span className="block truncate">{column.label ?? column.key}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-(--ui-text-secondary)">
          {rows.slice(0, selected ? 24 : 3).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {visibleColumns.map(column => (
                <td className="border-t border-(--ui-stroke-tertiary) px-2 py-1 align-top" key={column.key}>
                  <span className={cn('block', selected ? 'whitespace-pre-wrap break-words' : 'truncate')}>
                    {selected ? String(row[column.key] ?? '') : compactText(String(row[column.key] ?? ''), 42)}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CodePreview({ artifact, selected }: { artifact: WorkspaceArtifact; selected: boolean }) {
  return (
    <pre
      className={cn(
        'm-0 rounded-[4px] bg-(--ui-bg-quinary) p-2 text-[0.6875rem] leading-4 text-(--ui-text-secondary)',
        selected ? 'scrollbar-dt overflow-auto' : 'max-h-28 overflow-hidden'
      )}
    >
      <code>
        {selected
          ? (artifact.code ?? artifact.content ?? artifact.body ?? '')
          : compactText(artifact.code ?? artifact.content ?? artifact.body ?? '', 220)}
      </code>
    </pre>
  )
}

function ArtifactActions({
  artifact,
  onAction
}: {
  artifact: WorkspaceArtifact
  onAction?: (action: WorkspaceArtifactAction, artifact: WorkspaceArtifact) => void
}) {
  const actions = artifact.actions ?? []

  if (!actions.length) {
    return null
  }

  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {actions.map(action => (
        <Button
          className="h-6 px-2 text-[0.6875rem]"
          key={action.id}
          onClick={event => {
            event.stopPropagation()
            onAction?.(action, artifact)
          }}
          size="xs"
          type="button"
          variant={actionVariant(action)}
        >
          {action.label}
        </Button>
      ))}
    </div>
  )
}

function ArtifactDetail({
  artifact,
  onAction
}: {
  artifact?: WorkspaceArtifact
  onAction?: (action: WorkspaceArtifactAction, artifact: WorkspaceArtifact) => void
}) {
  if (!artifact) {
    return (
      <aside className="min-h-32 rounded-[6px] border border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) p-3 text-[0.75rem] text-(--ui-text-tertiary)">
        Select an artifact
      </aside>
    )
  }

  return (
    <aside
      className="scrollbar-dt min-h-0 overflow-auto rounded-[6px] border border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) p-3"
      data-artifact-detail={artifact.id}
    >
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <Codicon
          className="text-(--ui-text-tertiary)"
          name={artifactIcon(artifactRenderer(artifact))}
          size="0.875rem"
        />
        <h2 className="min-w-0 flex-1 truncate text-[0.875rem] font-medium leading-5 text-(--ui-text-primary)">
          {artifact.title}
        </h2>
        <span className="rounded-[3px] border border-(--ui-stroke-tertiary) px-1.5 py-0.5 text-[0.625rem] uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
          {artifactRenderer(artifact)}
        </span>
      </div>
      <ArtifactDetailBody artifact={artifact} />
      <ArtifactActions artifact={artifact} onAction={onAction} />
    </aside>
  )
}

function ArtifactDetailBody({ artifact }: { artifact: WorkspaceArtifact }) {
  const renderer = artifactRenderer(artifact)

  if (renderer === 'table') {
    return <TableDetail artifact={artifact} />
  }

  if (renderer === 'code') {
    return (
      <pre className="scrollbar-dt m-0 max-h-80 overflow-auto rounded-[4px] bg-(--ui-bg-quinary) p-3 text-[0.75rem] leading-5 text-(--ui-text-secondary)">
        <code>{artifact.code ?? artifact.content ?? artifact.body ?? ''}</code>
      </pre>
    )
  }

  if (renderer === 'markdown') {
    return (
      <CompactMarkdown
        className="text-[0.75rem] leading-5 text-(--ui-text-secondary)"
        text={artifactText(artifact)}
      />
    )
  }

  const items = artifactItems(artifact)

  if (items.length) {
    return (
      <div className="grid gap-1.5">
        {items.map((item, index) => (
          <div className="flex min-w-0 gap-2 text-[0.75rem] leading-5" key={item.id ?? `${index}:${item.title}`}>
            <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', statusClassName(item.status))} />
            <span className="min-w-0 flex-1 text-(--ui-text-secondary)">
              {item.title ?? item.text ?? item.label ?? String(item.content ?? '')}
            </span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <p className="m-0 whitespace-pre-wrap break-words text-[0.75rem] leading-5 text-(--ui-text-secondary)">
      {artifactText(artifact)}
    </p>
  )
}

function TableDetail({ artifact }: { artifact: WorkspaceArtifact }) {
  const parsed = tableRowsFromContent(artifact.content ?? artifact.markdown ?? artifact.body ?? '')
  const rows = artifact.rows?.length ? artifact.rows : parsed.rows

  const columns: WorkspaceArtifactTableColumn[] = artifact.columns?.length
    ? artifact.columns
    : parsed.columns.length
      ? parsed.columns
      : Object.keys(rows[0] ?? {}).map(key => ({ key }))

  if (!rows.length || !columns.length) {
    return (
      <p className="m-0 whitespace-pre-wrap break-words text-[0.75rem] leading-5 text-(--ui-text-secondary)">
        {artifactText(artifact)}
      </p>
    )
  }

  return (
    <div className="scrollbar-dt max-h-80 overflow-auto rounded-[4px] border border-(--ui-stroke-tertiary)">
      <table className="min-w-full border-collapse text-[0.75rem] leading-5">
        <thead className="sticky top-0 bg-(--ui-bg-quinary) text-(--ui-text-tertiary)">
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
    </div>
  )
}
