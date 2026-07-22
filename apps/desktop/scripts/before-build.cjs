/**
 * Desktop bundles ship precompiled renderer assets. Returning false here tells
 * electron-builder to skip the node_modules collector/install step, which
 * avoids workspace dependency graph explosions and keeps packaging
 * deterministic across environments. Enterprise offline builds stage the
 * Hermes Agent Python payload separately under build/offline-runtime; regular
 * builds retain the install.ps1 first-launch protocol. See electron/main.cjs.
 */
module.exports = async function beforeBuild() {
  return false
}
