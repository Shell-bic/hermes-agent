import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRunObject } from '@/lib/workspace-events'

import {
  $rawWorkspaceEvents,
  $selectedWorkspaceObjectId,
  $workspaceBlocks,
  $workspaceCompilerState,
  $workspaceObjects,
  applyWorkspaceGatewayEvent,
  hydrateWorkspaceFromMessages,
  rawWorkspaceEventsForSession,
  resolveWorkspaceSessionIdForRoute,
  selectedWorkspaceObjectForSession,
  setSelectedWorkspaceObjectId,
  workspaceBlocksForSession,
  workspaceObjectsForSession,
  resetWorkspaceState
} from './workspace'

afterEach(() => {
  resetWorkspaceState()
})

describe('workspace store ingestion', () => {
  it('compiles turn, tool, and approval gateway events into workspace objects', () => {
    applyWorkspaceGatewayEvent(
      { session_id: 's1', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:00.000Z', receivedAt: 1 }
    )
    applyWorkspaceGatewayEvent(
      {
        payload: { args: { command: 'npm test' }, name: 'terminal', tool_id: 'tool-1' },
        session_id: 's1',
        type: 'tool.start'
      },
      { nowIso: '2026-06-17T00:00:01.000Z', receivedAt: 2 }
    )
    applyWorkspaceGatewayEvent(
      {
        payload: { duration_s: 3, name: 'terminal', result: { exit_code: 0 }, tool_id: 'tool-1' },
        session_id: 's1',
        type: 'tool.complete'
      },
      { nowIso: '2026-06-17T00:00:02.000Z', receivedAt: 3 }
    )
    applyWorkspaceGatewayEvent(
      {
        payload: { command: 'deploy prod', description: 'requires approval', request_id: 'approval-1' },
        session_id: 's1',
        type: 'approval.request'
      },
      { nowIso: '2026-06-17T00:00:03.000Z', receivedAt: 4 }
    )

    const objects = $workspaceObjects.get()
    const turn = objects['session:s1:run:agent_turn:turn-1'] as WorkspaceRunObject
    const tool = objects['session:s1:run:tool:tool-1'] as WorkspaceRunObject

    expect($workspaceCompilerState.get().objects).toBe(objects)
    expect($workspaceBlocks.get().length).toBeGreaterThan(0)
    expect(turn).toMatchObject({ object_type: 'run', run_kind: 'agent_turn', status: 'waiting' })
    expect(tool).toMatchObject({
      object_type: 'run',
      parent_id: 'session:s1:run:agent_turn:turn-1',
      progress: { duration_s: 3, phase: 'complete' },
      result_view: { args: { command: 'npm test' }, result: { exit_code: 0 } },
      run_kind: 'tool_call',
      status: 'done'
    })
    expect(objects['session:s1:decision:approval-1']).toMatchObject({
      decision_kind: 'approval',
      object_type: 'decision',
      parent_id: 'session:s1:run:agent_turn:turn-1',
      state: 'requested',
      status: 'waiting',
      view_model: { command: 'deploy prod', description: 'requires approval', request_id: 'approval-1' }
    })
  })

  it('keeps only the most recent 200 raw workspace events', () => {
    for (let index = 0; index < 205; index += 1) {
      applyWorkspaceGatewayEvent({ payload: { index }, session_id: 's1', type: `noop.${index}` }, { receivedAt: index })
    }

    const rawEvents = $rawWorkspaceEvents.get()

    expect(rawEvents).toHaveLength(200)
    expect(rawEvents[0]).toMatchObject({ payload: { index: 5 }, receivedAt: 5, type: 'noop.5' })
    expect(rawEvents[199]).toMatchObject({ payload: { index: 204 }, receivedAt: 204, type: 'noop.204' })
  })

  it('uses backend event ids for raw workspace event ids', () => {
    applyWorkspaceGatewayEvent(
      {
        event_id: 'evt-raw-1',
        payload: { ok: true },
        session_id: 's1',
        timestamp: '2026-06-17T01:02:03.000Z',
        type: 'status.update'
      },
      { receivedAt: 42 }
    )

    expect($rawWorkspaceEvents.get()[0]).toMatchObject({
      id: 'evt-raw-1',
      payload: { ok: true },
      receivedAt: 42,
      sessionId: 's1',
      timestamp: '2026-06-17T01:02:03.000Z',
      type: 'status.update'
    })
  })

  it('resets projected workspace blocks with compiled workspace state', () => {
    applyWorkspaceGatewayEvent(
      { session_id: 's1', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:00.000Z', receivedAt: 1 }
    )

    expect($workspaceBlocks.get().length).toBeGreaterThan(0)

    resetWorkspaceState()

    expect($workspaceObjects.get()).toEqual({})
    expect($workspaceBlocks.get()).toEqual([])
  })

  it('hydrates workspace blocks from stored transcript messages when live events are absent', () => {
    hydrateWorkspaceFromMessages('s1', [
      {
        id: 'assistant-1',
        parts: [
          { type: 'reasoning', text: 'Inspect current run state.' },
          {
            type: 'tool-call',
            toolCallId: 'stored-tool-1',
            toolName: 'terminal',
            args: { command: 'npm test' },
            result: { summary: 'tests passed' }
          },
          { type: 'text', text: 'Finished the workspace projection review.' }
        ] as never,
        role: 'assistant',
        timestamp: Date.parse('2026-06-17T00:00:00.000Z')
      }
    ])

    const blocks = $workspaceBlocks.get()

    expect($workspaceObjects.get()['session:s1:run:agent_turn:transcript-turn-assistant-1']).toMatchObject({
      object_type: 'run',
      run_kind: 'agent_turn',
      status: 'done'
    })
    expect(blocks.some(block => block.type === 'NOTE' && block.note_kind === 'summary')).toBe(true)
    expect(blocks.some(block => block.type === 'TOPIC' && block.title === 'Reasoning')).toBe(true)
    expect(
      blocks.some(block => block.type === 'RUN' && block.run_kind === 'tool_activity' && block.status === 'done')
    ).toBe(true)
    expect($rawWorkspaceEvents.get().map(event => event.type)).toEqual([
      'message.start',
      'reasoning.available',
      'tool.start',
      'tool.complete',
      'message.delta',
      'message.complete'
    ])
  })

  it('filters mixed workspace blocks, objects, and raw events by session', () => {
    applyWorkspaceGatewayEvent(
      { event_id: 's1-start', session_id: 's1', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:00.000Z', receivedAt: 1 }
    )
    applyWorkspaceGatewayEvent(
      {
        event_id: 's1-tool',
        payload: { args: { command: 'npm test' }, name: 'terminal', tool_id: 'tool-s1' },
        session_id: 's1',
        type: 'tool.start'
      },
      { nowIso: '2026-06-17T00:00:01.000Z', receivedAt: 2 }
    )
    applyWorkspaceGatewayEvent(
      { event_id: 's2-start', session_id: 's2', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:02.000Z', receivedAt: 3 }
    )
    applyWorkspaceGatewayEvent(
      {
        event_id: 's2-tool',
        payload: { args: { command: 'pnpm test' }, name: 'terminal', tool_id: 'tool-s2' },
        session_id: 's2',
        type: 'tool.start'
      },
      { nowIso: '2026-06-17T00:00:03.000Z', receivedAt: 4 }
    )

    const s2Blocks = workspaceBlocksForSession($workspaceBlocks.get(), 's2')
    const s2Objects = workspaceObjectsForSession($workspaceObjects.get(), 's2')
    const s2RawEvents = rawWorkspaceEventsForSession($rawWorkspaceEvents.get(), 's2')

    expect(s2Blocks.length).toBeGreaterThan(0)
    expect(Object.keys(s2Objects).length).toBeGreaterThan(0)
    expect(Object.keys(s2Objects).every(id => id.startsWith('session:s2'))).toBe(true)
    expect(s2Blocks.every(block => block.source_object_ids.every(id => id.startsWith('session:s2')))).toBe(true)
    expect(s2RawEvents.map(event => event.id)).toEqual(['s2-start', 's2-tool'])
  })

  it('returns empty workspace projections for a new or null session', () => {
    applyWorkspaceGatewayEvent(
      { event_id: 's1-start', session_id: 's1', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:00.000Z', receivedAt: 1 }
    )

    expect(workspaceBlocksForSession($workspaceBlocks.get(), null)).toEqual([])
    expect(workspaceObjectsForSession($workspaceObjects.get(), undefined)).toEqual({})
    expect(rawWorkspaceEventsForSession($rawWorkspaceEvents.get(), '')).toEqual([])
    expect(workspaceBlocksForSession($workspaceBlocks.get(), 's2')).toEqual([])
    expect(workspaceObjectsForSession($workspaceObjects.get(), 's2')).toEqual({})
    expect(rawWorkspaceEventsForSession($rawWorkspaceEvents.get(), 's2')).toEqual([])
  })

  it('resolves the new chat route to an empty workspace even with a stale active session', () => {
    applyWorkspaceGatewayEvent(
      { event_id: 's1-start', session_id: 's1', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:00.000Z', receivedAt: 1 }
    )

    const sessionId = resolveWorkspaceSessionIdForRoute({
      activeSessionId: 's1',
      newChatPath: '/',
      pathname: '/',
      routedSessionId: null,
      selectedStoredSessionId: 's1'
    })

    expect(sessionId).toBeNull()
    expect(workspaceBlocksForSession($workspaceBlocks.get(), sessionId)).toEqual([])
    expect(workspaceObjectsForSession($workspaceObjects.get(), sessionId)).toEqual({})
    expect(rawWorkspaceEventsForSession($rawWorkspaceEvents.get(), sessionId)).toEqual([])
  })

  it('prefers a routed session over a stale active session for workspace projection', () => {
    expect(
      resolveWorkspaceSessionIdForRoute({
        activeSessionId: 's1',
        newChatPath: '/',
        pathname: '/s2',
        routedSessionId: 's2',
        selectedStoredSessionId: 's1'
      })
    ).toBe('s2')
  })

  it('does not expose a selected workspace id from another session', () => {
    applyWorkspaceGatewayEvent(
      { event_id: 's1-start', session_id: 's1', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:00.000Z', receivedAt: 1 }
    )
    applyWorkspaceGatewayEvent(
      { event_id: 's2-start', session_id: 's2', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:01.000Z', receivedAt: 2 }
    )

    const s1SelectedId = workspaceBlocksForSession($workspaceBlocks.get(), 's1')[0]?.id ?? null

    setSelectedWorkspaceObjectId(s1SelectedId)

    expect($selectedWorkspaceObjectId.get()).toBe(s1SelectedId)
    expect(selectedWorkspaceObjectForSession($selectedWorkspaceObjectId.get(), $workspaceBlocks.get(), 's2')).toBeNull()
    expect(selectedWorkspaceObjectForSession($selectedWorkspaceObjectId.get(), $workspaceBlocks.get(), 's1')).toBe(
      s1SelectedId
    )
  })

  it('hydrates the requested session even when another session already has workspace state', () => {
    applyWorkspaceGatewayEvent(
      { event_id: 's1-start', session_id: 's1', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:00.000Z', receivedAt: 1 }
    )

    hydrateWorkspaceFromMessages('s2', [
      {
        id: 'assistant-2',
        parts: [{ type: 'text', text: 'Hydrated session two.' }] as never,
        role: 'assistant',
        timestamp: Date.parse('2026-06-17T00:01:00.000Z')
      }
    ])

    const objects = $workspaceObjects.get()

    expect(objects['session:s1:run:agent_turn:turn-1']).toBeDefined()
    expect(objects['session:s2:run:agent_turn:transcript-turn-assistant-2']).toMatchObject({
      object_type: 'run',
      run_kind: 'agent_turn',
      status: 'done'
    })
    expect(workspaceBlocksForSession($workspaceBlocks.get(), 's2').length).toBeGreaterThan(0)
    expect(rawWorkspaceEventsForSession($rawWorkspaceEvents.get(), 's2').map(event => event.type)).toEqual([
      'message.start',
      'message.delta',
      'message.complete'
    ])
  })

  it('filters projected blocks, objects, and raw events to the selected session', () => {
    applyWorkspaceGatewayEvent(
      { event_id: 'event:s1:start', payload: { turn_id: 'turn-s1' }, session_id: 's1', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:00.000Z', receivedAt: 1 }
    )
    applyWorkspaceGatewayEvent(
      { event_id: 'event:s1:delta', payload: { text: 'S1_ONLY_SUMMARY' }, session_id: 's1', type: 'message.delta' },
      { nowIso: '2026-06-17T00:00:01.000Z', receivedAt: 2 }
    )
    applyWorkspaceGatewayEvent(
      {
        event_id: 'event:s1:complete',
        payload: { text: 'S1_ONLY_SUMMARY' },
        session_id: 's1',
        type: 'message.complete'
      },
      { nowIso: '2026-06-17T00:00:02.000Z', receivedAt: 3 }
    )
    applyWorkspaceGatewayEvent(
      { event_id: 'event:s2:start', payload: { turn_id: 'turn-s2' }, session_id: 's2', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:03.000Z', receivedAt: 4 }
    )
    applyWorkspaceGatewayEvent(
      { event_id: 'event:s2:delta', payload: { text: 'S2_ONLY_SUMMARY' }, session_id: 's2', type: 'message.delta' },
      { nowIso: '2026-06-17T00:00:04.000Z', receivedAt: 5 }
    )
    applyWorkspaceGatewayEvent(
      {
        event_id: 'event:s2:complete',
        payload: { text: 'S2_ONLY_SUMMARY' },
        session_id: 's2',
        type: 'message.complete'
      },
      { nowIso: '2026-06-17T00:00:05.000Z', receivedAt: 6 }
    )

    const s1Blocks = workspaceBlocksForSession($workspaceBlocks.get(), 's1')
    const s2Blocks = workspaceBlocksForSession($workspaceBlocks.get(), 's2')
    const s1Objects = workspaceObjectsForSession($workspaceObjects.get(), 's1')
    const s2Objects = workspaceObjectsForSession($workspaceObjects.get(), 's2')

    expect(s1Blocks).not.toHaveLength(0)
    expect(s2Blocks).not.toHaveLength(0)
    expect(JSON.stringify(s1Blocks)).toContain('S1_ONLY_SUMMARY')
    expect(JSON.stringify(s1Blocks)).not.toContain('S2_ONLY_SUMMARY')
    expect(JSON.stringify(s2Blocks)).toContain('S2_ONLY_SUMMARY')
    expect(JSON.stringify(s2Blocks)).not.toContain('S1_ONLY_SUMMARY')
    expect(Object.keys(s1Objects).every(id => id.startsWith('session:s1'))).toBe(true)
    expect(Object.keys(s2Objects).every(id => id.startsWith('session:s2'))).toBe(true)
    expect(rawWorkspaceEventsForSession($rawWorkspaceEvents.get(), 's1').map(event => event.id)).toEqual([
      'event:s1:start',
      'event:s1:delta',
      'event:s1:complete'
    ])
    expect(rawWorkspaceEventsForSession($rawWorkspaceEvents.get(), 's2').map(event => event.id)).toEqual([
      'event:s2:start',
      'event:s2:delta',
      'event:s2:complete'
    ])
    expect(workspaceBlocksForSession($workspaceBlocks.get(), null)).toEqual([])
    expect(workspaceObjectsForSession($workspaceObjects.get(), null)).toEqual({})
    expect(rawWorkspaceEventsForSession($rawWorkspaceEvents.get(), null)).toEqual([])
  })

  it('clears selected workspace objects that do not belong to the current session', () => {
    applyWorkspaceGatewayEvent(
      { event_id: 'event:s1:start', payload: { turn_id: 'turn-s1' }, session_id: 's1', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:00.000Z', receivedAt: 1 }
    )
    applyWorkspaceGatewayEvent(
      { event_id: 'event:s2:start', payload: { turn_id: 'turn-s2' }, session_id: 's2', type: 'message.start' },
      { nowIso: '2026-06-17T00:00:01.000Z', receivedAt: 2 }
    )

    const s1Selected = 'session:s1:run:agent_turn:turn-s1'

    setSelectedWorkspaceObjectId(s1Selected)

    expect(selectedWorkspaceObjectForSession($selectedWorkspaceObjectId.get(), $workspaceBlocks.get(), 's1')).toBe(
      s1Selected
    )
    expect(selectedWorkspaceObjectForSession($selectedWorkspaceObjectId.get(), $workspaceBlocks.get(), 's2')).toBeNull()
    expect(selectedWorkspaceObjectForSession($selectedWorkspaceObjectId.get(), $workspaceBlocks.get(), null)).toBeNull()
  })
})
