const expectedState = document.documentElement.dataset.expectedState
const expectedAuthOrigin = document.documentElement.dataset.expectedAuthOrigin
const observations = { openCalls: 0, openError: null, reached: [], securityViolations: [] }
const nativeOpen = window.open.bind(window)
let lastOpenedWindow = null
let observationListenerInstalled = false
window.open = (...args) => {
  observations.openCalls += 1
  try {
    lastOpenedWindow = nativeOpen(...args)
    if (!observationListenerInstalled) {
      observationListenerInstalled = true
      // The reviewed bundle installs its capture gate before it calls
      // window.open. Registering here proves blocked events cannot reach a
      // later application listener.
      window.addEventListener('message', event => {
        if (event.data?.probe !== 'pb02-electron-host-smoke') return
        observations.reached.push({ origin: event.origin, type: event.data?.type || null })
      })
    }
    return lastOpenedWindow
  } catch (error) {
    observations.openError = error?.name || 'Error'
    throw error
  }
}

window.addEventListener('securitypolicyviolation', event => {
  observations.securityViolations.push(event.violatedDirective)
})

// Acknowledgement runs from a microtask, after every synchronous listener for
// the message (including the reviewed capture gate) has returned.
window.addEventListener('message', event => {
  if (event.data?.probe !== 'pb02-electron-host-smoke') return
  const port = event.ports[0]
  queueMicrotask(() => {
    port?.postMessage('dispatched')
    port?.close()
  })
}, true)

async function dispatchViaFrame(origin, data) {
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.src = `${origin}/frame.html`
  document.body.append(frame)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('frame load timed out')), 2_000)
    frame.addEventListener('load', () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
  })
  const channel = new MessageChannel()
  const dispatched = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('frame dispatch timed out')), 2_000)
    channel.port1.onmessage = event => {
      clearTimeout(timeout)
      channel.port1.close()
      if (event.data !== 'dispatched') reject(new Error('invalid frame dispatch acknowledgement'))
      else resolve()
    }
    channel.port1.start()
  })
  frame.contentWindow.postMessage({ data, targetOrigin: location.origin }, origin, [channel.port2])
  await dispatched
  frame.remove()
}

async function verifyCsp() {
  const nextViolation = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CSP violation was not observed')), 2_000)
    window.addEventListener('securitypolicyviolation', event => {
      clearTimeout(timeout)
      resolve(event.violatedDirective)
    }, { once: true })
  })

  const inlineViolation = nextViolation()
  const script = document.createElement('script')
  script.textContent = 'window.__pb02InlineScriptRan = true'
  document.head.append(script)
  const inlineDirective = await inlineViolation
  script.remove()

  let evalBlocked = false
  const evalViolation = nextViolation()
  try {
    window.eval('window.__pb02EvalRan = true')
  } catch (error) {
    evalBlocked = error?.name === 'EvalError'
  }
  const evalDirective = await evalViolation

  const connectViolation = nextViolation()
  let externalConnectBlocked = false
  try {
    await fetch('https://evil.invalid/csp-connect')
  } catch {
    externalConnectBlocked = true
  }
  const connectDirective = await connectViolation

  return {
    directives: [inlineDirective, evalDirective, connectDirective],
    inlineScriptRan: window.__pb02InlineScriptRan === true,
    evalBlocked: evalBlocked && window.__pb02EvalRan !== true,
    externalConnectBlocked
  }
}

window.pb02Probe = Object.freeze({
  attemptWindow(url) {
    return window.open(url, 'pb02-forbidden-window') === null
  },
  clickStart() {
    document.getElementById('bot-auth-start').click()
  },
  dispatchViaFrame,
  dispatchWrongOriginWithRealPopup(data) {
    if (!lastOpenedWindow) throw new Error('real popup WindowProxy is unavailable')
    window.dispatchEvent(new MessageEvent('message', {
      data,
      origin: location.origin,
      source: lastOpenedWindow
    }))
  },
  expectedAuthOrigin,
  expectedState,
  observations,
  verifyCsp
})
