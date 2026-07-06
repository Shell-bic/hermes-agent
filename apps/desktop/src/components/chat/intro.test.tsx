import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { Intro } from './intro'

function renderIntro(initialLocale: 'en' | 'zh', personality?: string) {
  const rendered = render(
    <I18nProvider configClient={null} initialLocale={initialLocale}>
      <Intro personality={personality} />
    </I18nProvider>
  )

  return rendered.container.querySelector('[data-slot="aui_intro"]')?.textContent ?? ''
}

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Intro i18n', () => {
  it('renders the empty-session intro body in Simplified Chinese for zh locale', () => {
    const text = renderIntro('zh')

    expect(text).toContain('发送任务、问题或代码片段')
    expect(text).not.toContain('Type a task, question, or snippet')
    expect(text).not.toContain('Ask a question, paste an error')
  })

  it('does not fall back to English for non-neutral personalities in zh locale', () => {
    const text = renderIntro('zh', 'reviewer')

    expect(text).toContain('我会按 Reviewer 模式回应')
    expect(text).not.toContain('configured voice')
    expect(text).not.toContain('configured personality')
  })

  it('keeps the existing English intro-copy behavior for en locale', () => {
    const text = renderIntro('en')

    expect(text).toContain('Ask a question, paste an error, or point me at a repo.')
    expect(text).not.toContain('发送任务')
  })
})
