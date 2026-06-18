import { describe, expect, it } from 'vitest'

import { textPart, type ChatMessage } from './chat-messages'
import { projectWorkspaceToCanvasArtifacts } from './workspace-artifacts'
import type {
  WorkspaceBlock,
  WorkspaceListBlock,
  WorkspaceNoteBlock,
  WorkspaceRunBlock,
  WorkspaceTopicBlock
} from './workspace-blocks'

const baseTime = '2026-06-17T00:00:00.000Z'

function listBlock(overrides: Partial<WorkspaceListBlock>): WorkspaceListBlock {
  return {
    actions: [],
    created_at: baseTime,
    debug_refs: [],
    id: 'block:list:plan',
    items: [],
    list_kind: 'plan',
    source_event_ids: [],
    source_object_ids: [],
    status: 'done',
    summary: { completed: 0, pending: 0, total: 0 },
    title: 'Plan',
    type: 'LIST',
    updated_at: baseTime,
    ...overrides
  }
}

function runBlock(overrides: Partial<WorkspaceRunBlock>): WorkspaceRunBlock {
  return {
    actions: [],
    created_at: baseTime,
    debug_refs: [],
    id: 'block:run:agent',
    run_kind: 'agent_turn',
    source_event_ids: [],
    source_object_ids: [],
    status: 'done',
    title: 'Assistant turn',
    type: 'RUN',
    updated_at: baseTime,
    ...overrides
  }
}

function topicBlock(overrides: Partial<WorkspaceTopicBlock>): WorkspaceTopicBlock {
  return {
    actions: [],
    bullets: [],
    created_at: baseTime,
    debug_refs: [],
    id: 'block:topic:findings',
    source_event_ids: [],
    source_object_ids: [],
    state: 'decided',
    title: 'Findings',
    topic_kind: 'findings',
    type: 'TOPIC',
    updated_at: baseTime,
    ...overrides
  }
}

function noteBlock(overrides: Partial<WorkspaceNoteBlock>): WorkspaceNoteBlock {
  return {
    actions: [],
    body: '',
    created_at: baseTime,
    debug_refs: [],
    id: 'block:note:summary',
    note_kind: 'summary',
    source_event_ids: [],
    source_object_ids: [],
    status: 'done',
    title: 'Summary',
    type: 'NOTE',
    updated_at: baseTime,
    ...overrides
  }
}

