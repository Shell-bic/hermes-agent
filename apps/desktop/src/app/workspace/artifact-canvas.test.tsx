import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ArtifactCanvas, type WorkspaceArtifact } from './artifact-canvas'

const longMarkdown =
  '# Release Plan\n\n' +
  Array.from({ length: 32 }, (_, index) => `- Detailed implementation note ${index + 1}`).join('\n') +
  '\n\nFINAL_UNTRUNCATED_SENTINEL'

const structuredMarkdown =
  '# Rendered answer\n\n' +
  'Intro paragraph with `inline value` included.\n\n' +
  '## Steps\n\n' +
  '- First bullet\n' +
  '- Second bullet\n\n' +
  '1. Numbered one\n' +
  '2. Numbered two\n\n' +
  '```ts\n' +
  'const blockValue = "rendered fence"\n' +
  '```\n\n' +
  'Closing paragraph.'

const artifacts: WorkspaceArtifact[] = [
  {
    actions: [{ id: 'approve:publish', kind: 'approve', label: 'Approve' }],
    id: 'artifact:checklist',
    items: [
      { id: 'step:1', status: 'completed', title: 'Build package' },
      {
        actions: [{ id: 'confirm:publish', kind: 'confirm', label: 'Confirm' }],
        id: 'step:2',
        status: 'pending',
        title: 'Confirm publish'
      }
    ],
    status: 'waiting',
    summary: '1 pending approval',
    title: 'Release checklist',
    type: 'checklist'
  },
  {
    id: 'artifact:timeline',
    items: [
      { id: 'event:1', time: '09:00', title: 'Started turn' },
      { id: 'event:2', time: '09:04', title: 'Rendered artifacts' }
    ],
    title: 'Session timeline',
    type: 'timeline'
  },
  {
    id: 'artifact:outline',
    items: [
      { id: 'outline:1', title: 'Problem' },
      { id: 'outline:2', title: 'Approach' }
    ],
    title: 'Answer outline',
    type: 'outline'
  },
  {
    id: 'artifact:markdown',
    markdown: longMarkdown,
    title: 'Markdown note',
    type: 'markdown'
  },
  {
    id: 'artifact:structured-markdown',
    markdown: structuredMarkdown,
    title: 'Structured markdown',
    type: 'markdown'
  },
  {
    columns: [
      { key: 'file', label: 'File' },
      { key: 'status', label: 'Status' },
      { key: 'notes', label: 'Notes' }
    ],
    id: 'artifact:table',
    rows: [
      { file: 'artifact-canvas.tsx', notes: 'new renderer', status: 'added' },
      {
        file: 'artifact-canvas.test.tsx',
        notes:
          'coverage for selected artifact detail with enough extra words to stay compact in cards TABLE_UNTRUNCATED_SENTINEL',
        status: 'added'
      }
    ],
    title: 'Changed files',
    type: 'table'
  },
  {
    code:
      'export function example() {\n' +
      '  const message = "artifact renderer"\n' +
      '  const details = "' +
      Array.from({ length: 20 }, (_, index) => `segment-${index + 1}`).join(' ') +
      ' CODE_UNTRUNCATED_SENTINEL"\n' +
      '  return `${message}: ${details}`\n' +
      '}',
    id: 'artifact:code',
    language: 'ts',
    title: 'Code sample',
    type: 'code'
  }
]

afterEach(() => {
  cleanup()
})

