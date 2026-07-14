const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { finished } = require('node:stream/promises')

const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
const SHA256_RE = /^[a-f0-9]{64}$/i

class EnterpriseSkillHubError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'EnterpriseSkillHubError'
    this.code = code || 'enterprise_skill_hub_error'
    this.status = options.status || null
  }
}

function publicError(error) {
  return {
    code: String(error?.code || 'enterprise_skill_hub_error'),
    message: String(error?.message || 'Enterprise Skill Hub request failed.'),
    status: Number.isFinite(error?.status) ? error.status : null
  }
}

function encodePathSegment(value, label) {
  const text = String(value || '').trim()
  if (!text || text.includes('/') || text.includes('\\')) {
    throw new EnterpriseSkillHubError('invalid_request', `${label} is required.`)
  }
  return encodeURIComponent(text)
}

function integer(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function normalizePolicyStatus(value) {
  const status = String(value || '')
  return ['available', 'blocked', 'defaultEnabled', 'recommended', 'restricted', 'teamShared', 'userCreated'].includes(status)
    ? status
    : 'restricted'
}

function normalizeCatalogItem(value) {
  const item = value && typeof value === 'object' ? value : {}
  return {
    key: String(item.key || ''),
    name: String(item.name || item.key || ''),
    description: String(item.description || ''),
    category: String(item.category || ''),
    declaredVersion: item.declaredVersion == null ? null : String(item.declaredVersion),
    currentRevision: integer(item.currentRevision),
    artifactSha256: String(item.artifactSha256 || '').toLowerCase(),
    artifactSizeBytes: integer(item.artifactSizeBytes),
    fileCount: integer(item.fileCount),
    publishedAt: item.publishedAt == null ? null : String(item.publishedAt),
    policyStatus: normalizePolicyStatus(item.policyStatus),
    policyReason: item.policyReason == null ? null : String(item.policyReason)
  }
}

function normalizeInstalledItem(value) {
  const item = value && typeof value === 'object' ? value : {}
  const normalized = {
    key: String(item.key || ''),
    name: String(item.name || ''),
    revision: integer(item.revision),
    artifactSha256: String(item.artifactSha256 || '').toLowerCase(),
    state: String(item.state || '')
  }
  if (
    !normalized.key ||
    !normalized.name ||
    normalized.revision < 1 ||
    !SHA256_RE.test(normalized.artifactSha256) ||
    !normalized.state
  ) {
    throw new EnterpriseSkillHubError(
      'local_install_response_invalid',
      'The local Hermes backend returned an invalid enterprise skill install record.'
    )
  }
  return normalized
}

function installedItems(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : []
  return rows.map(normalizeInstalledItem).filter(item => item.key)
}

function withInstallState(item, installed) {
  const local = installed.find(row => row.key === item.key) || null
  const installedRevision = local?.revision || null
  const installedArtifactSha256 = local?.artifactSha256 || null
  let installState = 'not-installed'

  if (local) {
    installState =
      installedRevision === item.currentRevision && installedArtifactSha256 === item.artifactSha256
        ? 'installed'
        : 'update-not-supported'
  }

  return {
    ...item,
    installState,
    installedArtifactSha256,
    installedRevision
  }
}

async function readJsonResponse(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

async function responseError(response, fallbackCode) {
  const payload = await readJsonResponse(response).catch(() => null)
  const code = String(payload?.code || payload?.errorCode || fallbackCode || 'enterprise_skill_hub_error')
  const message = String(payload?.message || payload?.error || `${response.status} ${response.statusText}`.trim())
  return new EnterpriseSkillHubError(code, message, { status: response.status })
}

function requireDesktopToken(authStore) {
  const token = String(authStore?.readSession?.()?.desktopToken || '').trim()
  if (!token) {
    throw new EnterpriseSkillHubError('desktop_session_required', 'Sign in to your enterprise account to use Skill Hub.', {
      status: 401
    })
  }
  if (!token.startsWith('dsk_')) {
    throw new EnterpriseSkillHubError('desktop_session_required', 'The stored enterprise desktop session is invalid.', {
      status: 401
    })
  }
  return token
}

function catalogRows(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : []
  return rows.map(normalizeCatalogItem).filter(item => item.key && item.currentRevision > 0)
}

function normalizeCatalogPage(payload, installed) {
  const items = catalogRows(payload).map(item => withInstallState(item, installed))
  return {
    items,
    page: integer(payload?.page, 1) || 1,
    pageSize: integer(payload?.pageSize, items.length),
    total: integer(payload?.total, items.length)
  }
}

function validSha(value, label) {
  const sha = String(value || '').trim().toLowerCase()
  if (!SHA256_RE.test(sha)) {
    throw new EnterpriseSkillHubError('artifact_metadata_invalid', `${label} is missing or invalid.`)
  }
  return sha
}

async function writeVerifiedArtifact({ response, destination, expectedSha256, expectedSize, maxArtifactBytes }) {
  if (!response.ok) {
    throw await responseError(response, 'enterprise_skill_download_failed')
  }

  const contentLengthText = String(response.headers.get('content-length') || '').trim()
  const contentLength = Number(contentLengthText)
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new EnterpriseSkillHubError('artifact_length_missing', 'The package response did not include a valid Content-Length.')
  }
  if (contentLength > maxArtifactBytes || expectedSize > maxArtifactBytes) {
    throw new EnterpriseSkillHubError('artifact_too_large', 'The enterprise skill package exceeds the desktop size limit.')
  }
  if (expectedSize !== contentLength) {
    throw new EnterpriseSkillHubError('artifact_length_mismatch', 'The package length no longer matches the catalog metadata.')
  }

  const headerSha = validSha(
    response.headers.get('x-hermes-artifact-sha256'),
    'Package SHA-256 header'
  )
  if (headerSha !== expectedSha256) {
    throw new EnterpriseSkillHubError('artifact_hash_mismatch', 'The package SHA-256 header does not match the catalog.')
  }
  if (!response.body) {
    throw new EnterpriseSkillHubError('artifact_body_missing', 'The package response did not include a body.')
  }

  const hash = crypto.createHash('sha256')
  const output = fs.createWriteStream(destination, { flags: 'wx' })
  const outputFinished = finished(output)
  void outputFinished.catch(() => undefined)
  let bytes = 0

  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maxArtifactBytes || bytes > contentLength) {
        throw new EnterpriseSkillHubError('artifact_too_large', 'The package stream exceeded its declared size.')
      }
      hash.update(buffer)
      if (!output.write(buffer)) {
        await new Promise((resolve, reject) => {
          output.once('drain', resolve)
          output.once('error', reject)
        })
      }
    }
    output.end()
    await outputFinished
  } catch (error) {
    output.destroy()
    await outputFinished.catch(() => undefined)
    throw error
  }

  if (bytes !== contentLength || bytes !== expectedSize) {
    throw new EnterpriseSkillHubError('artifact_length_mismatch', 'The package download was truncated or changed in transit.')
  }
  const actualSha256 = hash.digest('hex')
  if (actualSha256 !== expectedSha256) {
    throw new EnterpriseSkillHubError('artifact_hash_mismatch', 'The downloaded package failed SHA-256 verification.')
  }
  return { artifactSha256: actualSha256, artifactSizeBytes: bytes }
}

