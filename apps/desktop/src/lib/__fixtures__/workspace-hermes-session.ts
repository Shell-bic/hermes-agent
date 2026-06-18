import type { WorkspaceGatewayEvent } from '../workspace-events'

export const HERMES_SESSION_ID = '20260617_100956_e4feed'

export const HERMES_ASSISTANT_MARKDOWN =
  [
    '## DSL Workbench regression notes',
    '',
    'The desktop workbench should show the assistant answer once, keep tool activity compact, and move long delegate reports into a readable result note.',
    '',
    '- Assistant turn and assistant response must not duplicate this markdown into several primary blocks.',
    '- Tool activity should finish after terminal and delegate calls complete.',
    '- Debug references should still point back to the gateway event envelope.'
  ].join('\n')

export const HERMES_SUBAGENT_REPORT =
  [
    '## Worker C regression summary',
    '',
    'The captured Hermes session showed a delegate task returning a long markdown report. In the workbench this should read like a result note, not like a giant RUN title.',
    '',
    '### Observed risks',
    '',
    '- Assistant turn, Assistant response, and Detail repeated the same long markdown.',
    '- Tool activity stayed active or generating after completion events had arrived.',
    '- A subagent completion summary expanded into an oversized RUN card instead of becoming a readable artifact.',
    '',
    '### Expected projection',
    '',
    'The subagent run remains a compact activity row. The markdown report is preserved as source-backed content with source_event_ids and debug refs intact.'
  ].join('\n')

export const hermesDslWorkbenchEvents: WorkspaceGatewayEvent[] = [
  {
    event_id: 'evt-session-info',
    payload: {
      branch: 'codex/hermes-desktop-dsl-workbench',
      cwd: '/Users/shell/Documents/myAgent/references/hermes-agent',
      model: 'gpt-5-codex',
      provider: 'openai'
    },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:09:56.000Z',
    type: 'session.info'
  },
  {
    event_id: 'evt-message-start',
    run_id: 'run-hermes-1',
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:00.000Z',
    turn_id: 'turn-hermes-1',
    type: 'message.start'
  },
  {
    event_id: 'evt-reasoning-delta',
    payload: { text: 'Read the projection and preserve real Hermes envelope ids.' },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:01.000Z',
    type: 'reasoning.delta'
  },
  {
    event_id: 'evt-reasoning-available',
    payload: {
      text: 'Read the projection and preserve real Hermes envelope ids. Build a compact regression fixture for the repeated markdown and delegate report cases.'
    },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:02.000Z',
    type: 'reasoning.available'
  },
  {
    event_id: 'evt-message-delta-1',
    payload: { text: HERMES_ASSISTANT_MARKDOWN.slice(0, 146) },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:03.000Z',
    type: 'message.delta'
  },
  {
    event_id: 'evt-message-delta-2',
    payload: { text: HERMES_ASSISTANT_MARKDOWN.slice(146) },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:04.000Z',
    type: 'message.delta'
  },
  {
    event_id: 'evt-tool-terminal-start',
    payload: { args: { command: 'rg "WorkspaceBlock" apps/desktop/src/lib' }, name: 'terminal', tool_id: 'tool-terminal-1' },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:05.000Z',
    type: 'tool.start'
  },
  {
    event_id: 'evt-tool-terminal-generating',
    payload: { name: 'terminal', preview: 'searching workspace projection files', tool_id: 'tool-terminal-1' },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:06.000Z',
    type: 'tool.generating'
  },
  {
    event_id: 'evt-tool-terminal-complete',
    payload: { duration_s: 2, name: 'terminal', result: { exit_code: 0 }, summary: 'found projection tests', tool_id: 'tool-terminal-1' },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:07.000Z',
    type: 'tool.complete'
  },
  {
    event_id: 'evt-tool-delegate-start',
    payload: {
      args: { prompt: 'Inspect the real Hermes DSL workbench session and report regression risks.' },
      name: 'delegate_task',
      tool_id: 'tool-delegate-1'
    },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:08.000Z',
    type: 'tool.start'
  },
  {
    event_id: 'evt-subagent-progress',
    payload: { message: 'Inspecting projection and UI symptoms.', subagent_id: 'worker-c' },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:09.000Z',
    type: 'subagent.progress'
  },
  {
    event_id: 'evt-subagent-complete',
    payload: {
      duration_s: 11,
      result: HERMES_SUBAGENT_REPORT,
      subagent_id: 'worker-c',
      summary: HERMES_SUBAGENT_REPORT
    },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:20.000Z',
    type: 'subagent.complete'
  },
  {
    event_id: 'evt-tool-delegate-complete',
    payload: { duration_s: 12, name: 'delegate_task', result: { subagent_id: 'worker-c' }, summary: 'Worker C completed regression review.', tool_id: 'tool-delegate-1' },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:21.000Z',
    type: 'tool.complete'
  },
  {
    event_id: 'evt-approval-request',
    payload: {
      allow_permanent: false,
      command: 'npm --workspace apps/desktop exec -- vitest run src/lib/workspace-blocks.test.ts',
      description: 'Run focused desktop workspace regression tests.',
      request_id: 'approval-run-workspace-tests'
    },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:22.000Z',
    type: 'approval.request'
  },
  {
    event_id: 'evt-approval-resolved',
    payload: { request_id: 'approval-run-workspace-tests' },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:23.000Z',
    type: 'approval.resolved'
  },
  {
    event_id: 'evt-message-complete',
    payload: { text: HERMES_ASSISTANT_MARKDOWN },
    session_id: HERMES_SESSION_ID,
    timestamp: '2026-06-17T02:10:24.000Z',
    type: 'message.complete'
  }
]
