const { spawn } = require('node:child_process')
const path = require('node:path')

const WEBSTORAGE_DISABLE_FLAG = '--no-experimental-webstorage'

function nodeMajorVersion() {
  return Number.parseInt(process.versions.node.split('.')[0], 10)
}

function childNodeOptions() {
  const current = String(process.env.NODE_OPTIONS || '').trim()
  if (nodeMajorVersion() < 22 || current.split(/\s+/).includes(WEBSTORAGE_DISABLE_FLAG)) {
    return current
  }

  return [current, WEBSTORAGE_DISABLE_FLAG].filter(Boolean).join(' ')
}

function looksLikeTestTarget(value) {
  const normalized = String(value || '').replace(/\\/g, '/')

  return normalized === 'src' ||
    normalized.startsWith('src/') ||
    normalized.startsWith('./') ||
    normalized.startsWith('../') ||
    path.isAbsolute(value) ||
    /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(normalized)
}

function vitestArguments(rawArguments) {
  const forwarded = rawArguments.filter(argument => argument !== '--run')
  const targets = forwarded.some(looksLikeTestTarget) ? [] : ['src']

  return ['run', '--environment', 'jsdom', ...targets, ...forwarded]
}

function vitestEntrypoint() {
  const packagePath = require.resolve('vitest/package.json')
  const packageJson = require(packagePath)
  const relativeEntrypoint = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.vitest

  if (!relativeEntrypoint) {
    throw new Error('The installed Vitest package does not expose its CLI entrypoint.')
  }

  return path.resolve(path.dirname(packagePath), relativeEntrypoint)
}

function run() {
  const env = { ...process.env }
  const nodeOptions = childNodeOptions()

  if (nodeOptions) {
    env.NODE_OPTIONS = nodeOptions
  }

  const child = spawn(
    process.execPath,
    [vitestEntrypoint(), ...vitestArguments(process.argv.slice(2))],
    {
      env,
      shell: false,
      stdio: 'inherit'
    }
  )

  child.once('error', error => {
    console.error(`[test:ui] failed to start Vitest: ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    if (signal) {
      console.error(`[test:ui] Vitest exited from signal ${signal}.`)
      process.exitCode = 1
      return
    }

    process.exitCode = code ?? 1
  })
}

run()