class EnterpriseSkillHub {
  constructor({ authStore, client, fetchImpl = globalThis.fetch, localConnection, maxArtifactBytes } = {}) {
    this.authStore = authStore
    this.client = client
    this.fetchImpl = fetchImpl
    this.localConnection = localConnection
    this.maxArtifactBytes = integer(maxArtifactBytes, DEFAULT_MAX_ARTIFACT_BYTES) || DEFAULT_MAX_ARTIFACT_BYTES
  }

  async localRequest(pathname, options = {}) {
    if (typeof this.fetchImpl !== 'function' || typeof this.localConnection !== 'function') {
      throw new EnterpriseSkillHubError('local_backend_unavailable', 'The local Hermes backend is unavailable.')
    }
    const connection = await this.localConnection()
    const headers = {
      Accept: 'application/json',
      'X-Hermes-Session-Token': connection.token,
      ...(options.headers || {})
    }
    const response = await this.fetchImpl(`${connection.baseUrl}${pathname}`, {
      ...options,
      headers
    })
    if (!response.ok) {
      throw await responseError(response, 'enterprise_skill_install_failed')
    }
    return response
  }

  async getInstalled() {
    const response = await this.localRequest('/api/skills/enterprise/installed')
    return installedItems(await readJsonResponse(response))
  }

