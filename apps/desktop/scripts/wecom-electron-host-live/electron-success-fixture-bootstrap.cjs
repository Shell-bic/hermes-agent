const { spawn } = require('node:child_process')
const path = require('node:path')
const { childEnvironment, electronExecutable } = require('./launcher-core.cjs')

const fixtureEnvironment = {
  ...childEnvironment(),
  PB02_FIXTURE_SCENARIO: process.env.PB02_FIXTURE_SCENARIO,
  PB02_FIXTURE_PROFILE: process.env.PB02_FIXTURE_PROFILE,
  PB02_FIXTURE_PFX: process.env.PB02_FIXTURE_PFX,
  PB02_FIXTURE_PFX_PASSWORD: process.env.PB02_FIXTURE_PFX_PASSWORD
}

const electron = spawn(electronExecutable(__dirname), [path.join(__dirname, 'electron-success-fixture-main.cjs')], {
  cwd: path.resolve(__dirname, '..', '..'),
  env: fixtureEnvironment,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  windowsHide: false
})

electron.stdout.pipe(process.stdout)
electron.stderr.pipe(process.stderr)
if (process.connected) process.send({ kind: 'electron_producer', pid: electron.pid })
electron.on('message', message => {
  if (process.connected) process.send(message, error => { if (error) electron.kill() })
})
electron.on('error', () => process.exit(1))
electron.on('close', code => process.exit(code === 0 ? 0 : 1))

process.on('message', message => {
  if (!electron.connected) return process.exit(1)
  electron.send(message, error => { if (error) process.exit(1) })
})
process.on('disconnect', () => {
  if (electron.exitCode === null && electron.signalCode === null) electron.kill()
  process.exit(1)
})