describe('workspace artifact projection', () => {
  it('projects the latest user message into a task artifact', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', parts: [textPart('older task')], role: 'user', timestamp: 1000 },
      { id: 'm3', parts: [textPart('ship the canvas')], role: 'user', timestamp: 3000 }
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts([], messages)

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      content: 'ship the canvas',
      id: 'artifact:task:m3',
      kind: 'task',
      renderer: 'task',
      status: 'done',
      title: 'Current task'
    })
  })

  it('projects the latest assistant message before the user context artifact', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', parts: [textPart('Build a report card')], role: 'user', timestamp: 1000 },
      {
        id: 'm2',
        parts: [textPart('## Report card\n\n- Revenue is up\n- Churn is flat')],
        role: 'assistant',
        timestamp: 2000
      }
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts([], messages)

    expect(artifacts.map(artifact => artifact.id)).toEqual(['artifact:assistant:m2', 'artifact:task:m1'])
    expect(artifacts[0]).toMatchObject({
      content: '## Report card\n\n- Revenue is up\n- Churn is flat',
      kind: 'artifact',
      renderer: 'markdown',
      title: 'Answer'
    })
    expect(artifacts[1]).toMatchObject({
      content: 'Build a report card',
      kind: 'context',
      renderer: 'task',
      title: 'User context'
    })
  })

  it('keeps a newer user follow-up from becoming the primary chat artifact', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', parts: [textPart('Build a report card')], role: 'user', timestamp: 1000 },
      { id: 'm2', parts: [textPart('PRIMARY_ASSISTANT_ANSWER')], role: 'assistant', timestamp: 2000 },
      { id: 'm3', parts: [textPart('LATEST_USER_FOLLOWUP')], role: 'user', timestamp: 3000 }
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts([], messages)

    expect(artifacts.map(artifact => artifact.id)).toEqual(['artifact:assistant:m2', 'artifact:task:m3'])
    expect(artifacts[0]).toMatchObject({ content: 'PRIMARY_ASSISTANT_ANSWER', kind: 'artifact' })
    expect(artifacts[1]).toMatchObject({ content: 'LATEST_USER_FOLLOWUP', kind: 'context', title: 'User context' })
  })

  it('projects pure chat messages into main canvas content without workspace blocks', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', parts: [textPart('What changed?')], role: 'user', timestamp: 1000 },
      {
        id: 'm2',
        parts: [textPart('The projection now renders assistant replies into canvas artifacts.')],
        role: 'assistant',
        timestamp: 2000
      }
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts([], messages)

    expect(artifacts).toHaveLength(2)
    expect(artifacts[0]).toMatchObject({
      id: 'artifact:assistant:m2',
      kind: 'artifact',
      renderer: 'markdown',
      title: 'Answer'
    })
  })

  it('keeps complete long assistant replies in artifact content while summary stays compact', () => {
    const content = [
      '## Implementation notes',
      '',
      'Opening: the canvas should show the full answer, not just a preview.',
      '',
      'Middle: this paragraph includes enough detail to move past a compact summary boundary. '.repeat(5).trim(),
      '',
      '- Keep the assistant artifact readable as markdown.',
      '- Keep list content inside the same complete response.',
      '',
      'Ending: FINAL_SENTINEL_FULL_REPLY_VISIBLE'
    ].join('\n')
    const messages: ChatMessage[] = [
      { id: 'm1', parts: [textPart('Explain the change')], role: 'user', timestamp: 1000 },
      { id: 'm2', parts: [textPart(content)], role: 'assistant', timestamp: 2000 }
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts([], messages)

    expect(artifacts[0]).toMatchObject({
      id: 'artifact:assistant:m2',
      content,
      renderer: 'markdown',
      title: 'Answer'
    })
    expect(artifacts[0]?.content).toContain('Opening: the canvas should show the full answer')
    expect(artifacts[0]?.content).toContain('Middle: this paragraph includes enough detail')
    expect(artifacts[0]?.content).toContain('Ending: FINAL_SENTINEL_FULL_REPLY_VISIBLE')
    expect(artifacts[0]?.summary).not.toContain('FINAL_SENTINEL_FULL_REPLY_VISIBLE')
    expect(artifacts[1]).toMatchObject({
      content: 'Explain the change',
      kind: 'context',
      renderer: 'task',
      title: 'User context'
    })
  })

  it('keeps long headed markdown assistant replies as one primary answer artifact', () => {
    const content = [
      'Opening context before the sections remains part of the full Answer artifact.',
      '',
      '## Architecture',
      '',
      'The canvas projection keeps the complete assistant answer and then fans out major sections. '.repeat(4).trim(),
      '',
      'Architecture section ending: ARCHITECTURE_SECTION_TAIL',
      '',
      '## Implementation',
      '',
      'Implementation details explain the artifact IDs, renderer choice, and status inheritance. '.repeat(4).trim(),
      '',
      '```ts',
      'const headingInsideCode = "## Not a heading"',
      '```',
      '',
      '## Verification',
      '',
      'Verification captures the behaviors that should keep working as the DSL canvas grows. '.repeat(4).trim(),
      '',
      'Verification section ending: VERIFICATION_SECTION_TAIL'
    ].join('\n')
    const messages: ChatMessage[] = [
      { id: 'm1', parts: [textPart('Summarize the work')], role: 'user', timestamp: 1000 },
      { id: 'm2', parts: [textPart(content)], role: 'assistant', timestamp: 2000 }
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts([], messages)

    expect(artifacts.map(artifact => artifact.id)).toEqual(['artifact:assistant:m2', 'artifact:task:m1'])
    expect(artifacts[0]).toMatchObject({
      content,
      kind: 'artifact',
      renderer: 'markdown',
      title: 'Answer'
    })
    expect(artifacts[0]?.content).toContain('Architecture section ending: ARCHITECTURE_SECTION_TAIL')
    expect(artifacts[0]?.content).toContain('const headingInsideCode = "## Not a heading"')
    expect(artifacts[0]?.content).toContain('Verification section ending: VERIFICATION_SECTION_TAIL')
    expect(artifacts[1]).toMatchObject({
      content: 'Summarize the work',
      kind: 'context',
      title: 'User context'
    })
  })

  it('does not split short headed markdown assistant replies', () => {
    const content = [
      '## One',
      '',
      'Short.',
      '',
      '## Two',
      '',
      'Also short.',
      '',
      '## Three',
      '',
      'Still short.'
    ].join('\n')
    const messages: ChatMessage[] = [
      { id: 'm1', parts: [textPart('Keep it brief')], role: 'user', timestamp: 1000 },
      { id: 'm2', parts: [textPart(content)], role: 'assistant', timestamp: 2000 }
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts([], messages)

    expect(artifacts.map(artifact => artifact.id)).toEqual(['artifact:assistant:m2', 'artifact:task:m1'])
  })

  it('does not count headings inside code fences when splitting assistant markdown', () => {
    const content = [
      '## Real section',
      '',
      'This answer is long enough to split if code-fenced headings were counted. '.repeat(8).trim(),
      '',
      '```md',
      '## Fake section one',
      '',
      '### Fake section two',
      '',
      '## Fake section three',
      '```',
      '',
      'More prose after the fenced sample keeps the answer comfortably over the split threshold. '.repeat(4).trim()
    ].join('\n')
    const messages: ChatMessage[] = [
      { id: 'm1', parts: [textPart('Explain fenced headings')], role: 'user', timestamp: 1000 },
      { id: 'm2', parts: [textPart(content)], role: 'assistant', timestamp: 2000 }
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts([], messages)

    expect(artifacts.map(artifact => artifact.id)).toEqual(['artifact:assistant:m2', 'artifact:task:m1'])
    expect(artifacts[0]).toMatchObject({
      content,
      title: 'Answer'
    })
  })

  it('keeps streaming assistant content complete as the active answer artifact', () => {
    const content = [
      'Start: live answer has begun.',
      '',
      'Still streaming through the middle of a detailed response. '.repeat(5).trim(),
      '',
      'Tail: STREAMING_SENTINEL_VISIBLE'
    ].join('\n')
    const messages: ChatMessage[] = [
      { id: 'm1', parts: [textPart('Stream this answer')], role: 'user', timestamp: 1000 },
      { id: 'm2', parts: [textPart(content)], pending: true, role: 'assistant', timestamp: 2000 }
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts([], messages)

    expect(artifacts[0]).toMatchObject({
      content,
      id: 'artifact:assistant:m2',
      renderer: 'markdown',
      status: 'active'
    })
    expect(artifacts[0]?.content).toContain('Tail: STREAMING_SENTINEL_VISIBLE')
    expect(artifacts[0]?.summary).not.toContain('STREAMING_SENTINEL_VISIBLE')
  })

  it('projects markdown tables from assistant replies as table artifacts', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', parts: [textPart('Summarize files')], role: 'user', timestamp: 1000 },
      {
        id: 'm2',
        parts: [textPart('| File | Status |\n| --- | --- |\n| workspace-artifacts.ts | changed |')],
        role: 'assistant',
        timestamp: 2000
      }
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts([], messages)

    expect(artifacts[0]).toMatchObject({
      id: 'artifact:assistant:m2',
      kind: 'artifact',
      renderer: 'table'
    })
  })

  it('projects fenced code from assistant replies as code artifacts', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', parts: [textPart('Show the helper')], role: 'user', timestamp: 1000 },
      {
        id: 'm2',
        parts: [textPart('```ts\nexport const ready = true\n```')],
        role: 'assistant',
        timestamp: 2000
      }
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts([], messages)

    expect(artifacts[0]).toMatchObject({
      id: 'artifact:assistant:m2',
      kind: 'artifact',
      renderer: 'code'
    })
  })

  it('projects pending confirmations first and preserves approve and deny actions', () => {
    const blocks: WorkspaceBlock[] = [
      listBlock({
        id: 'block:list:plan',
        items: [{ content: 'Implement projection', id: 'plan-1', source_object_id: 'obj-plan', status: 'pending' }],
        list_kind: 'plan',
        summary: { completed: 0, pending: 1, total: 1 },
        updated_at: '2026-06-17T00:03:00.000Z'
      }),
      listBlock({
        id: 'block:list:confirmations',
        items: [
          {
            actions: [
              { id: 'approve:req-1', kind: 'approve', label: 'Approve' },
              { id: 'reject:req-1', kind: 'reject', label: 'Deny' }
            ],
            content: 'Run tests?',
            id: 'confirm-1',
            source_object_id: 'obj-confirm',
            status: 'pending'
          }
        ],
        list_kind: 'confirmations',
        source_event_ids: ['event-confirm'],
        source_object_ids: ['obj-confirm'],
        status: 'waiting',
        summary: { completed: 0, pending: 1, total: 1 },
        title: 'Confirmations waiting',
        updated_at: '2026-06-17T00:02:00.000Z'
      })
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts(blocks)

    expect(artifacts.map(artifact => artifact.kind)).toEqual(['confirmation', 'plan'])
    expect(artifacts[0]).toMatchObject({
      content: '- [ ] Run tests?',
      renderer: 'checklist',
      sourceBlockId: 'block:list:confirmations',
      sourceEventIds: ['event-confirm'],
      status: 'pending'
    })
    expect(artifacts[0]?.actions.map(action => action.kind)).toEqual(['approve', 'reject'])
  })

  it('projects plan, run timeline, findings outline, summary, artifact, and error outputs', () => {
    const blocks: WorkspaceBlock[] = [
      listBlock({
        id: 'block:list:plan',
        items: [
          { content: 'Inspect blocks', id: 'plan-1', source_object_id: 'obj-plan', status: 'completed' },
          { content: 'Project artifacts', id: 'plan-2', source_object_id: 'obj-plan', status: 'pending' }
        ],
        list_kind: 'plan',
        summary: { completed: 1, pending: 1, total: 2 }
      }),
      runBlock({
        id: 'block:run:tools',
        outputs: [
          {
            label: 'terminal',
            value_preview: 'npm test produced a compact summary'
          }
        ],
        progress: { phase: 'running tests' },
        run_kind: 'tool_activity',
        source_object_ids: ['obj-run'],
        status: 'active'
      }),
      topicBlock({
        bullets: [{ id: 'finding-1', text: 'Canvas artifacts can stay independent from UI.' }],
        source_object_ids: ['obj-findings'],
        thesis: 'Projection is ready',
        topic_kind: 'findings'
      }),
      noteBlock({
        body: 'The workspace projection is now summarized.',
        id: 'block:note:summary',
        note_kind: 'summary'
      }),
      noteBlock({
        body: '| File | Status |\n| --- | --- |\n| workspace-artifacts.ts | added |',
        id: 'block:note:artifact:table',
        note_kind: 'artifact'
      }),
      noteBlock({
        body: 'Hermes reported an error',
        id: 'block:note:error',
        note_kind: 'error',
        status: 'error'
      })
    ]

    const artifacts = projectWorkspaceToCanvasArtifacts(blocks)

    expect(artifacts.map(artifact => artifact.kind)).toEqual(['run', 'plan', 'findings', 'output', 'artifact', 'error'])
    expect(artifacts.find(artifact => artifact.kind === 'plan')).toMatchObject({
      content: '- [x] Inspect blocks\n- [ ] Project artifacts',
      renderer: 'checklist'
    })
    const runArtifact = artifacts.find(artifact => artifact.kind === 'run')

    expect(runArtifact).not.toHaveProperty('content')
    expect(runArtifact).toMatchObject({
      entries: [
        { label: 'Assistant turn', status: 'active', summary: 'running tests' },
        { label: 'terminal', status: 'active', summary: 'npm test produced a compact summary' }
      ],
      renderer: 'timeline'
    })
    expect(artifacts.find(artifact => artifact.kind === 'findings')).toMatchObject({
      content: '- Canvas artifacts can stay independent from UI.',
      renderer: 'outline',
      summary: 'Projection is ready'
    })
    expect(artifacts.find(artifact => artifact.kind === 'output')).toMatchObject({ renderer: 'markdown' })
    expect(artifacts.find(artifact => artifact.kind === 'artifact')).toMatchObject({ renderer: 'table' })
    expect(artifacts.find(artifact => artifact.kind === 'error')).toMatchObject({
      content: 'Hermes reported an error',
      renderer: 'markdown',
      status: 'error'
    })
  })

  it('detects fenced code artifacts as code previews', () => {
    const artifacts = projectWorkspaceToCanvasArtifacts([
      noteBlock({
        body: '```ts\nexport const ready = true\n```',
        id: 'block:note:artifact:code',
        note_kind: 'artifact'
      })
    ])

    expect(artifacts[0]).toMatchObject({
      kind: 'artifact',
      renderer: 'code'
    })
  })
})
