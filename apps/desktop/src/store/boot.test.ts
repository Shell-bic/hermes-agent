import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $desktopBoot, applyDesktopBootProgress, failDesktopBoot } from './boot'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const initialHermesDesktop = desktopWindow.hermesDesktop
const FAKE_TOKEN = 'dsk_FAKE_boot_1234567890'

beforeEach(() => {
  desktopWindow.hermesDesktop = {
    redactSensitiveText: (value: unknown) => String(value).replaceAll(FAKE_TOKEN, '[REDACTED]')
  } as unknown as Window['hermesDesktop']
})

afterEach(() => {
  if (initialHermesDesktop) {
    desktopWindow.hermesDesktop = initialHermesDesktop
  } else {
    delete desktopWindow.hermesDesktop
  }
})

describe('managed boot error output boundary', () => {
  it('redacts main-process boot progress before error overlays consume it', () => {
    applyDesktopBootProgress({
      error: `failed ${FAKE_TOKEN}`,
      fakeMode: false,
      message: `starting ${FAKE_TOKEN}`,
      phase: 'backend.error',
      progress: 50,
      running: false,
      timestamp: Date.now()
    })

    expect($desktopBoot.get().error).toBe('failed [REDACTED]')
    expect($desktopBoot.get().message).toBe('starting [REDACTED]')
  })

  it('redacts renderer-generated boot failures', () => {
    failDesktopBoot(`failed ${FAKE_TOKEN}`)

    expect($desktopBoot.get().error).toBe('failed [REDACTED]')
    expect($desktopBoot.get().message).not.toContain(FAKE_TOKEN)
  })
})
