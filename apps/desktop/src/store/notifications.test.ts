import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $notifications, clearNotifications, notify } from './notifications'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const initialHermesDesktop = desktopWindow.hermesDesktop
const FAKE_TOKEN = 'gw_FAKE_toast_1234567890'

beforeEach(() => {
  clearNotifications()
  desktopWindow.hermesDesktop = {
    redactSensitiveText: (value: unknown) => String(value).replaceAll(FAKE_TOKEN, '[REDACTED]')
  } as unknown as Window['hermesDesktop']
})

afterEach(() => {
  clearNotifications()

  if (initialHermesDesktop) {
    desktopWindow.hermesDesktop = initialHermesDesktop
  } else {
    delete desktopWindow.hermesDesktop
  }
})

describe('managed notification output boundary', () => {
  it('redacts title, message, detail, and action label before storing a toast', () => {
    notify({
      action: { label: `inspect ${FAKE_TOKEN}`, onClick: () => undefined },
      detail: `detail ${FAKE_TOKEN}`,
      kind: 'error',
      message: `message ${FAKE_TOKEN}`,
      title: `title ${FAKE_TOKEN}`
    })

    const notification = $notifications.get()[0]
    const serialized = JSON.stringify(notification)

    expect(serialized).not.toContain(FAKE_TOKEN)
    expect(notification.title).toBe('title [REDACTED]')
    expect(notification.message).toBe('message [REDACTED]')
    expect(notification.detail).toBe('detail [REDACTED]')
    expect(notification.action?.label).toBe('inspect [REDACTED]')
  })

  it('preserves toast text when the desktop bridge is unavailable', () => {
    delete desktopWindow.hermesDesktop
    notify({ kind: 'error', message: FAKE_TOKEN })

    expect($notifications.get()[0]?.message).toBe(FAKE_TOKEN)
  })
})