  async list(query = {}) {
    const token = requireDesktopToken(this.authStore)
    const [payload, installed] = await Promise.all([
      this.client.skillHubSkills(token, query),
      this.getInstalled().catch(error => {
        if (error?.status === 404) return []
        throw error
      })
    ])
    return normalizeCatalogPage(payload, installed)
  }

  async detail(key) {
    const token = requireDesktopToken(this.authStore)
    encodePathSegment(key, 'Skill key')
    const [payload, installed] = await Promise.all([
      this.client.skillHubSkill(token, key),
      this.getInstalled().catch(error => {
        if (error?.status === 404) return []
        throw error
      })
    ])
    return withInstallState(normalizeCatalogItem(payload), installed)
  }

  async install({ key, revision } = {}) {
    const token = requireDesktopToken(this.authStore)
    encodePathSegment(key, 'Skill key')
    const detail = normalizeCatalogItem(await this.client.skillHubSkill(token, key))
    const requestedRevision = integer(revision)

    if (!requestedRevision || requestedRevision !== detail.currentRevision) {
      throw new EnterpriseSkillHubError(
        'package_revision_changed',
        'A newer package revision is available. Refresh Enterprise Discovery and try again.',
        { status: 409 }
      )
    }
    if (detail.policyStatus === 'blocked' || detail.policyStatus === 'restricted') {
      throw new EnterpriseSkillHubError(
        'skill_policy_denied',
        detail.policyReason || 'Enterprise policy does not allow this skill to be installed.',
        { status: 403 }
      )
    }

    const expectedSha256 = validSha(detail.artifactSha256, 'Catalog artifact SHA-256')
    if (!detail.artifactSizeBytes) {
      throw new EnterpriseSkillHubError('artifact_metadata_invalid', 'The catalog package size is missing or invalid.')
    }

    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-enterprise-skill-'))
    const artifactPath = path.join(tempRoot, 'artifact.zip')
    try {
      const download = await this.client.downloadSkillPackage(token, detail.key, requestedRevision)
      const verified = await writeVerifiedArtifact({
        response: download,
        destination: artifactPath,
        expectedSha256,
        expectedSize: detail.artifactSizeBytes,
        maxArtifactBytes: this.maxArtifactBytes
      })
      const installPath = `/api/skills/enterprise/install?key=${encodeURIComponent(detail.key)}&revision=${requestedRevision}`
      const response = await this.localRequest(installPath, {
        body: fs.createReadStream(artifactPath),
        duplex: 'half',
        headers: {
          'Content-Length': String(verified.artifactSizeBytes),
          'Content-Type': 'application/zip',
          'X-Hermes-Artifact-Sha256': verified.artifactSha256
        },
        method: 'POST'
      })
      const installed = normalizeInstalledItem(await readJsonResponse(response))
      return {
        item: withInstallState(detail, [installed]),
        installed
      }
    } finally {
      await fs.promises.rm(tempRoot, { force: true, recursive: true }).catch(() => undefined)
    }
  }
}

function createEnterpriseSkillHub(options) {
  return new EnterpriseSkillHub(options)
}

module.exports = {
  DEFAULT_MAX_ARTIFACT_BYTES,
  EnterpriseSkillHub,
  EnterpriseSkillHubError,
  catalogRows,
  createEnterpriseSkillHub,
  normalizeCatalogItem,
  normalizeInstalledItem,
  publicError,
  requireDesktopToken,
  withInstallState,
  writeVerifiedArtifact
}
