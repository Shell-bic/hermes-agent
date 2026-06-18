import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ChatMessage, textPart } from '@/lib/chat-messages'
import type { WorkspaceObject } from '@/lib/workspace-events'

import { type PrimaryView, PrimaryViewToggle } from '../primary-view-toggle'

import { WorkspaceConversationRenderer, WorkspaceView } from '.'

const rawRunObject = (id: string, title: string): WorkspaceObject => ({
  created_at: '2026-06-17T00:00:00.000Z',
  debug_refs: [],
  id,
  object_type: 'run',
  run_kind: 'tool_call',
  schema_version: 'workspace-object.v2',
  source_event_ids: [`event:${id}`],
  status: 'done',
  title,
  updated_at: '2026-06-17T00:00:00.000Z'
})

const runBlock = {
  id: 'block:run:terminal',
  kind: 'RUN',
  inputs: { command: 'npm test' },
  outputs: { exit_code: 0 },
  run_kind: 'tool_activity',
  status: 'done',
  summary: '2 terminal calls completed',
  title: 'Terminal activity',
  tool_activity: [
    { name: 'terminal', status: 'done' },
    { name: 'terminal', status: 'done' }
  ],
  updated_at: '2026-06-17T00:00:04.000Z'
}

const noteBlock = {
  body: 'Build failed because lint reported an error.',
  id: 'block:note:error',
  kind: 'NOTE',
  note_kind: 'error',
  status: 'error',
  title: 'Lint failure',
  updated_at: '2026-06-17T00:00:03.000Z'
}

const topicBlock = {
  bullets: ['Use projected blocks', 'Keep raw data in Events'],
  id: 'block:topic:plan',
  kind: 'TOPIC',
  status: 'active',
  thesis: 'Workspace should read as a DSL workbench.',
  title: 'Workbench plan',
  updated_at: '2026-06-17T00:00:02.000Z'
}

const listBlock = {
  id: 'block:list:steps',
  items: [
    { content: 'Project objects', id: 'plan:1', source_object_id: 'trace:plan', status: 'pending' },
    { content: 'Render block cards', id: 'plan:2', source_object_id: 'trace:plan', status: 'completed' }
  ],
  kind: 'LIST',
  list_kind: 'plan',
  status: 'new',
  summary: { completed: 1, pending: 1, total: 2 },
  title: 'Steps',
  updated_at: '2026-06-17T00:00:01.000Z'
}

const workspaceBlocks = [runBlock, noteBlock, topicBlock, listBlock] as never

const longMarkdown =
  '# Deep Heading\n\n' +
  'This note starts with useful product context and should remain readable in the canvas preview.\n\n' +
  Array.from({ length: 40 }, (_, index) => `- Implementation detail ${index + 1} with markdown and extra words`).join(
    '\n'
  ) +
  '\n\nFINAL_UNTRUNCATED_SENTINEL'

const longNoteBlock = {
  body: longMarkdown,
  id: 'block:note:long',
  kind: 'NOTE',
  status: 'done',
  title: '# Deep Heading ' + Array.from({ length: 12 }, () => 'with extra title text').join(' '),
  updated_at: '2026-06-17T00:00:05.000Z'
}

const duplicatedDetailBlock = {
  body: 'The same detail should appear once in the right panel, not as both summary and body.',
  id: 'block:note:duplicate',
  kind: 'NOTE',
  status: 'done',
  summary: 'The same detail should appear once in the right panel, not as both summary and body.',
  title: 'Deduped detail',
  updated_at: '2026-06-17T00:00:06.000Z'
}

