'use strict'

const path = require('node:path')
const { spawn } = require('node:child_process')

const desktopRoot = path.resolve(__dirname, '..')
const hermesRoot = path.resolve(desktopRoot, '..', '..')

function buildWeComDevLaunch({ env = process.env, platform = process.platform } = {}) {
  const npmExecPath = typeof env.npm_execpath === 'string' ? env.npm_execpath.trim() : ''
  const command = npmExecPath
    ? process.execPath
    : platform === 'win32'
      ? env.ComSpec || env.COMSPEC || 'cmd.exe'
      : 'npm'
  const args = npmExecPath
    ? [npmExecPath, 'run', 'dev']
    : platform === 'win32'
      ? ['/d', '/s', '/c', 'npm run dev']
      : ['run', 'dev']

  return {
    // npm.cmd cannot be passed directly to spawn(..., { shell: false }) on
    // newer Windows Node releases (notably Node 25: spawn EINVAL). npm exposes
    // its JS entry point to lifecycle scripts, so run that through this Node.
    command,
    args,
    cwd: desktopRoot,
    env: {
      ...env,
      // Resolve from this script instead of the caller's working directory.
      // npm workspace invocations and direct apps/desktop invocations otherwise
      // interpret ../.. differently and can silently fall back to installed Hermes.
      HERMES_DESKTOP_HERMES_ROOT: hermesRoot,
      HERMES_DESKTOP_ENTERPRISE_GATEWAY_URL:
        env.HERMES_DESKTOP_ENTERPRISE_GATEWAY_URL || 'http://127.0.0.1:5000',
      HERMES_DESKTOP_WECOM_GATEWAY_RUNNER_EXPERIMENT: '1'
    }
  }
}

function run() {
  const launch = buildWeComDevLaunch()
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: 'inherit',
    shell: false
  })

  child.on('error', error => {
    console.error(`[dev:wecom] Failed to start Desktop: ${error.message}`)
    process.exitCode = 1
  })
  child.on('exit', code => {
    process.exitCode = Number.isInteger(code) ? code : 1
  })
}

if (require.main === module) run()

module.exports = {
  buildWeComDevLaunch,
  desktopRoot,
  hermesRoot
}
