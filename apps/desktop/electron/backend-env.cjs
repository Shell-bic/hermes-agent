const path = require('node:path')

// Match the POSIX fallback surface used by the Python terminal environment.
// macOS apps launched from Finder/Dock often inherit only /usr/bin:/bin:/usr/sbin:/sbin,
// which misses Apple Silicon Homebrew and user-installed CLI tools such as codex.
const POSIX_SANE_PATH_ENTRIES = Object.freeze([
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin'
])
const LOCAL_DEVELOPMENT_SKILL_RECEIPT_ENV = 'HERMES_ENTERPRISE_ALLOW_LOCAL_DEVELOPMENT_SKILL_RECEIPTS'

function delimiterForPlatform(platform = process.platform) {
  return platform === 'win32' ? ';' : ':'
}

function pathModuleForPlatform(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

function pathEnvKey(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return 'PATH'
  return Object.keys(env || {}).find(key => key.toUpperCase() === 'PATH') || 'PATH'
}

function currentPathValue(env = process.env, platform = process.platform) {
  const key = pathEnvKey(env, platform)
  return env?.[key] || ''
}

function appendUniquePathEntries(entries, { delimiter = path.delimiter } = {}) {
  const seen = new Set()
  const ordered = []

  for (const entry of entries) {
    if (!entry) continue
    const parts = Array.isArray(entry) ? entry : String(entry).split(delimiter)
    for (const part of parts) {
      if (!part || seen.has(part)) continue
      seen.add(part)
      ordered.push(part)
    }
  }

  return ordered.join(delimiter)
}

function buildDesktopBackendPath({
  hermesHome,
  venvRoot,
  currentPath = '',
  platform = process.platform,
  pathModule = pathModuleForPlatform(platform)
} = {}) {
  const delimiter = delimiterForPlatform(platform)
  const hermesNodeRoot = hermesHome && platform === 'win32' ? pathModule.join(hermesHome, 'node') : null
  const hermesNodeBin = hermesHome ? pathModule.join(hermesHome, 'node', 'bin') : null
  const venvBin = venvRoot ? pathModule.join(venvRoot, platform === 'win32' ? 'Scripts' : 'bin') : null
  const saneEntries = platform === 'win32' ? [] : POSIX_SANE_PATH_ENTRIES

  return appendUniquePathEntries(
    [hermesNodeRoot, hermesNodeBin, venvBin, currentPath, saneEntries],
    { delimiter }
  )
}

function normalizeHermesHomeRoot(hermesHome, { pathModule = pathModuleForPlatform(process.platform) } = {}) {
  if (!hermesHome) return hermesHome
  const resolved = pathModule.resolve(String(hermesHome))
  const parent = pathModule.dirname(resolved)
  if (pathModule.basename(parent).toLowerCase() === 'profiles') {
    return pathModule.dirname(parent)
  }
  return resolved
}

function buildDesktopBackendEnv({
  allowLocalDevelopmentSkillReceipts = false,
  hermesHome,
  pythonPathEntries = [],
  venvRoot,
  currentEnv = process.env,
  platform = process.platform,
  pathModule = pathModuleForPlatform(platform)
} = {}) {
  const delimiter = delimiterForPlatform(platform)
  const currentPythonPath = currentEnv?.PYTHONPATH || ''
  const key = pathEnvKey(currentEnv, platform)

  return {
    PYTHONPATH: appendUniquePathEntries([...pythonPathEntries, currentPythonPath], { delimiter }),
    [key]: buildDesktopBackendPath({
      hermesHome,
      venvRoot,
      currentPath: currentPathValue(currentEnv, platform),
      platform,
      pathModule
    }),
    ...(allowLocalDevelopmentSkillReceipts ? { [LOCAL_DEVELOPMENT_SKILL_RECEIPT_ENV]: '1' } : {})
  }
}

module.exports = {
  LOCAL_DEVELOPMENT_SKILL_RECEIPT_ENV,
  POSIX_SANE_PATH_ENTRIES,
  appendUniquePathEntries,
  buildDesktopBackendEnv,
  buildDesktopBackendPath,
  delimiterForPlatform,
  normalizeHermesHomeRoot,
  pathEnvKey
}
