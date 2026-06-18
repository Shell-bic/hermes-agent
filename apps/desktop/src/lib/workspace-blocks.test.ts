import { describe, expect, it } from 'vitest'

import {
  applyGatewayEventToWorkspace,
  createInitialWorkspaceEventState,
  type WorkspaceEventCompilerState,
  type WorkspaceGatewayEvent,
  type WorkspaceObject,
  type WorkspaceRunObject
} from './workspace-events'
import {
  HERMES_ASSISTANT_MARKDOWN,
  HERMES_SUBAGENT_REPORT,
  hermesDslWorkbenchEvents
} from './__fixtures__/workspace-hermes-session'
import {
  projectWorkspaceObjectsToBlocks,
  type WorkspaceBlock,
  type WorkspaceListBlock,
  type WorkspaceNoteBlock,
  type WorkspaceRunBlock,
  type WorkspaceTopicBlock
} from './workspace-blocks'

function replay(events: WorkspaceGatewayEvent[]): WorkspaceEventCompilerState {
  return events.reduce(
    (state, event) =>
      applyGatewayEventToWorkspace(state, event, { activeSessionId: 's1', nowIso: '2026-06-17T00:00:00.000Z' }),
    createInitialWorkspaceEventState()
  )
}

function project(events: WorkspaceGatewayEvent[]): WorkspaceBlock[] {
  return projectWorkspaceObjectsToBlocks(replay(events).objects)
}

function isNoteBlock(block: WorkspaceBlock): block is WorkspaceNoteBlock {
  return block.type === 'NOTE'
}

function isListBlock(block: WorkspaceBlock): block is WorkspaceListBlock {
  return block.type === 'LIST'
}

function isTopicBlock(block: WorkspaceBlock): block is WorkspaceTopicBlock {
  return block.type === 'TOPIC'
}

function isRunBlock(block: WorkspaceBlock): block is WorkspaceRunBlock {
  return block.type === 'RUN'
}

