const { spawn } = require('node:child_process')
const path = require('node:path')

const MONITOR_TIMEOUT_MS = 20_000
const LINE_LIMIT = 1024

function waitForLine(stream, predicate, timeoutMs = MONITOR_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.readableEnded) {
      reject(new Error('tree_monitor_failed'))
      return
    }
    let buffer = ''
    const timer = setTimeout(() => finish(new Error('tree_monitor_timeout')), timeoutMs)
    const onData = chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > LINE_LIMIT) return finish(new Error('tree_monitor_output_invalid'))
      const lines = buffer.split(/\r?\n/u)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (line.startsWith('FAIL ')) return finish(new Error('tree_monitor_failed'))
        if (predicate(line)) return finish(null, line)
      }
    }
    const onExit = () => finish(new Error('tree_monitor_failed'))
    const finish = (error, line) => {
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('close', onExit)
      if (error) reject(error)
      else resolve(line)
    }
    stream.setEncoding('utf8')
    stream.on('data', onData)
    stream.on('close', onExit)
  })
}

class WindowsProcessHandleMonitor {
  constructor(process, bootstrapReady) {
    this.process = process
    this.bootstrapReady = bootstrapReady
    this.ready = null
    this.commandChain = Promise.resolve()
    this.quiescePromise = null
  }

  static prepare(environment, baseDirectory = __dirname) {
    const script = path.join(baseDirectory, 'windows-process-handle-monitor.ps1')
    const guard = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
      cwd: baseDirectory,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stderrBytes = 0
    guard.stderr.on('data', chunk => {
      stderrBytes += chunk.length
      if (stderrBytes > LINE_LIMIT) guard.kill()
    })
    guard.stdin.on('error', () => {})
    const bootstrapReady = waitForLine(guard.stdout, line => line === 'MONITOR_READY')
    return new WindowsProcessHandleMonitor(guard, bootstrapReady)
  }

  attach(rootPid, launcherPid = process.pid) {
    if (this.ready) return this.ready
    if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || !Number.isSafeInteger(launcherPid) || launcherPid <= 0) {
      return Promise.reject(new Error('tree_monitor_failed'))
    }
    this.ready = (async () => {
      await this.bootstrapReady
      const ready = waitForLine(this.process.stdout, line => line === 'READY')
      this.process.stdin.write(`ATTACH ${launcherPid} ${rootPid}\n`)
      await ready
    })()
    return this.ready
  }

  enqueue(command) {
    const operation = this.commandChain.then(async () => {
      await this.ready
      return command()
    })
    this.commandChain = operation.catch(() => {})
    return operation
  }

  pinElectronRoot(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new Error('tree_monitor_failed'))
    return this.enqueue(async () => {
      const response = waitForLine(this.process.stdout, line => /^ROOT_PINNED [1-9][0-9]*$/u.test(line))
      this.process.stdin.write(`ELECTRON_ROOT ${pid}\n`)
      const line = await response
      return Number(line.slice('ROOT_PINNED '.length))
    })
  }

  pinSnapshot(sequence, sampledAtFileTime, pids) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0 || !Array.isArray(pids) || pids.length < 1 || pids.length > 64 ||
        typeof sampledAtFileTime !== 'string' || !/^[1-9][0-9]{16,18}$/u.test(sampledAtFileTime) ||
        pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0) || new Set(pids).size !== pids.length) {
      return Promise.reject(new Error('tree_monitor_failed'))
    }
    const sorted = [...pids].sort((left, right) => left - right)
    return this.enqueue(async () => {
      const response = waitForLine(this.process.stdout, line => line.startsWith(`PINNED ${sequence} `))
      this.process.stdin.write(`PIN ${sequence} ${sampledAtFileTime} ${sorted.join(',')}\n`)
      const line = await response
      const count = Number(line.slice(`PINNED ${sequence} `.length))
      if (!Number.isSafeInteger(count) || count < 2) throw new Error('tree_monitor_failed')
      return count
    })
  }

  async quiesce() {
    if (this.quiescePromise) return this.quiescePromise
    this.quiescePromise = (async () => {
      try {
        await this.ready
        await this.commandChain
        const response = waitForLine(this.process.stdout, line => /^QUIESCENT [1-9][0-9]*$/u.test(line))
        this.process.stdin.write('QUIESCE\n')
        const line = await response
        const count = Number(line.slice('QUIESCENT '.length))
        const exitCode = await new Promise(resolve => {
          if (this.process.exitCode !== null) resolve(this.process.exitCode)
          else this.process.once('close', resolve)
        })
        if (exitCode !== 0 || !Number.isSafeInteger(count) || count < 1) throw new Error('tree_monitor_failed')
        return { quiescent: true, capturedProcessCount: count }
      } catch (error) {
        this.dispose()
        throw error
      }
    })()
    return this.quiescePromise
  }

  dispose() {
    try { this.process.stdin.end() } catch {}
    if (this.process.exitCode === null && this.process.signalCode === null) {
      try { this.process.kill() } catch {}
    }
  }
}

class PosixTreeGuard {
  constructor(rootPid) {
    this.rootPid = rootPid
    this.ready = Promise.resolve()
    this.quiescePromise = null
  }

  pinElectronRoot(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new Error('tree_monitor_failed'))
    return Promise.resolve(2)
  }

  pinSnapshot(sequence, sampledAtFileTime, pids) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0 || typeof sampledAtFileTime !== 'string' ||
        !Array.isArray(pids) || pids.length < 1) return Promise.reject(new Error('tree_monitor_failed'))
    return Promise.resolve(Math.max(2, pids.length))
  }

  async quiesce() {
    if (this.quiescePromise) return this.quiescePromise
    this.quiescePromise = (async () => {
      const group = -this.rootPid
      try { process.kill(group, 'SIGTERM') } catch (error) { if (error?.code !== 'ESRCH') throw error }
      const started = Date.now()
      while (Date.now() - started < 5_000) {
        try { process.kill(group, 0) } catch (error) {
          if (error?.code === 'ESRCH') return { quiescent: true, capturedProcessCount: 1 }
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      try { process.kill(group, 'SIGKILL') } catch (error) { if (error?.code !== 'ESRCH') throw error }
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try { process.kill(group, 0) } catch (error) {
          if (error?.code === 'ESRCH') return { quiescent: true, capturedProcessCount: 1 }
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error('tree_not_quiescent')
    })()
    return this.quiescePromise
  }
}

function attachProcessTree(rootPid, environment, baseDirectory = __dirname) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('tree_monitor_failed')
  if (process.platform === 'win32') throw new Error('windows_tree_monitor_must_be_prepared')
  return new PosixTreeGuard(rootPid)
}

function prepareProcessTree(environment, baseDirectory = __dirname) {
  return process.platform === 'win32'
    ? WindowsProcessHandleMonitor.prepare(environment, baseDirectory)
    : null
}

function childProcessOptions() {
  return process.platform === 'win32' ? {} : { detached: true }
}

module.exports = {
  MONITOR_TIMEOUT_MS,
  PosixTreeGuard,
  WindowsProcessHandleMonitor,
  attachProcessTree,
  childProcessOptions,
  prepareProcessTree,
  waitForLine
}
