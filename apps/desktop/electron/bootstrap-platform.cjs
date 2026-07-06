const fs = require('node:fs')

function isWslEnvironment(env = process.env, platform = process.platform, kernelRelease = null) {
  if (platform !== 'linux') return false
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true

  try {
    const release = kernelRelease ?? fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8')
    return /microsoft|wsl/i.test(release)
  } catch {
    return false
  }
}

function isWindowsBinaryPathInWsl(filePath, options = {}) {
  const isWsl = options.isWsl ?? isWslEnvironment(options.env, options.platform)
  if (!isWsl) return false

  const normalized = String(filePath || '')
    .replace(/\\/g, '/')
    .toLowerCase()

  return (
    normalized.endsWith('.exe') ||
    normalized.endsWith('.cmd') ||
    normalized.endsWith('.bat') ||
    normalized.endsWith('.ps1')
  )
}

function bundledRuntimeImportCheck(platform = process.platform) {
  return platform === 'win32' ? 'import fastapi, uvicorn, winpty' : 'import fastapi, uvicorn, ptyprocess'
}

const GPU_OVERRIDE_ON = new Set(['1', 'true', 'yes', 'on'])
const GPU_OVERRIDE_OFF = new Set(['0', 'false', 'no', 'off'])
const GPU_IN_PROCESS_ON = new Set(['1', 'true', 'yes', 'on', 'in-process'])
const GPU_IN_PROCESS_OFF = new Set(['0', 'false', 'no', 'off', 'default'])
const RENDERER_CODE_INTEGRITY_ON = new Set(['1', 'true', 'yes', 'on', 'enabled'])
const RENDERER_CODE_INTEGRITY_OFF = new Set(['0', 'false', 'no', 'off', 'disabled'])
const RENDERER_SANDBOX_ON = new Set(['1', 'true', 'yes', 'on', 'enabled'])
const RENDERER_SANDBOX_OFF = new Set(['0', 'false', 'no', 'off', 'disabled'])

/**
 * Decide whether the app is being shown over a remote/forwarded display, where
 * Chromium's GPU compositor produces an unstable, flickering surface (it can't
 * present accelerated layers cleanly over the wire). Native local Windows/macOS
 * sessions composite locally and never hit this, so we only fall back to
 * software rendering when a remote display is detected.
 *
 * Returns a short reason string when GPU acceleration should be disabled, or
 * null to keep it enabled. `HERMES_DESKTOP_DISABLE_GPU` overrides detection
 * both ways (1/true/yes/on → always disable, 0/false/no/off → never disable).
 *
 * Pure + dependency-free so it can be unit-tested and called before app ready.
 */
function detectRemoteDisplay(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform

  const override = String(env.HERMES_DESKTOP_DISABLE_GPU || '')
    .trim()
    .toLowerCase()
  if (GPU_OVERRIDE_ON.has(override)) return 'override (HERMES_DESKTOP_DISABLE_GPU)'
  if (GPU_OVERRIDE_OFF.has(override)) return null

  // Launched from an SSH session → the display is X11-forwarded or otherwise
  // remote. Covers the common `ssh user@box` + GUI-forwarding case.
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return 'ssh-session'

  if (platform === 'linux') {
    // X11 forwarding sets DISPLAY to "<host>:N" (e.g. "localhost:10.0"); a
    // local X server is ":0"/":1" with no host part before the colon.
    // NB: WSLg deliberately isn't treated as remote — it reports
    // GPU-accelerated vGPU surfaces locally and doesn't show the flicker.
    const display = String(env.DISPLAY || '')
    if (display.includes(':') && display.split(':')[0]) {
      return `x11-forwarding (DISPLAY=${display})`
    }
  }

  if (platform === 'win32') {
    // RDP sessions report SESSIONNAME like "RDP-Tcp#7"; the local console is
    // "Console".
    const sessionName = String(env.SESSIONNAME || '')
    if (/^rdp-/i.test(sessionName)) return `rdp (SESSIONNAME=${sessionName})`
  }

  return null
}

/**
 * Windows Electron can fail before the first BrowserWindow when Chromium is
 * unable to spawn the isolated GPU child process. Keep acceleration enabled
 * and prefer Chromium's normal GPU child process by default; after the Windows
 * dev renderer sandbox/code-integrity compatibility switches are applied, that
 * path presents the window reliably. Keep the in-process GPU path as an
 * explicit escape hatch for machines that still cannot spawn the GPU child.
 */
function resolveWindowsGpuLaunchSwitches(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const isPackaged = Boolean(options.isPackaged)

  if (platform !== 'win32') return []

  const override = String(env.HERMES_DESKTOP_GPU_PROCESS || '')
    .trim()
    .toLowerCase()
  if (GPU_IN_PROCESS_OFF.has(override)) return []

  const shouldUseInProcessGpu = GPU_IN_PROCESS_ON.has(override)
  if (!shouldUseInProcessGpu) return []

  return [
    ['use-angle', 'd3d11'],
    ['in-process-gpu']
  ]
}

/**
 * Some Windows development machines inject accessibility, security, graphics,
 * or IME DLLs into Chromium child processes. Electron/Chromium can then fail
 * the sandboxed renderer launch with `render-process-gone: launch-failed`
 * before the app paints a window. Keep this compatibility switch scoped to
 * dev by default; packaged builds can opt in via env if the target fleet needs
 * it.
 */
function resolveWindowsRendererLaunchSwitches(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const isPackaged = Boolean(options.isPackaged)

  if (platform !== 'win32') return []

  const override = String(env.HERMES_DESKTOP_RENDERER_CODE_INTEGRITY || '')
    .trim()
    .toLowerCase()
  if (RENDERER_CODE_INTEGRITY_ON.has(override)) return []

  const shouldDisableRendererCodeIntegrity = RENDERER_CODE_INTEGRITY_OFF.has(override) || !isPackaged
  if (!shouldDisableRendererCodeIntegrity) return []

  return [['disable-features', 'RendererCodeIntegrity']]
}

function shouldDisableWindowsRendererSandbox(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const isPackaged = Boolean(options.isPackaged)

  if (platform !== 'win32') return false

  const override = String(env.HERMES_DESKTOP_RENDERER_SANDBOX || '')
    .trim()
    .toLowerCase()
  if (RENDERER_SANDBOX_ON.has(override)) return false
  if (RENDERER_SANDBOX_OFF.has(override)) return true

  return !isPackaged
}

module.exports = {
  bundledRuntimeImportCheck,
  detectRemoteDisplay,
  resolveWindowsGpuLaunchSwitches,
  resolveWindowsRendererLaunchSwitches,
  shouldDisableWindowsRendererSandbox,
  isWindowsBinaryPathInWsl,
  isWslEnvironment
}