const confirmationBlock = {
  actions: [],
  created_at: '2026-06-17T00:00:07.000Z',
  debug_refs: [],
  id: 'block:list:confirmations',
  items: [
    {
      actions: [
        {
          id: 'approve:approval-1',
          kind: 'approve',
          label: 'Approve',
          metadata: { decision_kind: 'approval', request_id: 'approval-1', session_id: 'session-1' }
        },
        {
          id: 'reject:approval-1',
          kind: 'reject',
          label: 'Reject',
          metadata: { decision_kind: 'approval', request_id: 'approval-1', session_id: 'session-1' }
        }
      ],
      content: 'Approval required: npm publish',
      id: 'block:item:confirmation:approval-1',
      source_object_id: 'session:session-1:decision:approval-1',
      source_ref: 'approval-1',
      status: 'pending'
    },
    {
      actions: [
        {
          id: 'approve:approval-2',
          kind: 'approve',
          label: 'Approve resolved',
          metadata: { decision_kind: 'approval', request_id: 'approval-2', session_id: 'session-1' }
        },
        {
          id: 'reject:approval-2',
          kind: 'reject',
          label: 'Reject resolved',
          metadata: { decision_kind: 'approval', request_id: 'approval-2', session_id: 'session-1' }
        }
      ],
      content: 'Resolved approval: pnpm lint',
      id: 'block:item:confirmation:approval-2',
      source_object_id: 'session:session-1:decision:approval-2',
      source_ref: 'approval-2',
      status: 'completed'
    }
  ],
  list_kind: 'confirmations',
  source_event_ids: ['event:approval-1'],
  source_object_ids: ['session:session-1:decision:approval-1'],
  status: 'waiting',
  summary: { completed: 1, pending: 1, total: 2 },
  title: 'Confirmations waiting',
  type: 'LIST',
  updated_at: '2026-06-17T00:00:07.000Z'
}

const activeRunBlock = {
  ...runBlock,
  id: 'block:run:active',
  status: 'active',
  summary: 'Running model turn',
  title: 'Active run',
  updated_at: '2026-06-17T00:00:09.000Z'
}

const findingsBlock = {
  ...topicBlock,
  id: 'block:topic:findings',
  state: 'decided',
  title: 'Findings',
  topic_kind: 'findings',
  updated_at: '2026-06-17T00:00:08.000Z'
}

const summaryBlock = {
  body: 'The session finished with a short summary preview.',
  id: 'block:note:summary',
  kind: 'NOTE',
  note_kind: 'summary',
  status: 'done',
  title: 'Summary',
  updated_at: '2026-06-17T00:00:07.000Z'
}

const inactiveApprovalBlock = {
  actions: [
    { id: 'approve:block', kind: 'approve', label: 'Approve block' },
    { id: 'reject:block', kind: 'reject', label: 'Reject block' }
  ],
  id: 'block:note:old-approval',
  kind: 'NOTE',
  status: 'done',
  summary: 'Resolved approval',
  title: 'Resolved approval',
  updated_at: '2026-06-17T00:00:00.000Z'
}

afterEach(() => {
  cleanup()
})