describe('ArtifactCanvas', () => {
  it('renders a horizontal artifact track with all supported renderer types', () => {
    const { container } = render(<ArtifactCanvas artifacts={artifacts} selectedArtifactId="artifact:checklist" />)

    expect(container.querySelector('[data-artifact-track]')).toBeTruthy()
    expect(screen.getAllByText('Release checklist').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Session timeline').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Answer outline').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Markdown note').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Changed files').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Code sample').length).toBeGreaterThan(0)
    expect(screen.getAllByText('checklist').length).toBeGreaterThan(0)
    expect(screen.getAllByText('timeline').length).toBeGreaterThan(0)
    expect(screen.getAllByText('outline').length).toBeGreaterThan(0)
    expect(screen.getAllByText('markdown').length).toBeGreaterThan(0)
    expect(screen.getAllByText('table').length).toBeGreaterThan(0)
    expect(screen.getAllByText('code').length).toBeGreaterThan(0)
  })

  it('selects cards and marks the selected card as expanded while others stay compact', () => {
    const onSelectArtifact = vi.fn()

    const { container } = render(
      <ArtifactCanvas
        artifacts={artifacts}
        onSelectArtifact={onSelectArtifact}
        selectedArtifactId="artifact:markdown"
      />
    )

    const selected = container.querySelector('[data-artifact-card="artifact:markdown"]')
    const compact = container.querySelector('[data-artifact-card="artifact:checklist"]')

    expect(selected?.getAttribute('data-artifact-card-variant')).toBe('expanded')
    expect(compact?.getAttribute('data-artifact-card-variant')).toBe('compact')

    fireEvent.click(screen.getByLabelText('Changed files'))

    expect(onSelectArtifact).toHaveBeenCalledWith('artifact:table')
  })

  it('visually treats task cards as context and answer cards as the primary artifact', () => {
    const taskArtifact: WorkspaceArtifact = {
      content: 'User input should stay available without becoming the main canvas focus.',
      id: 'artifact:task',
      title: 'Current task',
      type: 'task'
    }
    const answerArtifact: WorkspaceArtifact = {
      markdown: 'Assistant answer should receive the larger selected card treatment.',
      id: 'artifact:answer',
      title: 'Assistant answer',
      type: 'markdown'
    }

    const { container } = render(
      <ArtifactCanvas artifacts={[taskArtifact, answerArtifact]} selectedArtifactId="artifact:answer" />
    )

    const taskCard = container.querySelector('[data-artifact-card="artifact:task"]') as HTMLElement
    const answerCard = container.querySelector('[data-artifact-card="artifact:answer"]') as HTMLElement

    expect(taskCard.getAttribute('data-artifact-card-emphasis')).toBe('context')
    expect(answerCard.getAttribute('data-artifact-card-emphasis')).toBe('answer')
    expect(answerCard.getAttribute('data-artifact-card-variant')).toBe('expanded')
    expect(taskCard.getAttribute('data-artifact-card-variant')).toBe('compact')
    expect(answerCard.className).toContain('min-w-[42rem]')
    expect(answerCard.className).toContain('h-[clamp(24rem,68vh,42rem)]')
    expect(taskCard.className).toContain('min-w-56')
  })

  it('supports pointer dragging the horizontal artifact track without selecting a card', () => {
    const onSelectArtifact = vi.fn()
    const { container } = render(
      <ArtifactCanvas
        artifacts={artifacts}
        onSelectArtifact={onSelectArtifact}
        selectedArtifactId="artifact:checklist"
      />
    )
    const track = container.querySelector('[data-artifact-track]') as HTMLElement
    const tableCard = container.querySelector('[data-artifact-card="artifact:table"]') as HTMLElement

    track.scrollLeft = 40

    fireEvent.pointerDown(track, { button: 0, clientX: 220, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 120, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 120, pointerId: 1 })
    fireEvent.click(tableCard)

    expect(track.scrollLeft).toBe(140)
    expect(onSelectArtifact).not.toHaveBeenCalled()
  })

  it('keeps long markdown out of compact cards and turns the selected card into a reading pane', () => {
    const { container, rerender } = render(
      <ArtifactCanvas artifacts={artifacts} selectedArtifactId="artifact:checklist" />
    )
    let markdownCard = container.querySelector('[data-artifact-card="artifact:markdown"]') as HTMLElement

    expect(markdownCard.getAttribute('data-artifact-card-variant')).toBe('compact')
    expect(within(markdownCard).queryByText(/FINAL_UNTRUNCATED_SENTINEL/)).toBeNull()

    rerender(<ArtifactCanvas artifacts={artifacts} selectedArtifactId="artifact:markdown" />)

    markdownCard = container.querySelector('[data-artifact-card="artifact:markdown"]') as HTMLElement
    const detail = container.querySelector('[data-artifact-detail="artifact:markdown"]') as HTMLElement
    const scrollRegion = container.querySelector('[data-artifact-card-scroll="artifact:markdown"]') as HTMLElement

    expect(markdownCard.getAttribute('data-artifact-card-variant')).toBe('expanded')
    expect(scrollRegion.className).toContain('overflow-auto')
    expect(within(markdownCard).getByText(/Detailed implementation note 32/)).toBeTruthy()
    expect(within(markdownCard).getByText(/FINAL_UNTRUNCATED_SENTINEL/)).toBeTruthy()
    expect(within(detail).getByText('Detailed implementation note 1')).toBeTruthy()
    expect(within(detail).getByText(/FINAL_UNTRUNCATED_SENTINEL/)).toBeTruthy()
    expect(within(detail).getByRole('heading', { name: 'Release Plan' })).toBeTruthy()
    expect(within(detail).queryByText(/# Release Plan/)).toBeNull()
  })

  it('renders selected markdown answers as headings, lists, inline code, and fenced code blocks', () => {
    const { container } = render(
      <ArtifactCanvas artifacts={artifacts} selectedArtifactId="artifact:structured-markdown" />
    )

    const markdownCard = container.querySelector('[data-artifact-card="artifact:structured-markdown"]') as HTMLElement
    const detail = container.querySelector('[data-artifact-detail="artifact:structured-markdown"]') as HTMLElement
    const cardCodeBlocks = markdownCard.querySelectorAll('pre code')
    const detailCodeBlocks = detail.querySelectorAll('pre code')

    expect(within(markdownCard).getByRole('heading', { name: 'Rendered answer' })).toBeTruthy()
    expect(within(markdownCard).getByRole('heading', { name: 'Steps' })).toBeTruthy()
    expect(within(markdownCard).getByText('First bullet').closest('li')).toBeTruthy()
    expect(within(markdownCard).getByText('Numbered one').closest('li')).toBeTruthy()
    expect(within(markdownCard).getByText('inline value').tagName.toLowerCase()).toBe('code')
    expect(cardCodeBlocks.length).toBeGreaterThan(0)
    expect(cardCodeBlocks[0].textContent).toContain('const blockValue = "rendered fence"')
    expect(within(markdownCard).queryByText(/```/)).toBeNull()

    expect(within(detail).getByRole('heading', { name: 'Rendered answer' })).toBeTruthy()
    expect(within(detail).getByText('Second bullet').closest('li')).toBeTruthy()
    expect(detailCodeBlocks.length).toBeGreaterThan(0)
    expect(detailCodeBlocks[0].textContent).toContain('const blockValue = "rendered fence"')
    expect(within(detail).queryByText(/```/)).toBeNull()
  })

  it('keeps compact table and code cards truncated while selected cards keep readable full content', () => {
    const { container, rerender } = render(<ArtifactCanvas artifacts={artifacts} selectedArtifactId="artifact:table" />)
    const tableCard = container.querySelector('[data-artifact-card="artifact:table"]') as HTMLElement
    const tableDetail = container.querySelector('[data-artifact-detail="artifact:table"]') as HTMLElement
    const compactCodeCard = container.querySelector('[data-artifact-card="artifact:code"]') as HTMLElement

    expect(within(tableCard).getByText(/TABLE_UNTRUNCATED_SENTINEL/)).toBeTruthy()
    expect(within(tableDetail).getByText(/TABLE_UNTRUNCATED_SENTINEL/)).toBeTruthy()
    expect(within(compactCodeCard).queryByText(/CODE_UNTRUNCATED_SENTINEL/)).toBeNull()

    rerender(<ArtifactCanvas artifacts={artifacts} selectedArtifactId="artifact:code" />)

    const codeCard = container.querySelector('[data-artifact-card="artifact:code"]') as HTMLElement
    const codeDetail = container.querySelector('[data-artifact-detail="artifact:code"]') as HTMLElement

    expect(within(codeCard).getByText(/CODE_UNTRUNCATED_SENTINEL/)).toBeTruthy()
    expect(within(codeDetail).getByText(/CODE_UNTRUNCATED_SENTINEL/)).toBeTruthy()
  })

  it('calls the artifact action handler for confirmation buttons', () => {
    const onArtifactAction = vi.fn()

    render(
      <ArtifactCanvas
        artifacts={artifacts}
        onArtifactAction={onArtifactAction}
        selectedArtifactId="artifact:checklist"
      />
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(onArtifactAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'approve:publish', kind: 'approve' }),
      expect.objectContaining({ id: 'artifact:checklist' })
    )
    expect(onArtifactAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'confirm:publish', kind: 'confirm' }),
      expect.objectContaining({ id: 'artifact:checklist' })
    )
  })

  it('accepts projected artifacts with renderer, content, and entries fields', () => {
    render(
      <ArtifactCanvas
        artifacts={[
          {
            actions: [],
            content: '[ ] Review draft\n[x] Keep renderer compact',
            id: 'artifact:projected:checklist',
            renderer: 'checklist',
            status: 'pending',
            title: 'Projected checklist'
          },
          {
            actions: [],
            entries: [{ id: 'run:1', label: 'Terminal', status: 'done', summary: 'Terminal finished' }],
            id: 'artifact:projected:timeline',
            renderer: 'timeline',
            title: 'Projected timeline'
          }
        ]}
        selectedArtifactId="artifact:projected:timeline"
      />
    )

    expect(screen.getByText('Review draft')).toBeTruthy()
    expect(screen.getAllByText('Terminal').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Terminal finished').length).toBeGreaterThan(0)
  })
})
