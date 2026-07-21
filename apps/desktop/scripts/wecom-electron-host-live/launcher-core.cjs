const fs = require('node:fs')
const path = require('node:path')
const { ELECTRON_VERSION, ProtocolError, createResult } = require('./protocol.cjs')

const ISOLATED_DIRECTORIES = Object.freeze(['profile', 'session-data', 'logs', 'crash-dumps', 'cache'])

function electronExecutable(baseDirectory = __dirname) {
  const name = process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : 'electron'
  return path.resolve(baseDirectory, '..', '..', 'node_modules', 'electron', 'dist', name)
}

function electronPackagePath(baseDirectory = __dirname) {
  return path.resolve(baseDirectory, '..', '..', 'node_modules', 'electron', 'package.json')
}

function verifyPinnedElectron(baseDirectory = __dirname) {
  const binary = electronExecutable(baseDirectory)
  const packagePath = electronPackagePath(baseDirectory)
  if (!fs.existsSync(binary) || !fs.existsSync(packagePath)) throw new ProtocolError('electron_unavailable')
  let version
  try {
    version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version
  } catch {
    throw new ProtocolError('electron_unavailable')
  }
  if (version !== ELECTRON_VERSION) throw new ProtocolError('electron_unavailable')
  return binary
}

function createIsolatedProfile(profileRoot) {
  fs.mkdirSync(profileRoot, { recursive: false })
  const paths = {}
  for (const name of ISOLATED_DIRECTORIES) {
    const directory = path.join(profileRoot, name)
    fs.mkdirSync(directory, { recursive: false })
    paths[name] = directory
  }
  return paths
}

function childEnvironment(source = process.env) {
  const allowed = [
    'APPDATA', 'ComSpec', 'HOME', 'LANG', 'LC_ALL', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS',
    'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'ProgramData', 'SystemRoot', 'TEMP', 'TMP',
    'USERPROFILE', 'WINDIR'
  ]
  const environment = {}
  for (const name of allowed) {
    if (typeof source[name] === 'string' && source[name]) environment[name] = source[name]
  }
  return environment
}

function childArguments(baseDirectory = __dirname) {
  return [path.join(baseDirectory, 'electron-live-main.cjs')]
}

function bootstrapArguments(baseDirectory = __dirname) {
  return [path.join(baseDirectory, 'electron-bootstrap.cjs')]
}

function finishedAtUtc() {
  return new Date().toISOString().replace(/\.(\d{3})Z$/u, (_match, milliseconds) => `.${milliseconds}0000+00:00`)
}

function producerMarker(runId, producerPid) {
  if (!Number.isSafeInteger(producerPid) || producerPid <= 0) throw new ProtocolError('producer_marker_failed')
  return {
    schemaVersion: 'wecom-bot-pilot-producer-marker.v1',
    runId,
    category: 'electron_auth_profile',
    producer: 'electron-auth-probe',
    producerPid,
    quiescent: true,
    finishedAt: finishedAtUtc()
  }
}

function writeProducerMarker(profileRoot, runId, producerPid) {
  const marker = producerMarker(runId, producerPid)
  fs.writeFileSync(path.join(profileRoot, '.wecom-pb02-producer.json'), `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  })
  return marker
}

function finalRecordFromChild(childRecord, markerWritten) {
  return createResult({
    result: childRecord.result,
    failureCode: childRecord.failureCode,
    electronVersion: childRecord.electronVersion,
    popupCreated: childRecord.popupCreated,
    officialOriginObserved: childRecord.officialOriginObserved,
    navigationPolicyPassed: childRecord.navigationPolicyPassed,
    cleanupStatus: 'retained',
    producerMarkerStatus: markerWritten ? 'operator_asserted' : 'not_written'
  })
}

function sanitizedFailure(code, state = {}) {
  return createResult({
    result: 'FAIL',
    failureCode: typeof code === 'string' && /^[a-z0-9_]{1,64}$/u.test(code) ? code : 'internal_failure',
    electronVersion: state.electronVersion,
    popupCreated: state.popupCreated,
    officialOriginObserved: state.officialOriginObserved,
    navigationPolicyPassed: state.navigationPolicyPassed,
    cleanupStatus: state.cleanupStatus,
    producerMarkerStatus: state.producerMarkerStatus
  })
}

module.exports = {
  ISOLATED_DIRECTORIES,
  bootstrapArguments,
  childArguments,
  childEnvironment,
  createIsolatedProfile,
  electronExecutable,
  electronPackagePath,
  finalRecordFromChild,
  producerMarker,
  sanitizedFailure,
  verifyPinnedElectron,
  writeProducerMarker
}
