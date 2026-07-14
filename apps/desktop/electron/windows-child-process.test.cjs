'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ELECTRON_DIR = __dirname

function readElectronFile(name) {
  return fs.readFileSync(path.join(ELECTRON_DIR, name), 'utf8').replace(/\r\n/g, '\n')
}

function requireHiddenChildOptions(source, callSite) {
  const match = source.match(callSite)
  const index = match?.index ?? -1
  assert.notEqual(index, -1, `missing call site: ${callSite}`)
  const snippet = source.slice(index, index + 700)
  assert.match(
    snippet,
    /hiddenWindowsChildOptions\(/,
    `expected ${callSite} to wrap child-process options with hiddenWindowsChildOptions`
  )
}

test('desktop background child processes opt into hidden Windows consoles', () => {
  const source = readElectronFile('main.cjs')

  assert.match(source, /function hiddenWindowsChildOptions\(options = \{\}\)/)

  requireHiddenChildOptions(source, /execFileSync\(\s*'reg'/)
  requireHiddenChildOptions(source, /execFileSync\(\s*pyExe,/)
  requireHiddenChildOptions(source, /const child = spawn\(\s*resolveGitBinary\(\),/)
  requireHiddenChildOptions(source, /execFileSync\(\s*'taskkill'/)
  requireHiddenChildOptions(source, /child = spawn\(\s*command,\s*args,/)
  requireHiddenChildOptions(source, /spawn\(\s*'curl',\s*args,/)
  requireHiddenChildOptions(source, /const child = spawn\(\s*backend\.command,\s*backend\.args,/)
  requireHiddenChildOptions(source, /hermesProcess = spawn\(\s*backend\.command,\s*backend\.args,/)
  requireHiddenChildOptions(source, /const child = spawn\(\s*py,\s*\['-m', 'hermes_cli\.main', 'uninstall', '--gui-summary'\],/)
})

test('intentional or interactive desktop child processes stay documented', () => {
  const source = readElectronFile('main.cjs')

  assert.match(source, /windowsHide: false/)
  assert.match(source, /handOffWindowsBootstrapRecovery/)
  assert.match(source, /'--repair', '--branch'/)
  assert.match(source, /'--update', '--branch'/)
  assert.match(source, /nodePty\.spawn\(command, args/)
  assert.match(source, /spawn\('cmd\.exe', \['\/c', 'start'/)
})

test('bootstrap PowerShell runner hides Windows console children', () => {
  const source = readElectronFile('bootstrap-runner.cjs')

  assert.match(source, /function hiddenWindowsChildOptions\(options = \{\}\)/)
  requireHiddenChildOptions(source, /spawn\(\s*ps,\s*fullArgs,/)
})
