const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { isTrustedRendererUrl } = require('./renderer-trust.cjs')

test('dev renderer trust compares parsed origins and rejects a userinfo lookalike URL', () => {
  const devServer = 'http://127.0.0.1:5174'

  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5174/?win=secondary#/chat', { devServer }), true)
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5174@evil.example/payload', { devServer }), false)
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5175/', { devServer }), false)
})

test('packaged renderer trust accepts only the configured entry file URL', () => {
  const rendererEntryUrl = pathToFileURL(path.resolve('dist', 'index.html')).toString()
  const wrongFileUrl = pathToFileURL(path.resolve('dist', 'other.html')).toString()

  assert.equal(isTrustedRendererUrl(`${rendererEntryUrl}?win=secondary#/chat`, { rendererEntryUrl }), true)
  assert.equal(isTrustedRendererUrl(wrongFileUrl, { rendererEntryUrl }), false)
  assert.equal(isTrustedRendererUrl(`${rendererEntryUrl}.untrusted`, { rendererEntryUrl }), false)
})