describe('workspace block projection', () => {
  it('aggregates terminal and tool events into one tool activity run per agent turn', () => {
    const blocks = project([
      { event_id: 'turn-start', session_id: 's1', type: 'message.start' },
      {
        event_id: 'tool-1-start',
        payload: { args: { command: 'npm test' }, name: 'terminal', tool_id: 'tc1' },
        session_id: 's1',
        type: 'tool.start'
      },
      {
        event_id: 'tool-1-generating',
        payload: { name: 'terminal', preview: 'generating report', tool_id: 'tc1' },
        session_id: 's1',
        type: 'tool.generating'
      },
      {
        event_id: 'tool-1-complete',
        payload: { duration_s: 2, name: 'terminal', result: { exit_code: 0 }, tool_id: 'tc1' },
        session_id: 's1',
        type: 'tool.complete'
      },
      {
        event_id: 'tool-2-start',
        payload: { args: { pattern: 'WorkspaceBlock' }, name: 'rg', tool_id: 'tc2' },
        session_id: 's1',
        type: 'tool.start'
      },
      {
        event_id: 'tool-2-complete',
        payload: { duration_s: 1, name: 'rg', summary: 'found matches', tool_id: 'tc2' },
        session_id: 's1',
        type: 'tool.complete'
      }
    ])

    const agentRuns = blocks.filter(block => block.type === 'RUN' && block.run_kind === 'agent_turn')
    const toolActivities = blocks.filter(block => block.type === 'RUN' && block.run_kind === 'tool_activity')

    expect(agentRuns).toHaveLength(1)
    expect(toolActivities).toHaveLength(1)
    expect(toolActivities[0]).toMatchObject({
      child_run_ids: ['session:s1:run:tool:tc1', 'session:s1:run:tool:tc2'],
      id: 'block:run:tool_activity:session:s1:run:agent_turn:turn-1',
      status: 'done',
      title: 'Tool activity (2)'
    })
    expect(toolActivities[0]?.source_event_ids).toEqual([
      'tool-1-complete',
      'tool-1-generating',
      'tool-1-start',
      'tool-2-complete',
      'tool-2-start'
    ])
  })

  it('dedupes assistant output and summarizes reasoning into one topic', () => {
    const blocks = project([
      { event_id: 'turn-start', session_id: 's1', type: 'message.start' },
      { event_id: 'assistant-1', payload: { text: 'Done ' }, session_id: 's1', type: 'message.delta' },
      { event_id: 'assistant-2', payload: { text: 'now.' }, session_id: 's1', type: 'message.delta' },
      {
        event_id: 'reasoning-short',
        payload: { text: 'Check files.' },
        session_id: 's1',
        type: 'reasoning.delta'
      },
      {
        event_id: 'reasoning-long',
        payload: { text: 'Check files. Then project semantic objects into compact workspace blocks.' },
        session_id: 's1',
        type: 'reasoning.available'
      },
      { event_id: 'turn-complete', payload: { text: 'Done now.' }, session_id: 's1', type: 'message.complete' }
    ])

    const summaryNotes = blocks.filter(isNoteBlock).filter(block => block.note_kind === 'summary')
    const reasoningTopics = blocks.filter(isTopicBlock).filter(block => block.topic_kind === 'reasoning')

    expect(summaryNotes).toHaveLength(1)
    expect(summaryNotes[0]?.body).toBe('Done now.')
    expect(summaryNotes[0]?.source_event_ids).toEqual(['assistant-1', 'assistant-2', 'turn-complete', 'turn-start'])
    expect(
      blocks.find((block): block is WorkspaceRunBlock => isRunBlock(block) && block.run_kind === 'agent_turn')?.outputs
    ).toBeUndefined()
    expect(reasoningTopics).toHaveLength(1)
    expect(reasoningTopics[0]?.bullets).toHaveLength(1)
    expect(reasoningTopics[0]?.bullets[0]?.text).toContain('compact workspace blocks')
  })

  it('keeps agent runs as status blocks when complete output carries the assistant text', () => {
    const longMarkdown = [
      '# Implementation report',
      '',
      'Changed the projection so run blocks stay compact and assistant results render once as notes.',
      '',
      '- Removed long output from run outputs.',
      '- Preserved source ids for debug inspection.'
    ].join('\n')
    const blocks = project([
      { event_id: 'turn-start', session_id: 's1', type: 'message.start' },
      { event_id: 'turn-complete', payload: { text: longMarkdown }, session_id: 's1', type: 'message.complete' }
    ])
    const agentRun = blocks.find(
      (block): block is WorkspaceRunBlock => isRunBlock(block) && block.run_kind === 'agent_turn'
    )
    const summaryNotes = blocks.filter(isNoteBlock).filter(block => block.note_kind === 'summary')
    const findings = blocks.filter(isTopicBlock).filter(block => block.topic_kind === 'findings')

    expect(agentRun?.outputs).toBeUndefined()
    expect(summaryNotes).toHaveLength(1)
    expect(summaryNotes[0]?.body).toBe(
      'Changed the projection so run blocks stay compact and assistant results render once as notes.'
    )
    expect(summaryNotes[0]?.source_event_ids).toEqual(['turn-complete', 'turn-start'])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.bullets.map(bullet => bullet.text)).toEqual([
      'Removed long output from run outputs.',
      'Preserved source ids for debug inspection.'
    ])
  })

  it('projects long subagent results as result notes without using markdown as the run title', () => {
    const longSummary = [
      '# Worker findings',
      '',
      'The desktop workbench should present the delegated analysis as a separate result instead of putting it inside the run status.',
      '',
      '- The run title remains compact.',
      '- The result body remains inspectable from source ids.'
    ].join('\n')
    const blocks = project([
      { event_id: 'turn-start', session_id: 's1', type: 'message.start' },
      {
        event_id: 'subagent-progress',
        payload: { subagent_id: 'worker-a', summary: longSummary },
        session_id: 's1',
        type: 'subagent.progress'
      },
      {
        event_id: 'subagent-complete',
        payload: { result: longSummary, subagent_id: 'worker-a', summary: longSummary },
        session_id: 's1',
        type: 'subagent.complete'
      }
    ])
    const subagentRun = blocks.find(block => block.type === 'RUN' && block.run_kind === 'subagent')
    const resultTopics = blocks.filter(isTopicBlock).filter(block => block.topic_kind === 'findings')

    expect(subagentRun).toMatchObject({
      outputs: undefined,
      status: 'done',
      title: 'Subagent'
    })
    expect(resultTopics).toHaveLength(1)
    expect(resultTopics[0]?.thesis).toContain('delegated analysis')
    expect(resultTopics[0]?.source_event_ids).toEqual(['subagent-complete', 'subagent-progress'])
  })

  it('splits structured assistant markdown into plan, findings, artifact, and summary blocks', () => {
    const structuredMarkdown = [
      '## Workspace projection update',
      '',
      'The projection now turns final assistant markdown into workspace-native blocks.',
      '',
      '### Plan',
      '',
      '- Inspect existing block projection.',
      '- Add semantic markdown splitting.',
      '',
      '### Findings',
      '',
      '- Long final markdown stays out of RUN outputs.',
      '- Source references remain attached to every projected block.',
      '',
      '```ts',
      'export const noteKind = "artifact"',
      '```'
    ].join('\n')
    const blocks = project([
      { event_id: 'turn-start', session_id: 's1', type: 'message.start' },
      { event_id: 'assistant-delta', payload: { text: structuredMarkdown }, session_id: 's1', type: 'message.delta' },
      { event_id: 'turn-complete', payload: { text: structuredMarkdown }, session_id: 's1', type: 'message.complete' }
    ])
    const plan = blocks.find((block): block is WorkspaceListBlock => isListBlock(block) && block.list_kind === 'plan')
    const findings = blocks.find(
      (block): block is WorkspaceTopicBlock => isTopicBlock(block) && block.topic_kind === 'findings'
    )
    const summary = blocks.find(
      (block): block is WorkspaceNoteBlock => isNoteBlock(block) && block.note_kind === 'summary'
    )
    const artifact = blocks.find(
      (block): block is WorkspaceNoteBlock => isNoteBlock(block) && block.note_kind === 'artifact'
    )
    const agentRun = blocks.find(
      (block): block is WorkspaceRunBlock => isRunBlock(block) && block.run_kind === 'agent_turn'
    )

    expect(agentRun?.outputs).toBeUndefined()
    expect(plan?.items.map(item => item.content)).toEqual([
      'Inspect existing block projection.',
      'Add semantic markdown splitting.'
    ])
    expect(findings?.bullets.map(bullet => bullet.text)).toEqual([
      'Long final markdown stays out of RUN outputs.',
      'Source references remain attached to every projected block.'
    ])
    expect(summary?.body).toBe('The projection now turns final assistant markdown into workspace-native blocks.')
    expect(artifact?.body).toBe('export const noteKind = "artifact"')

    for (const block of [plan, findings, summary, artifact]) {
      expect(block?.source_event_ids).toEqual(['assistant-delta', 'turn-complete', 'turn-start'])
      expect(block?.debug_refs).toEqual(
        expect.arrayContaining([
          { id: 'assistant-delta', kind: 'gateway_event' },
          { id: 'turn-complete', kind: 'gateway_event' }
        ])
      )
    }
  })

  it('suppresses reasoning topics when reasoning repeats the final answer', () => {
    const finalText = [
      '## Findings',
      '',
      '- Project plan lists from assistant markdown.',
      '- Preserve source_event_ids and debug refs on semantic blocks.'
    ].join('\n')
    const blocks = project([
      { event_id: 'turn-start', session_id: 's1', type: 'message.start' },
      {
        event_id: 'reasoning-available',
        payload: {
          text: 'Findings: Project plan lists from assistant markdown. Preserve source_event_ids and debug refs on semantic blocks.'
        },
        session_id: 's1',
        type: 'reasoning.available'
      },
      { event_id: 'turn-complete', payload: { text: finalText }, session_id: 's1', type: 'message.complete' }
    ])

    expect(blocks.filter(isTopicBlock).filter(block => block.topic_kind === 'reasoning')).toHaveLength(0)
    expect(blocks.filter(isTopicBlock).filter(block => block.topic_kind === 'findings')).toHaveLength(1)
  })

  it('treats older active tool updates as done when the same activity later completes', () => {
    const state = replay([{ event_id: 'turn-start', session_id: 's1', type: 'message.start' }])
    const activeDelegate: WorkspaceRunObject = {
      created_at: '2026-06-17T00:00:01.000Z',
      debug_refs: [{ id: 'delegate-generating', kind: 'gateway_event' }],
      id: 'session:s1:run:tool:delegate_task:generating',
      object_type: 'run',
      parent_id: 'session:s1:run:agent_turn:turn-1',
      parent_type: 'run',
      progress: { phase: 'generating' },
      result_view: { preview: 'generating' },
      run_kind: 'tool_call',
      runtime: { session_id: 's1' },
      schema_version: 'workspace-object.v2',
      source_event_ids: ['delegate-generating'],
      started_at: '2026-06-17T00:00:01.000Z',
      status: 'active',
      title: 'delegate_task',
      updated_at: '2026-06-17T00:00:01.000Z'
    }
    const completeDelegate: WorkspaceRunObject = {
      ...activeDelegate,
      completed_at: '2026-06-17T00:00:03.000Z',
      debug_refs: [{ id: 'delegate-complete', kind: 'gateway_event' }],
      id: 'session:s1:run:tool:delegate_task:complete',
      progress: { duration_s: 2, phase: 'complete' },
      result_view: { summary: 'complete' },
      source_event_ids: ['delegate-complete'],
      status: 'done',
      updated_at: '2026-06-17T00:00:03.000Z'
    }
    const blocks = projectWorkspaceObjectsToBlocks({
      ...state.objects,
      [activeDelegate.id]: activeDelegate,
      [completeDelegate.id]: completeDelegate
    })
    const toolActivity = blocks.find(block => block.type === 'RUN' && block.run_kind === 'tool_activity')

    expect(toolActivity).toMatchObject({
      child_run_ids: ['session:s1:run:tool:delegate_task:complete'],
      status: 'done'
    })
  })

  it('projects requested and resolved decisions as a confirmations list with pending actions', () => {
    const blocks = project([
      { event_id: 'turn-start', session_id: 's1', type: 'message.start' },
      {
        event_id: 'approval-request',
        payload: { command: 'npm install', description: 'Install deps', request_id: 'approval-1' },
        session_id: 's1',
        type: 'approval.request'
      },
      {
        event_id: 'clarify-request',
        payload: { choices: ['red', 'blue'], question: 'Pick a color', request_id: 'clarify-1' },
        session_id: 's1',
        type: 'clarify.request'
      },
      {
        event_id: 'approval-resolved',
        payload: { request_id: 'approval-1' },
        session_id: 's1',
        type: 'approval.resolved'
      }
    ])

    const confirmations = blocks.filter(isListBlock).find(block => block.list_kind === 'confirmations')

    expect(confirmations).toMatchObject({
      summary: { completed: 1, pending: 1, total: 2 },
      status: 'waiting',
      type: 'LIST'
    })
    expect(confirmations?.items.map(item => [item.source_ref, item.status])).toEqual([
      ['approval-1', 'completed'],
      ['clarify-1', 'pending']
    ])
    expect(confirmations?.items[1]?.actions?.map(action => action.kind)).toEqual(['approve', 'reject', 'answer'])
    expect(confirmations?.items[1]?.actions?.map(action => action.metadata)).toEqual([
      expect.objectContaining({ decision_kind: 'clarification', request_id: 'clarify-1', session_id: 's1' }),
      expect.objectContaining({ decision_kind: 'clarification', request_id: 'clarify-1', session_id: 's1' }),
      expect.objectContaining({ decision_kind: 'clarification', request_id: 'clarify-1', session_id: 's1' })
    ])
    expect(blocks[0]?.id).toBe(confirmations?.id)
  })

  it('projects error traces and error runs as high-priority error notes', () => {
    const state = replay([
      { event_id: 'turn-start', session_id: 's1', type: 'message.start' },
      { event_id: 'error-event', payload: { message: 'Tool exploded' }, session_id: 's1', type: 'error' }
    ])
    const failedRun: WorkspaceRunObject = {
      created_at: '2026-06-17T00:00:01.000Z',
      debug_refs: [{ id: 'run-debug', kind: 'run' }],
      id: 'session:s1:run:tool:failed-direct',
      object_type: 'run',
      parent_id: 'session:s1:run:agent_turn:turn-1',
      parent_type: 'run',
      progress: { phase: 'error' },
      result_view: { error: 'Direct run failed' },
      run_kind: 'tool_call',
      runtime: { session_id: 's1', tool_call_id: 'failed-direct' },
      schema_version: 'workspace-object.v2',
      source_event_ids: ['failed-run-event'],
      started_at: '2026-06-17T00:00:01.000Z',
      status: 'error',
      title: 'terminal',
      updated_at: '2026-06-17T00:00:02.000Z'
    }
    const blocks = projectWorkspaceObjectsToBlocks({ ...state.objects, [failedRun.id]: failedRun })
    const errorNotes = blocks.filter(isNoteBlock).filter(block => block.note_kind === 'error')

    expect(errorNotes).toHaveLength(1)
    expect(errorNotes[0]).toMatchObject({
      body: 'Tool exploded\n\nDirect run failed',
      priority: 'high',
      severity: 'error',
      status: 'error'
    })
    expect(errorNotes[0]?.source_event_ids).toEqual(['error-event', 'failed-run-event', 'turn-start'])
  })

  it('is stable when replaying the same workspace objects', () => {
    const events: WorkspaceGatewayEvent[] = [
      { event_id: 'turn-start', session_id: 's1', type: 'message.start' },
      { event_id: 'assistant-1', payload: { text: 'Stable projection' }, session_id: 's1', type: 'message.delta' },
      { event_id: 'tool-start', payload: { name: 'terminal', tool_id: 'tc1' }, session_id: 's1', type: 'tool.start' },
      {
        event_id: 'tool-complete',
        payload: { name: 'terminal', tool_id: 'tc1' },
        session_id: 's1',
        type: 'tool.complete'
      },
      {
        event_id: 'approval-request',
        payload: { command: 'deploy', request_id: 'approval-1' },
        session_id: 's1',
        type: 'approval.request'
      }
    ]
    const first = projectWorkspaceObjectsToBlocks(replay(events).objects)
    const second = projectWorkspaceObjectsToBlocks(Object.values(replay(events).objects).reverse() as WorkspaceObject[])

    expect(first).toEqual(second)
    expect(first.map(block => block.id)).toEqual([
      expect.stringMatching(/^block:list:confirmations:/),
      'block:run:agent_turn:session:s1:run:agent_turn:turn-1',
      'block:run:tool_activity:session:s1:run:agent_turn:turn-1',
      'block:note:summary:session:s1:run:agent_turn:turn-1'
    ])
  })

  it('projects the real-ish Hermes DSL Workbench session into compact regression blocks', () => {
    const blocks = project(hermesDslWorkbenchEvents)
    const summaryNotes = blocks
      .filter(isNoteBlock)
      .filter(
        block =>
          block.note_kind === 'summary' &&
          block.body.includes('The desktop workbench should show the assistant answer once')
      )
    const assistantFindings = blocks.filter(isTopicBlock).filter(block => block.topic_kind === 'findings')
    const runs = blocks.filter(isRunBlock)
    const agentRuns = runs.filter(block => block.run_kind === 'agent_turn')
    const subagentRuns = runs.filter(block => block.run_kind === 'subagent')
    const toolActivities = runs.filter(block => block.run_kind === 'tool_activity')
    const subagentReportBlocks = blocks.filter(
      block =>
        (block.type === 'NOTE' && block.body.includes('giant RUN title')) ||
        (block.type === 'TOPIC' &&
          (block.thesis?.includes('giant RUN title') ||
            block.bullets.some(bullet => bullet.text.includes('giant RUN title'))))
    )
    const serializedRunText = JSON.stringify(runs)
    const serializedCanvasText = JSON.stringify(blocks)
    const subagentRunOutputValues = subagentRuns.flatMap(
      block => block.outputs?.map(output => output.value_preview) ?? []
    )

    expect(summaryNotes).toHaveLength(1)
    expect(summaryNotes[0]?.source_event_ids).toEqual(
      expect.arrayContaining([
        'evt-message-complete',
        'evt-message-delta-1',
        'evt-message-delta-2',
        'evt-message-start'
      ])
    )
    expect(
      assistantFindings.some(block =>
        block.bullets.some(bullet => bullet.text.includes('Assistant turn and assistant response'))
      )
    ).toBe(true)
    expect(serializedCanvasText.match(/DSL Workbench regression notes/g)).toBeNull()
    expect(agentRuns).toHaveLength(1)
    expect(agentRuns[0]).toMatchObject({ status: 'done', title: 'Assistant turn' })
    expect(serializedRunText).not.toContain(HERMES_ASSISTANT_MARKDOWN)
    expect(toolActivities).toHaveLength(1)
    expect(toolActivities[0]).toMatchObject({
      child_run_ids: [
        'session:20260617_100956_e4feed:run:tool:tool-terminal-1',
        'session:20260617_100956_e4feed:run:tool:tool-delegate-1'
      ],
      progress: { phase: 'complete' },
      status: 'done'
    })
    expect(subagentRuns).toHaveLength(1)
    expect(subagentRuns[0]).toMatchObject({ progress: { phase: 'complete' }, status: 'done' })
    expect(subagentRuns[0]?.title.length).toBeLessThan(80)
    expect(subagentRuns[0]?.title).not.toContain('Worker C regression summary')
    expect(subagentRunOutputValues).not.toContain(HERMES_SUBAGENT_REPORT)
    expect(subagentReportBlocks).toHaveLength(1)
    expect(subagentReportBlocks[0]?.source_event_ids).toContain('evt-subagent-complete')
    expect(subagentReportBlocks[0]?.debug_refs).toEqual(
      expect.arrayContaining([{ id: 'evt-subagent-complete', kind: 'gateway_event' }])
    )
  })
})
