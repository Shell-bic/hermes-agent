#!/usr/bin/env node

const { runCli } = require('../electron/desktop-bootstrap-fixture-consumer.cjs')

runCli(process.argv.slice(2)).then(
  exitCode => {
    process.exitCode = exitCode
  },
  () => {
    process.stderr.write('FAIL fixture_consumer_failed\n')
    process.exitCode = 1
  }
)
