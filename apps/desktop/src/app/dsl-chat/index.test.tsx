import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $messages,
  setActiveSessionId,
  setCurrentModel,
  setCurrentProvider,
  setGatewayState,
  setMessages,
  setSelectedStoredSessionId
} from '@/store/session'

import { DEFAULT_PRIMARY_VIEW } from '../desktop-controller'
import { PrimaryViewToggle, type PrimaryView } from '../primary-view-toggle'

import { DslChatView, type DslChatViewProps } from '.'

vi.mock('../workspace', () => {
  function visibleText(value: unknown): string {
    if (!value || typeof value !== 'object') {
      return ''
    }

    const record = value as Record<string, unknown>

    if (typeof record.title === 'string') {
      return record.title
    }

    if (Array.isArray(record.parts)) {
      return record.parts
        .map(part =>
          part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
            ? (part as Record<string, string>).text
            : ''
        )
        .filter(Boolean)
        .join(' ')
    }

    return ''
  }

  return {
    WorkspaceConversationRenderer({
      blocks,
      messages
    }: {
      blocks: readonly unknown[]
      messages?: readonly unknown[]
    }) {
      return (
        <section data-testid="dsl-workspace">
          <p>DSL workspace blocks: {blocks.length}</p>
          <p>DSL messages: {messages?.length ?? 0}</p>
          {blocks.map((block, index) => (
            <p key={`block:${index}`}>{visibleText(block)}</p>
          ))}
          {messages?.map((message, index) => <p key={`message:${index}`}>{visibleText(message)}</p>)}
        </section>
      )
    },
    WorkspaceView({ blocks, primaryViewToggle }: { blocks: unknown[]; primaryViewToggle?: ReactNode }) {
      return (
        <section data-testid="dsl-workspace">
          {primaryViewToggle}
          <p>DSL workspace blocks: {blocks.length}</p>
        </section>
      )
    }
  }
})

const gateway = {
  request: vi.fn(async () => ({
    providers: [
      {
        models: [{ id: 'hermes-test', name: 'Hermes Test' }],
        name: 'Nous',
        slug: 'nous'
      }
    ]
  }))
}

const baseProps = (overrides: Partial<DslChatViewProps> = {}): DslChatViewProps => ({
  gateway: gateway as never,
  onAddContextRef: vi.fn(),
  onAddUrl: vi.fn(),
  onAttachDroppedItems: vi.fn(),
  onAttachImageBlob: vi.fn(),
  onBranchInNewChat: vi.fn(),
  onCancel: vi.fn(),
  onDeleteSelectedSession: vi.fn(),
  onEdit: vi.fn(),
  onPasteClipboardImage: vi.fn(),
  onPickFiles: vi.fn(),
  onPickFolders: vi.fn(),
  onPickImages: vi.fn(),
  onReload: vi.fn(),
  onRemoveAttachment: vi.fn(),
  onRestoreToMessage: vi.fn(),
  onSteer: vi.fn(),
  onSubmit: vi.fn(async () => true),
  onThreadMessagesChange: vi.fn(),
  onToggleSelectedPin: vi.fn(),
  onTranscribeAudio: vi.fn(),
  rawWorkspaceEvents: [],
  workspaceBlocks: [{ id: 'block:run:1' }] as never,
  workspaceObjects: [],
  ...overrides
})

function renderDslChat(props: DslChatViewProps, route = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <DslChatView {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  gateway.request.mockClear()
  window.matchMedia ??= vi.fn().mockReturnValue({
    addEventListener: vi.fn(),
    matches: false,
    removeEventListener: vi.fn()
  })
  setActiveSessionId('session-1')
  setSelectedStoredSessionId('session-1')
  setCurrentModel('hermes-test')
  setCurrentProvider('nous')
  setGatewayState('open')
  setMessages([])
})

afterEach(() => {
  cleanup()
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  setCurrentModel('')
  setCurrentProvider('')
  setGatewayState('idle')
  setMessages([])
})

describe('DslChatView', () => {
  it('is the default primary renderer', () => {
    expect(DEFAULT_PRIMARY_VIEW).toBe('dsl')
  })

  it('renders DSL chat with the original ChatBar submit loop', async () => {
    const onSubmit = vi.fn(async () => true)

    renderDslChat(baseProps({ onSubmit }))

    expect(screen.getByTestId('dsl-workspace')).toBeTruthy()

    const editor = screen.getByRole('textbox', { name: /message/i })

    await act(async () => {
      editor.textContent = 'continue from DSL'
      fireEvent.input(editor)
      fireEvent.keyDown(editor, { key: 'Enter' })
    })

    expect(onSubmit).toHaveBeenCalledWith('continue from DSL', { attachments: [] })
  })

  it('can switch back to transcript chat without clearing messages', () => {
    setMessages([{ id: 'm1', parts: [{ text: 'still here', type: 'text' }], role: 'user' }])

    function ToggleHarness() {
      const [view, setView] = useState<PrimaryView>('dsl')
      const toggle = <PrimaryViewToggle onChange={setView} value={view} />

      return view === 'dsl' ? (
        <div>
          {toggle}
          <p>DSL surface</p>
        </div>
      ) : (
        <div>
          {toggle}
          <p>Transcript chat</p>
        </div>
      )
    }

    render(<ToggleHarness />)

    fireEvent.click(screen.getByRole('button', { name: /^chat$/i }))

    expect(screen.getByText('Transcript chat')).toBeTruthy()
    expect($messages.get()).toHaveLength(1)
    expect($messages.get()[0]?.parts[0]).toMatchObject({ text: 'still here' })
  })

  it('does not render stale messages or blocks while a routed empty session is loading', () => {
    setActiveSessionId('old-session')
    setSelectedStoredSessionId('old-session')
    setMessages([
      { id: 'old-user-message', parts: [{ text: 'STALE_SESSION_USER_MESSAGE', type: 'text' }], role: 'user' },
      {
        id: 'old-assistant-message',
        parts: [{ text: 'STALE_SESSION_ASSISTANT_ANSWER', type: 'text' }],
        role: 'assistant'
      }
    ])

    renderDslChat(baseProps({ workspaceBlocks: [], workspaceObjects: [], rawWorkspaceEvents: [] }), '/new-session')

    expect(screen.getByText('DSL workspace blocks: 0')).toBeTruthy()
    expect(screen.getByText('DSL messages: 0')).toBeTruthy()
    expect(screen.queryByText('STALE_SESSION_USER_MESSAGE')).toBeNull()
    expect(screen.queryByText('STALE_SESSION_ASSISTANT_ANSWER')).toBeNull()
  })
})
