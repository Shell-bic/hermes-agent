#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const path = require('node:path')

if (!String(process.env.HERMES_DESKTOP_BOOTSTRAP_FIXTURE_DIR || '').trim()) {
  process.stderr.write('NOT_RUN fixture_directory_required\n')
  process.exitCode = 2
} else {
  const result = spawnSync(
    process.execPath,
    ['--test', path.join(__dirname, '..', 'electron', 'desktop-bootstrap-fixture-consumer.test.cjs')],
    {
      env: process.env,
      shell: false,
      stdio: 'inherit'
    }
  )

  process.exitCode = result.signal ? 1 : (result.status ?? 1)
}
