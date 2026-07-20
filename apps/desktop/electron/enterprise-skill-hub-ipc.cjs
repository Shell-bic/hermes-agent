const {
  createEnterprisePublicError,
  enterprisePublicFailure,
  enterprisePublicResult
} = require('./enterprise-public-error.cjs')

function createEnterpriseSkillHubIpcHandler(options = {}) {
  const getLifecycle = options.getLifecycle
  const isEnabled = options.isEnabled || (() => false)
  const assertTrusted = options.assertTrusted
  const rememberLog = options.rememberLog || (() => {})

  function lifecycle() {
    const current = getLifecycle?.()
    if (!current?.getSnapshot || !current?.revoke) {
      throw new TypeError('Enterprise Skill Hub IPC requires a managed lifecycle.')
    }
    return current
  }

  function safeLifecycleSnapshot() {
    try {
      return getLifecycle?.()?.getSnapshot?.() || null
    } catch {
      return null
    }
  }

  function failure(error, publicOptions = {}) {
    return enterprisePublicFailure(
      createEnterprisePublicError(error, {
        lifecycle: safeLifecycleSnapshot(),
        operationEpoch: error?.lifecycleEpoch,
        ...publicOptions
      })
    )
  }

  async function run(event, operation) {
    try {
      if (typeof assertTrusted !== 'function') throw new Error('trust boundary missing')
      assertTrusted(event)
    } catch {
      rememberLog('[enterprise-skill-hub] rejected untrusted renderer IPC')
      return failure({ code: 'enterprise_skill_hub_untrusted_renderer', status: 403 })
    }
    if (!isEnabled()) {
      return failure({ code: 'enterprise_skill_hub_disabled' })
    }
    if (typeof operation !== 'function') {
      return failure({ code: 'enterprise_operation_failed' })
    }

    try {
      return enterprisePublicResult(await operation())
    } catch (error) {
      rememberLog(`[enterprise-skill-hub] ${error?.code || 'error'} status=${error?.status || 'n/a'}`)
      const status = Number(error?.status ?? error?.statusCode ?? error?.httpStatus)
      let currentLifecycle = null
      try {
        currentLifecycle = lifecycle()
      } catch {
        // The public envelope remains available during early startup and
        // teardown even when the lifecycle owner is not initialized.
      }
      const state = currentLifecycle?.getSnapshot().state
      let terminalTransition = false
      if (currentLifecycle && (status === 401 || status === 403 || status === 426) && (state === 'running' || state === 'recovering')) {
        await currentLifecycle.revoke({
          reasonCode:
            status === 401
              ? 'enterprise_auth_expired'
              : status === 426
                ? 'enterprise_contract_upgrade_required'
                : 'enterprise_policy_denied',
          terminalState: status === 401 ? 'unauthenticated' : 'blocked'
        })
        terminalTransition = true
      }
      return failure(error, { useCurrentEpoch: terminalTransition })
    }
  }

  return Object.freeze({ run })
}

function registerEnterpriseSkillHubIpc(options = {}) {
  const { hub, ipcMain } = options
  if (!ipcMain?.handle || !hub?.list || !hub?.detail || !hub?.install) {
    throw new TypeError('Enterprise Skill Hub IPC wiring is incomplete.')
  }
  const handler = createEnterpriseSkillHubIpcHandler(options)
  ipcMain.handle('hermes:enterprise:skill-hub:list', (event, query) =>
    handler.run(event, () => hub.list(query || {})))
  ipcMain.handle('hermes:enterprise:skill-hub:detail', (event, key) =>
    handler.run(event, () => hub.detail(key)))
  ipcMain.handle('hermes:enterprise:skill-hub:install', (event, payload) =>
    handler.run(event, () => hub.install(payload || {})))
  return handler
}

module.exports = { createEnterpriseSkillHubIpcHandler, registerEnterpriseSkillHubIpc }
