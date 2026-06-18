import { describe, expect, it } from 'vitest'

import {
  applyGatewayEventToWorkspace,
  createInitialWorkspaceEventState,
  type WorkspaceEventCompilerState,
  type WorkspaceGatewayEvent,
  type WorkspaceRunObject
} from './workspace-events'
import { HERMES_SESSION_ID, HERMES_SUBAGENT_REPORT, hermesDslWorkbenchEvents } from './__fixtures__/workspace-hermes-session'

function replay(events: WorkspaceGatewayEvent[]): WorkspaceEventCompilerState {
  return events.reduce(
    (state, event) => applyGatewayEventToWorkspace(state, event, { activeSessionId: 's1', nowIso: '2026-06-17T00:00:00.000Z' }),
    createInitialWorkspaceEventState()
  )
}

describe('workspace event compiler', () => {
  it('replays gateway events deterministically without React state', () => {
    const events: WorkspaceGatewayEvent[] = [
      { payload: { cwd: '/repo', model: 'kimi-k2', provider: 'openai-compatible' }, session_id: 's1', type: 'session.info' },
      { session_id: 's1', type: 'message.start' },
      { payload: { text: 'hello ' }, session_id: 's1', type: 'message.delta' },
      { payload: { text: 'world' }, session_id: 's1', type: 'message.delta' },
      { payload: { text: 'hello world' }, session_id: 's1', type: 'message.complete' }
    ]

    expect(replay(events)).toEqual(replay(events))
    expect(Object.keys(replay(events).objects).sort()).toEqual([
      'session:s1',
      'session:s1:run:agent_turn:turn-1',
      'session:s1:run:agent_turn:turn-1:trace:text'
    ])
  })

  it('updates one tool run across start, progress, generating, and complete', () => {
    const state = replay([
      { session_id: 's1', type: 'message.start' },
      {
        payload: { args: { command: 'npm test' }, name: 'terminal', tool_id: 'tc1' },
        session_id: 's1',
        type: 'tool.start'
      },
      {
        payload: { message: 'running tests', name: 'terminal', tool_id: 'tc1' },
        session_id: 's1',
        type: 'tool.progress'
      },
      {
        payload: { name: 'terminal', preview: 'generating report', tool_id: 'tc1' },
        session_id: 's1',
        type: 'tool.generating'
      },
      {
        payload: { duration_s: 2, name: 'terminal', result: { exit_code: 0 }, tool_id: 'tc1' },
        session_id: 's1',
        type: 'tool.complete'
      }
    ])

    const tool = state.objects['session:s1:run:tool:tc1'] as WorkspaceRunObject

    expect(tool.status).toBe('done')
    expect(tool.parent_id).toBe('session:s1:run:agent_turn:turn-1')
    expect(tool.progress).toMatchObject({ duration_s: 2, phase: 'complete' })
    expect(tool.result_view?.args).toMatchObject({ command: 'npm test' })
    expect(tool.result_view?.result).toEqual({ exit_code: 0 })
  })

  it('keeps id-less delegate tool lifecycle in one run until completion', () => {
    const state = replay([
      { session_id: 's1', type: 'message.start' },
      {
        event_id: 'delegate-start',
        payload: { args: { prompt: 'Research DSL workbench projection' }, name: 'delegate_task' },
        session_id: 's1',
        type: 'tool.start'
      },
      {
        event_id: 'delegate-generating',
        payload: { name: 'delegate_task', preview: 'generating' },
        session_id: 's1',
        type: 'tool.generating'
      },
      {
        event_id: 'delegate-complete',
        payload: { duration_s: 3, name: 'delegate_task', summary: 'complete' },
        session_id: 's1',
        type: 'tool.complete'
      }
    ])

    const delegateRuns = Object.values(state.objects).filter(
      (object): object is WorkspaceRunObject =>
        object.object_type === 'run' && object.run_kind === 'tool_call' && object.title === 'delegate_task'
    )

    expect(delegateRuns).toHaveLength(1)
    expect(delegateRuns[0]).toMatchObject({
      id: 'session:s1:run:tool:delegate_task:1',
      progress: { duration_s: 3, phase: 'complete' },
      status: 'done'
    })
    expect(delegateRuns[0]?.source_event_ids).toEqual(['delegate-start', 'delegate-generating', 'delegate-complete'])
  })

  it('uses backend envelope ids, timestamps, and top-level tool call ids', () => {
    const state = replay([
      {
        event_id: 'evt-turn-start',
        run_id: 'run-backend-1',
        session_id: 's1',
        timestamp: '2026-06-17T01:00:00.000Z',
        turn_id: 'turn-backend-1',
        type: 'message.start'
      },
      {
        event_id: 'evt-tool-start',
        payload: { name: 'terminal', tool_id: 'payload-tool-id' },
        session_id: 's1',
        timestamp: '2026-06-17T01:00:01.000Z',
        tool_call_id: 'tc-envelope',
        type: 'tool.start'
      },
      {
        event_id: 'evt-turn-complete',
        payload: { text: 'done' },
        session_id: 's1',
        timestamp: '2026-06-17T01:00:02.000Z',
        type: 'message.complete'
      }
    ])

    const turn = state.objects['session:s1:run:agent_turn:run-backend-1'] as WorkspaceRunObject
    const tool = state.objects['session:s1:run:tool:tc-envelope'] as WorkspaceRunObject

    expect(turn.created_at).toBe('2026-06-17T01:00:00.000Z')
    expect(turn.updated_at).toBe('2026-06-17T01:00:02.000Z')
    expect(turn.runtime).toMatchObject({ run_id: 'run-backend-1', turn_id: 'turn-backend-1' })
    expect(turn.source_event_ids).toContain('evt-turn-start')
    expect(tool.runtime?.tool_call_id).toBe('tc-envelope')
    expect(tool.source_event_ids).toContain('evt-tool-start')
  })

  it('turns blocking prompt events into decision objects and marks the run waiting', () => {
    const state = replay([
      { session_id: 's1', type: 'message.start' },
      {
        payload: {
          allow_permanent: false,
          command: 'rm -rf build',
          description: 'dangerous command',
          request_id: 'approve-1'
        },
        session_id: 's1',
        type: 'approval.request'
      },
      {
        payload: { choices: ['red', 'blue'], question: 'Pick a color', request_id: 'clarify-1' },
        session_id: 's1',
        type: 'clarify.request'
      }
    ])

    expect(state.objects['session:s1:run:agent_turn:turn-1']?.status).toBe('waiting')
    expect(state.objects['session:s1:decision:approve-1']).toMatchObject({
      decision_kind: 'approval',
      state: 'requested',
      status: 'waiting',
      view_model: { allow_permanent: false, command: 'rm -rf build' }
    })
    expect(state.objects['session:s1:decision:clarify-1']).toMatchObject({
      decision_kind: 'clarification',
      view_model: { choices: ['red', 'blue'], question: 'Pick a color' }
    })
  })

  it('marks requested decisions resolved without creating objects for unresolved ids', () => {
    const state = replay([
      { session_id: 's1', type: 'message.start' },
      {
        event_id: 'evt-approval-request',
        payload: { command: 'deploy prod', request_id: 'approval-1' },
        session_id: 's1',
        type: 'approval.request'
      },
      {
        event_id: 'evt-approval-resolved',
        payload: { request_id: 'approval-1' },
        session_id: 's1',
        timestamp: '2026-06-17T01:00:03.000Z',
        type: 'approval.resolved'
      },
      {
        payload: { choice: 'allow' },
        session_id: 's1',
        type: 'approval.resolved'
      }
    ])

    expect(state.objects['session:s1:decision:approval-1']).toMatchObject({
      completed_at: '2026-06-17T01:00:03.000Z',
      state: 'resolved',
      status: 'done',
      updated_at: '2026-06-17T01:00:03.000Z'
    })
    expect(state.objects['session:s1:decision:approval-1']?.source_event_ids).toContain('evt-approval-resolved')
    expect(Object.keys(state.objects).filter(id => id.includes(':decision:'))).toEqual(['session:s1:decision:approval-1'])
  })

  it('requires explicit session ids for subagent events', () => {
    const unscoped = replay([{ payload: { subagent_id: 'a1', text: 'working' }, type: 'subagent.progress' }])
    const scoped = replay([{ payload: { subagent_id: 'a1', text: 'working' }, session_id: 's1', type: 'subagent.progress' }])

    expect(Object.keys(unscoped.objects)).toEqual([])
    expect(scoped.objects['session:s1:run:subagent:a1']).toMatchObject({
      object_type: 'run',
      run_kind: 'subagent',
      status: 'active'
    })
  })

  it('compiles a real-ish Hermes DSL Workbench session without losing completion state or debug refs', () => {
    const state = replay(hermesDslWorkbenchEvents)
    const turn = state.objects[`session:${HERMES_SESSION_ID}:run:agent_turn:run-hermes-1`] as WorkspaceRunObject
    const terminal = state.objects[`session:${HERMES_SESSION_ID}:run:tool:tool-terminal-1`] as WorkspaceRunObject
    const delegate = state.objects[`session:${HERMES_SESSION_ID}:run:tool:tool-delegate-1`] as WorkspaceRunObject
    const subagent = state.objects[`session:${HERMES_SESSION_ID}:run:subagent:worker-c`] as WorkspaceRunObject
    const decision = state.objects[`session:${HERMES_SESSION_ID}:decision:approval-run-workspace-tests`]

    expect(turn).toMatchObject({
      object_type: 'run',
      progress: { phase: 'complete' },
      run_kind: 'agent_turn',
      status: 'done'
    })
    expect(turn.source_event_ids).toEqual(expect.arrayContaining(['evt-message-start', 'evt-message-complete']))
    expect(turn.debug_refs).toEqual(expect.arrayContaining([{ id: 'evt-message-complete', kind: 'gateway_event' }]))
    expect(terminal).toMatchObject({ progress: { phase: 'complete' }, run_kind: 'tool_call', status: 'done' })
    expect(delegate).toMatchObject({ progress: { phase: 'complete' }, run_kind: 'tool_call', status: 'done' })
    expect(subagent).toMatchObject({
      progress: { duration_s: 11, phase: 'complete' },
      result_view: { result: HERMES_SUBAGENT_REPORT, summary: HERMES_SUBAGENT_REPORT },
      run_kind: 'subagent',
      status: 'done'
    })
    expect(subagent.title.length).toBeLessThan(80)
    expect(subagent.title).not.toContain('Worker C regression summary')
    expect(subagent.source_event_ids).toEqual(expect.arrayContaining(['evt-subagent-progress', 'evt-subagent-complete']))
    expect(subagent.debug_refs).toEqual(expect.arrayContaining([{ id: 'evt-subagent-complete', kind: 'gateway_event' }]))
    expect(decision).toMatchObject({ state: 'resolved', status: 'done' })
    expect(decision?.source_event_ids).toEqual(expect.arrayContaining(['evt-approval-request', 'evt-approval-resolved']))
  })
})
