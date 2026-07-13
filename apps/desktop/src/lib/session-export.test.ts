import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getSessionExport } from '@/hermes'

import { exportSession } from './session-export'

vi.mock('@/hermes', () => ({
  getSessionExport: vi.fn()
}))

vi.mock('@/i18n', () => ({
  translateNow: (key: string) => key
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

describe('desktop session export secret boundary', () => {
  let blobParts: BlobPart[]
  let clickedAnchor: HTMLAnchorElement | null

  beforeEach(() => {
    blobParts = []
    clickedAnchor = null

    class CapturingBlob extends Blob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options)
        blobParts = parts
      }
    }

    vi.stubGlobal('Blob', CapturingBlob)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:session-export')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedAnchor = this
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('downloads only the backend-redacted export and ignores raw renderer metadata', async () => {
    const fakeToken = 'sk-test-abcdefghijklmnopqrstuvwxyz123456'
    vi.mocked(getSessionExport).mockResolvedValue({
      archived: false,
      cwd: '[REDACTED]',
      ended_at: null,
      id: 'session-1',
      input_tokens: 1,
      is_active: false,
      last_active: 2,
      message_count: 1,
      messages: [{ content: 'token=[REDACTED]', role: 'assistant' }],
      model: 'test',
      output_tokens: 1,
      preview: '[REDACTED]',
      source: 'desktop',
      started_at: 1,
      title: 'Sanitized title',
      tool_call_count: 0
    })

    await exportSession('session-1', {
      profile: 'work',
      session: {
        archived: false,
        cwd: fakeToken,
        ended_at: null,
        id: 'session-1',
        input_tokens: 1,
        is_active: false,
        last_active: 2,
        message_count: 1,
        model: fakeToken,
        output_tokens: 1,
        preview: fakeToken,
        source: 'desktop',
        started_at: 1,
        title: fakeToken,
        tool_call_count: 0
      },
      title: fakeToken
    })

    expect(getSessionExport).toHaveBeenCalledWith('session-1', 'work')
    const downloadedJson = blobParts.map(String).join('')
    expect(downloadedJson).not.toContain(fakeToken)
    expect(JSON.parse(downloadedJson)).toMatchObject({
      message_count: 1,
      messages: [{ content: 'token=[REDACTED]' }],
      session_id: 'session-1',
      title: 'Sanitized title'
    })
    expect(clickedAnchor?.download).toBe('sanitized-title-session-.json')
  })
})
