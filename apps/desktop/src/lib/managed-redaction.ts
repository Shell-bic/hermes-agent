export function redactManagedText(value: unknown): string {
  const text = String(value ?? '')
  const redact = typeof window === 'undefined' ? undefined : window.hermesDesktop?.redactSensitiveText

  return typeof redact === 'function' ? redact(text) : text
}

export function redactManagedValue<T>(value: T): T {
  if (typeof value === 'string') {
    return redactManagedText(value) as T
  }

  if (Array.isArray(value)) {
    return value.map(item => redactManagedValue(item)) as T
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactManagedValue(item)])) as T
  }

  return value
}
