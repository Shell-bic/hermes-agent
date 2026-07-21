const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')

test('the static renderer shell covers the first paint with the connecting state', () => {
  assert.match(
    html,
    /<div id="root"[^>]*>[\s\S]*<div id="hermes-startup-splash"[^>]*><span>CONNECTING<\/span><\/div>[\s\S]*<\/div>/
  )
  assert.match(html, /#hermes-startup-splash\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;/)
  assert.match(html, /--hermes-boot-background/)
})
