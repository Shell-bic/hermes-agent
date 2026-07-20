function parseJsonResponse({ chunks, headers = {}, statusCode = 500, statusMessage = '', url }) {
  const text = Buffer.concat(chunks).toString('utf8')
  if (statusCode >= 400) {
    const error = new Error(`${statusCode}: ${text || statusMessage}`)
    error.statusCode = statusCode
    throw error
  }
  if (!text) return null
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '')
  if (/^\s*<(?:!doctype|html)/i.test(text) || contentType.includes('text/html')) {
    throw new Error(`Expected JSON from ${url} but got HTML (status ${statusCode}).`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Invalid JSON from ${url} (status ${statusCode}): ${text.slice(0, 200)}`)
  }
}

function canceledError() {
  return Object.assign(new Error('Enterprise REST request was canceled.'), { code: 'request-canceled' })
}

function timeoutError(timeoutMs) {
  return Object.assign(new Error(`Timed out connecting to Hermes backend after ${timeoutMs}ms`), {
    code: 'gateway-timeout'
  })
}

function incompleteResponseError() {
  return Object.assign(new Error('Hermes backend closed the response before it completed.'), {
    code: 'gateway-offline'
  })
}

function createNodeJsonFetcher({ defaultTimeoutMs, http, https, resolveTimeoutMs }) {
  return function fetchJson(url, token, options = {}) {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(canceledError())
        return
      }
      let parsed
      try {
        parsed = new URL(url)
      } catch (error) {
        reject(new Error(`Invalid URL: ${error.message}`))
        return
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        reject(new Error(`Unsupported Hermes backend URL protocol: ${parsed.protocol}`))
        return
      }

      const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
      const signal = options.signal
      let settled = false
      let response = null
      let request = null
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener?.('abort', abort)
        callback(value)
      }
      const fail = error => finish(reject, error)
      const succeed = value => finish(resolve, value)
      const abort = () => {
        const error = canceledError()
        response?.destroy?.(error)
        request?.destroy?.(error)
        fail(error)
      }

      request = (parsed.protocol === 'https:' ? https : http).request(
        parsed,
        {
          method: options.method || 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Hermes-Session-Token': token,
            ...(body ? { 'Content-Length': String(body.length) } : {})
          }
        },
        res => {
          response = res
          const chunks = []
          let ended = false
          res.on('error', fail)
          res.on('aborted', () => fail(incompleteResponseError()))
          res.on('close', () => {
            if (!ended) fail(incompleteResponseError())
          })
          res.on('data', chunk => chunks.push(Buffer.from(chunk)))
          res.on('end', () => {
            if (settled) return
            ended = true
            try {
              succeed(parseJsonResponse({
                chunks,
                headers: res.headers,
                statusCode: res.statusCode || 500,
                statusMessage: res.statusMessage,
                url
              }))
            } catch (error) {
              fail(error)
            }
          })
        }
      )

      signal?.addEventListener?.('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }
      request.on('error', fail)
      const timeoutMs = resolveTimeoutMs(options.timeoutMs, defaultTimeoutMs)
      request.setTimeout(timeoutMs, () => request.destroy(timeoutError(timeoutMs)))
      if (body) request.write(body)
      request.end()
    })
  }
}

module.exports = { createNodeJsonFetcher }
