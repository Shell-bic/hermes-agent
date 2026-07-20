async function resolveBackendForOperation({ active, ensureBackend, profile }) {
  if (typeof ensureBackend !== 'function') throw new TypeError('Enterprise backend resolver is required.')
  active?.checkpoint()
  const connection = await ensureBackend(profile, { signal: active?.signal })
  active?.checkpoint()
  return connection
}

module.exports = { resolveBackendForOperation }