describe('WorkspaceView', () => {
  it('renders an empty workspace without selecting an undefined block', () => {
    render(<WorkspaceView blocks={[]} objects={[]} />)

    expect(screen.getByText('No workspace blocks yet')).toBeTruthy()
    expect(screen.getByText('Start a conversation to populate the workspace')).toBeTruthy()
    expect(screen.getByText('Select an artifact')).toBeTruthy()
  })

  it('renders a projected RUN block instead of duplicate raw terminal cards', () => {
    render(
      <WorkspaceView
        blocks={[runBlock] as never}
        objects={[
          rawRunObject('session:s1:run:tool:terminal-1', 'Raw terminal object 1'),
          rawRunObject('session:s1:run:tool:terminal-2', 'Raw terminal object 2')
        ]}
      />
    )

    expect(screen.getAllByText('Terminal activity').length).toBeGreaterThan(0)
    expect(screen.getAllByText('2 terminal calls completed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Tool activity').length).toBeGreaterThan(0)
    expect(screen.queryByText(/"exit_code"/)).toBeNull()
    expect(screen.queryByText('Raw terminal object 1')).toBeNull()
    expect(screen.queryByText('Raw terminal object 2')).toBeNull()
  })

  it('renders NOTE, TOPIC, LIST, and RUN block bodies', () => {
    render(<WorkspaceView blocks={workspaceBlocks} objects={[]} />)

    expect(screen.getAllByText('Lint failure').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Build failed because lint reported an error.').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Workbench plan').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Workspace should read as a DSL workbench.').length).toBeGreaterThan(0)
    expect(screen.getByText('Use projected blocks')).toBeTruthy()
    expect(screen.getAllByText('Steps').length).toBeGreaterThan(0)
    expect(screen.getByText('Project objects')).toBeTruthy()
    expect(screen.getByText('completed')).toBeTruthy()
    expect(screen.getAllByText('Terminal activity').length).toBeGreaterThan(0)
    expect(screen.getByText('2 terminal calls completed')).toBeTruthy()
  })

  it('orders the canvas for pending confirmations, active run, answer outputs, findings, then plan', () => {
    const { container } = render(
      <WorkspaceView
        blocks={[summaryBlock, findingsBlock, listBlock, activeRunBlock, confirmationBlock] as never}
        objects={[]}
      />
    )

    const ids = [...container.querySelectorAll('[data-workspace-artifact-card]')].map(card =>
      card.getAttribute('data-workspace-source-block')
    )

    expect(ids.slice(0, 5)).toEqual([
      'block:list:confirmations',
      'block:run:active',
      'block:note:summary',
      'block:topic:findings',
      'block:list:steps'
    ])
  })

  it('renders typed detail fields for list, topic, note, and run blocks', () => {
    render(<WorkspaceView blocks={[listBlock, findingsBlock, summaryBlock, runBlock] as never} objects={[]} />)

    fireEvent.click(screen.getAllByText('Steps')[0])
    expect(screen.getByText('List kind')).toBeTruthy()
    expect(screen.getAllByText('plan').length).toBeGreaterThan(0)

    fireEvent.click(screen.getAllByText('Findings')[0])
    expect(screen.getByText('Topic kind')).toBeTruthy()
    expect(screen.getAllByText('findings').length).toBeGreaterThan(0)

    fireEvent.click(screen.getAllByText('Summary')[0])
    expect(screen.getByText('Note kind')).toBeTruthy()
    expect(screen.getByText('summary')).toBeTruthy()

    fireEvent.click(screen.getAllByText('Terminal activity')[0])
    expect(screen.getByText('Run kind')).toBeTruthy()
    expect(screen.getAllByText('tool_activity').length).toBeGreaterThan(0)
  })

  it('keeps raw event JSON out of detail until Events mode is selected', () => {
    render(
      <WorkspaceView
        blocks={[noteBlock] as never}
        objects={[]}
        rawEvents={[
          {
            id: 'event:secret',
            payload: { body: 'secret raw event body' },
            receivedAt: 1,
            sessionId: 's1',
            type: 'debug.event'
          }
        ]}
      />
    )

    expect(screen.queryByText(/secret raw event body/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /events/i }))

    expect(screen.getByText(/secret raw event body/)).toBeTruthy()
  })

  it('keeps debug references collapsed by default', () => {
    render(
      <WorkspaceView
        blocks={
          [
            {
              ...noteBlock,
              source_event_ids: ['event:debug-ref']
            }
          ] as never
        }
        objects={[]}
      />
    )

    const debug = screen.getByText('Debug').closest('details')

    expect(debug?.hasAttribute('open')).toBe(false)
  })

  it('shows selected long markdown in the main canvas reading area', () => {
    const { container } = render(<WorkspaceView blocks={[longNoteBlock] as never} objects={[]} />)
    const card = container.querySelector('[data-workspace-source-block="block:note:long"]') as HTMLElement
    const scrollRegion = container.querySelector('[data-artifact-card-scroll]') as HTMLElement

    expect(screen.getAllByText(/Deep Heading/).length).toBeGreaterThan(0)
    expect(card.getAttribute('data-artifact-card-variant')).toBe('expanded')
    expect(scrollRegion.className).toContain('overflow-auto')
    expect(within(card).getByText(/FINAL_UNTRUNCATED_SENTINEL/)).toBeTruthy()
  })

  it('deduplicates repeated summary and body text in detail', () => {
    render(<WorkspaceView blocks={[duplicatedDetailBlock] as never} objects={[]} />)
    const detail = screen.getAllByText('Detail')[0]?.closest('aside')

    expect(screen.getByText('Body')).toBeTruthy()
    expect(
      within(detail as HTMLElement).getAllByText(
        'The same detail should appear once in the right panel, not as both summary and body.'
      ).length
    ).toBeGreaterThan(0)
  })

  it('can switch from chat to DSL chat through the primary view toggle', () => {
    function Harness() {
      const [view, setView] = useState<PrimaryView>('chat')
      const toggle = <PrimaryViewToggle onChange={setView} value={view} />

      return view === 'chat' ? (
        <div>
          {toggle}
          <p>Chat surface</p>
        </div>
      ) : (
        <WorkspaceView blocks={[runBlock] as never} objects={[]} primaryViewToggle={toggle} />
      )
    }

    render(<Harness />)

    expect(screen.getByText('Chat surface')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /dsl chat/i }))

    expect(screen.queryByText('Chat surface')).toBeNull()
    expect(screen.getAllByText('Terminal activity').length).toBeGreaterThan(0)
  })

  it('defaults to DSL chat and can switch back to chat through the primary view toggle', () => {
    function Harness() {
      const [view, setView] = useState<PrimaryView>('dsl')
      const toggle = <PrimaryViewToggle onChange={setView} value={view} />

      return view === 'dsl' ? (
        <WorkspaceView blocks={[runBlock] as never} objects={[]} primaryViewToggle={toggle} />
      ) : (
        <div>
          {toggle}
          <p>Chat surface</p>
        </div>
      )
    }

    render(<Harness />)

    expect(screen.getAllByText('Terminal activity').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /^chat$/i }))

    expect(screen.getByText('Chat surface')).toBeTruthy()
  })

  it('fires the pending confirmation action callback from artifact detail approve and reject buttons', () => {
    const onBlockAction = vi.fn()

    render(
      <WorkspaceView
        blocks={[confirmationBlock, inactiveApprovalBlock] as never}
        objects={[]}
        onBlockAction={onBlockAction}
      />
    )

    expect(screen.queryByRole('button', { name: 'Approve resolved' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject resolved' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve block' })).toBeNull()

    const detail = screen.getAllByText('Detail')[0]?.closest('aside') as HTMLElement

    fireEvent.click(within(detail).getByRole('button', { name: 'Approve' }))
    fireEvent.click(within(detail).getByRole('button', { name: 'Reject' }))

    expect(onBlockAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: 'approve', metadata: expect.objectContaining({ session_id: 'session-1' }) }),
      expect.objectContaining({ id: 'block:list:confirmations' })
    )
    expect(onBlockAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: 'reject', metadata: expect.objectContaining({ session_id: 'session-1' }) }),
      expect.objectContaining({ id: 'block:list:confirmations' })
    )
  })

  it('syncs artifact selection back to its source block and shows artifact detail first', () => {
    const onSelectBlock = vi.fn()
    const { container } = render(
      <WorkspaceConversationRenderer
        blocks={[listBlock, runBlock] as never}
        objects={[]}
        onSelectBlock={onSelectBlock}
      />
    )

    const terminalArtifact = container.querySelector(
      '[data-workspace-source-block="block:run:terminal"]'
    ) as HTMLElement

    fireEvent.click(terminalArtifact)

    expect(onSelectBlock).toHaveBeenCalledWith('block:run:terminal')
    expect(screen.getByText('Source block')).toBeTruthy()
    expect(screen.getAllByText('block:run:terminal').length).toBeGreaterThan(0)
    expect(screen.getByText('Artifact kind')).toBeTruthy()
    expect(screen.getAllByText('run').length).toBeGreaterThan(0)
  })

  it('exposes an embeddable renderer without header or composer and shows compact transcript', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', parts: [textPart('Please inspect the workspace blocks.')], role: 'user' },
      { id: 'm2', parts: [textPart('I found a projected plan block.')], role: 'assistant' }
    ]

    render(
      <WorkspaceConversationRenderer
        blocks={[listBlock] as never}
        messages={messages}
        objects={[]}
        rawEvents={[
          {
            id: 'event:debug-only',
            payload: { body: 'debug-only raw payload' },
            type: 'debug.event'
          }
        ]}
      />
    )

    expect(screen.queryByRole('button', { name: /chat/i })).toBeNull()
    expect(screen.queryByText('Composer shell')).toBeNull()
    expect(screen.getAllByText('Steps').length).toBeGreaterThan(0)
    expect(screen.queryByText(/debug-only raw payload/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /transcript/i }))

    expect(screen.getAllByText('Please inspect the workspace blocks.').length).toBeGreaterThan(0)
    expect(screen.getAllByText('I found a projected plan block.').length).toBeGreaterThan(0)
  })

  it('projects the task card from the current session latest user message only', () => {
    const { rerender } = render(
      <WorkspaceConversationRenderer
        blocks={[]}
        messages={[
          { id: 'old-session-user', parts: [textPart('OLD_SESSION_TASK_SHOULD_NOT_RENDER')], role: 'user' },
          { id: 'old-session-assistant', parts: [textPart('old answer')], role: 'assistant' }
        ]}
        objects={[]}
      />
    )

    expect(screen.getAllByText('OLD_SESSION_TASK_SHOULD_NOT_RENDER').length).toBeGreaterThan(0)

    rerender(
      <WorkspaceConversationRenderer
        blocks={[]}
        messages={[
          { id: 'new-session-assistant', parts: [textPart('new answer')], role: 'assistant' },
          { id: 'new-session-user', parts: [textPart('NEW_SESSION_CURRENT_TASK')], role: 'user' }
        ]}
        objects={[]}
      />
    )

    expect(screen.getAllByText('NEW_SESSION_CURRENT_TASK').length).toBeGreaterThan(0)
    expect(screen.queryByText('OLD_SESSION_TASK_SHOULD_NOT_RENDER')).toBeNull()
  })

  it('defaults to the assistant answer for user and assistant messages while keeping task context visible', () => {
    const userPrompt = 'USER_PROMPT_CONTEXT_SENTINEL: summarize the workspace changes.'
    const assistantAnswer = 'ASSISTANT_ANSWER_SENTINEL: The workspace now prioritizes the answer artifact.'
    const { container } = render(
      <WorkspaceConversationRenderer
        blocks={[]}
        messages={[
          { id: 'm1', parts: [textPart(userPrompt)], role: 'user', timestamp: 1000 },
          { id: 'm2', parts: [textPart(assistantAnswer)], role: 'assistant', timestamp: 2000 }
        ]}
        objects={[]}
      />
    )

    const selected = container.querySelector('[data-artifact-card-variant="expanded"]') as HTMLElement
    const detail = screen.getAllByText('Detail')[0]?.closest('aside') as HTMLElement

    expect(within(selected).getByText(/Answer/)).toBeTruthy()
    expect(selected.getAttribute('data-artifact-card-emphasis')).toBe('answer')
    expect(within(detail).getByText(/Answer/)).toBeTruthy()
    expect(within(detail).getAllByText(assistantAnswer).length).toBeGreaterThan(0)
    expect(within(detail).getByText('User context')).toBeTruthy()
    expect(within(detail).getByText(userPrompt)).toBeTruthy()

    fireEvent.click(screen.getByLabelText(/Current task|User context/))

    expect(within(detail).getByText(/Current task|User context/)).toBeTruthy()
    expect(within(detail).getAllByText(userPrompt).length).toBeGreaterThan(0)
  })

  it('renders markdown, table, and code assistant answer detail readably', () => {
    const { container, rerender } = render(
      <WorkspaceConversationRenderer
        blocks={[]}
        messages={[
          { id: 'm1', parts: [textPart('show a markdown answer')], role: 'user' },
          { id: 'm2', parts: [textPart('# Markdown Answer\n\nMARKDOWN_ANSWER_SENTINEL')], role: 'assistant' }
        ]}
        objects={[]}
      />
    )

    let detail = screen.getAllByText('Detail')[0]?.closest('aside') as HTMLElement

    expect(within(detail).getAllByText(/MARKDOWN_ANSWER_SENTINEL/).length).toBeGreaterThan(0)

    rerender(
      <WorkspaceConversationRenderer
        blocks={[]}
        messages={[
          { id: 'm1', parts: [textPart('show a table answer')], role: 'user' },
          {
            id: 'm2',
            parts: [textPart('| File | Result |\n| --- | --- |\n| workspace/index.tsx | TABLE_ANSWER_SENTINEL |')],
            role: 'assistant'
          }
        ]}
        objects={[]}
      />
    )

    detail = screen.getAllByText('Detail')[0]?.closest('aside') as HTMLElement
    expect(within(detail).getByRole('table')).toBeTruthy()
    expect(within(detail).getByText('TABLE_ANSWER_SENTINEL')).toBeTruthy()

    rerender(
      <WorkspaceConversationRenderer
        blocks={[]}
        messages={[
          { id: 'm1', parts: [textPart('show a code answer')], role: 'user' },
          { id: 'm2', parts: [textPart('```ts\nconst value = "CODE_ANSWER_SENTINEL"\n```')], role: 'assistant' }
        ]}
        objects={[]}
      />
    )

    detail = screen.getAllByText('Detail')[0]?.closest('aside') as HTMLElement
    expect(within(detail).getAllByText(/CODE_ANSWER_SENTINEL/).length).toBeGreaterThan(0)
    expect(container.querySelector('[data-artifact-card-emphasis="answer"]')).toBeTruthy()
  })

  it('renders assistant replies as the primary artifact when chat has no workspace blocks', () => {
    const messages: ChatMessage[] = [
      { id: 'user-1', parts: [textPart('LATEST_USER_INPUT_CONTEXT')], role: 'user', timestamp: 1000 },
      {
        id: 'assistant-1',
        parts: [textPart('PRIMARY_ASSISTANT_REPLY_CANVAS_CONTENT')],
        role: 'assistant',
        timestamp: 2000
      },
      { id: 'user-2', parts: [textPart('NEWER_USER_FOLLOWUP_CONTEXT')], role: 'user', timestamp: 3000 }
    ]

    const { container } = render(<WorkspaceConversationRenderer blocks={[]} messages={messages} objects={[]} />)

    const assistantCard = container.querySelector(
      '[data-artifact-card="artifact:assistant:assistant-1"]'
    ) as HTMLElement
    const userContextCard = container.querySelector('[data-artifact-card="artifact:task:user-2"]') as HTMLElement
    const detail = screen.getAllByText('Detail')[0]?.closest('aside') as HTMLElement

    expect(assistantCard).toBeTruthy()
    expect(assistantCard.getAttribute('data-artifact-card-variant')).toBe('expanded')
    expect(within(assistantCard).getByText('PRIMARY_ASSISTANT_REPLY_CANVAS_CONTENT')).toBeTruthy()
    expect(userContextCard.getAttribute('data-artifact-card-variant')).toBe('compact')
    expect(within(detail).getAllByText('PRIMARY_ASSISTANT_REPLY_CANVAS_CONTENT').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /transcript/i }))

    expect(screen.getByText('LATEST_USER_INPUT_CONTEXT')).toBeTruthy()
    expect(screen.getAllByText('NEWER_USER_FOLLOWUP_CONTEXT').length).toBeGreaterThan(0)
  })

  it('renders assistant markdown tables and code fences as main canvas previews', () => {
    const tableMessages: ChatMessage[] = [
      { id: 'user-table', parts: [textPart('Summarize files')], role: 'user', timestamp: 1000 },
      {
        id: 'assistant-table',
        parts: [textPart('| File | Status |\n| --- | --- |\n| dsl-chat.tsx | rendered |')],
        role: 'assistant',
        timestamp: 2000
      }
    ]
    const codeMessages: ChatMessage[] = [
      { id: 'user-code', parts: [textPart('Show code')], role: 'user', timestamp: 1000 },
      {
        id: 'assistant-code',
        parts: [textPart('```ts\nexport const answer = true\n```')],
        role: 'assistant',
        timestamp: 2000
      }
    ]

    const { container, rerender } = render(
      <WorkspaceConversationRenderer blocks={[]} messages={tableMessages} objects={[]} />
    )
    const tableCard = container.querySelector(
      '[data-artifact-card="artifact:assistant:assistant-table"]'
    ) as HTMLElement

    expect(within(tableCard).getByRole('table')).toBeTruthy()
    expect(within(tableCard).getByText('File')).toBeTruthy()
    expect(within(tableCard).getByText('dsl-chat.tsx')).toBeTruthy()
    expect(within(tableCard).queryByText('| File | Status |')).toBeNull()

    rerender(<WorkspaceConversationRenderer blocks={[]} messages={codeMessages} objects={[]} />)

    const codeCard = container.querySelector('[data-artifact-card="artifact:assistant:assistant-code"]') as HTMLElement

    expect(within(codeCard).getByText(/export const answer = true/)).toBeTruthy()
    expect(within(codeCard).queryByText(/```ts/)).toBeNull()
  })

  it('keeps the complete assistant answer in detail after selecting the answer artifact', () => {
    const fullAnswer =
      'ANSWER_DETAIL_START ' +
      Array.from({ length: 30 }, (_, index) => `Complete answer sentence ${index + 1}.`).join(' ') +
      ' ANSWER_DETAIL_SENTINEL'
    const messages: ChatMessage[] = [
      { id: 'user-answer', parts: [textPart('Please explain')], role: 'user', timestamp: 1000 },
      { id: 'assistant-answer', parts: [textPart(fullAnswer)], role: 'assistant', timestamp: 2000 }
    ]

    const { container } = render(<WorkspaceConversationRenderer blocks={[]} messages={messages} objects={[]} />)
    const assistantCard = container.querySelector(
      '[data-artifact-card="artifact:assistant:assistant-answer"]'
    ) as HTMLElement

    fireEvent.click(assistantCard)

    const detail = screen.getAllByText('Detail')[0]?.closest('aside') as HTMLElement

    expect(within(assistantCard).getByText(/ANSWER_DETAIL_SENTINEL/)).toBeTruthy()
    expect(within(detail).getAllByText(fullAnswer).length).toBeGreaterThan(0)
  })

  it('switches artifact track selection and updates the right detail panel', () => {
    const firstBlock = {
      ...summaryBlock,
      body: 'FIRST_ARTIFACT_DETAIL',
      id: 'block:note:first',
      title: 'First artifact',
      updated_at: '2026-06-17T00:00:11.000Z'
    }
    const secondBlock = {
      ...summaryBlock,
      body: 'SECOND_ARTIFACT_DETAIL',
      id: 'block:note:second',
      title: 'Second artifact',
      updated_at: '2026-06-17T00:00:10.000Z'
    }

    const { container } = render(
      <WorkspaceConversationRenderer blocks={[firstBlock, secondBlock] as never} objects={[]} />
    )

    const detail = screen.getAllByText('Detail')[0]?.closest('aside') as HTMLElement

    expect(within(detail).getAllByText('FIRST_ARTIFACT_DETAIL').length).toBeGreaterThan(0)

    fireEvent.click(container.querySelector('[data-workspace-source-block="block:note:second"]') as HTMLElement)

    expect(within(detail).getAllByText('SECOND_ARTIFACT_DETAIL').length).toBeGreaterThan(0)
    expect(within(detail).queryByText('FIRST_ARTIFACT_DETAIL')).toBeNull()
  })

  it('renders table artifacts as table previews in the artifact track', () => {
    const tableArtifactBlock = {
      body: '| File | Status |\n| --- | --- |\n| dsl-chat.tsx | current-session |',
      id: 'block:note:artifact:table',
      kind: 'NOTE',
      note_kind: 'artifact',
      status: 'done',
      title: 'Session table artifact',
      updated_at: '2026-06-17T00:00:12.000Z'
    }

    const { container } = render(<WorkspaceView blocks={[tableArtifactBlock] as never} objects={[]} />)
    const tableCard = container.querySelector(
      '[data-workspace-source-block="block:note:artifact:table"]'
    ) as HTMLElement

    expect(within(tableCard).getByRole('table')).toBeTruthy()
    expect(within(tableCard).getByText('File')).toBeTruthy()
    expect(within(tableCard).getByText('dsl-chat.tsx')).toBeTruthy()
    expect(within(tableCard).queryByText('| File | Status |')).toBeNull()
  })

  it('allows compact cards to truncate before selection while detail keeps the complete note body after selection', () => {
    const fullBody =
      'This compact card should show the beginning of the content. ' +
      Array.from({ length: 30 }, (_, index) => `Detail sentence ${index + 1}.`).join(' ') +
      ' COMPLETE_DETAIL_SENTINEL'
    const completeDetailBlock = {
      ...summaryBlock,
      body: fullBody,
      id: 'block:note:complete-detail',
      title: 'Complete detail note',
      updated_at: '2026-06-17T00:00:13.000Z'
    }
    const initiallySelectedBlock = {
      ...summaryBlock,
      body: 'Initially selected newer note.',
      id: 'block:note:initially-selected',
      title: 'Initially selected note',
      updated_at: '2026-06-17T00:00:14.000Z'
    }

    const { container } = render(
      <WorkspaceView blocks={[completeDetailBlock, initiallySelectedBlock] as never} objects={[]} />
    )

    const card = container.querySelector('[data-workspace-source-block="block:note:complete-detail"]') as HTMLElement
    const detail = screen.getAllByText('Detail')[0]?.closest('aside') as HTMLElement

    expect(within(card).queryByText(/COMPLETE_DETAIL_SENTINEL/)).toBeNull()
    fireEvent.click(card)

    expect(within(card).getByText(/COMPLETE_DETAIL_SENTINEL/)).toBeTruthy()
    expect(within(detail).getAllByText(fullBody).length).toBeGreaterThan(0)
  })
})
