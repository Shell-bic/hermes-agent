const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function filesUnder(root, directory = root) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(root, fullPath))
    else if (entry.isFile()) files.push(path.relative(root, fullPath).split(path.sep).join('/'))
  }
  return files.sort()
}

function verifyMirror(gatewayRoot) {
  const authority = path.resolve(gatewayRoot, 'contracts/wecom-personal-bot/v1')
  const mirror = path.resolve(__dirname, '../../../contracts/wecom-personal-bot/v1')
  assert.ok(fs.statSync(authority).isDirectory(), `Gateway authority not found: ${authority}`)
  assert.deepEqual(filesUnder(mirror), filesUnder(authority), 'Contract file lists differ')
  for (const relativePath of filesUnder(authority)) {
    assert.ok(
      fs.readFileSync(path.join(authority, relativePath)).equals(fs.readFileSync(path.join(mirror, relativePath))),
      `Contract bytes differ: ${relativePath}`
    )
  }
  return filesUnder(authority).length
}

if (require.main === module) {
  const gatewayRoot = process.argv[2]
  if (!gatewayRoot) throw new Error('Usage: node verify-wecom-personal-bot-contract-mirror.cjs <gateway-repository-root>')
  const count = verifyMirror(gatewayRoot)
  process.stdout.write(`Verified ${count} byte-identical WeCom personal bot contract files.\n`)
}

module.exports = { verifyMirror }
