window.addEventListener('message', async event => {
  const acknowledgement = event.ports[0]
  const dispatch = new MessageChannel()
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('parent dispatch acknowledgement timed out')), 2_000)
    dispatch.port1.onmessage = response => {
      clearTimeout(timeout)
      dispatch.port1.close()
      if (response.data !== 'dispatched') reject(new Error('invalid parent dispatch acknowledgement'))
      else resolve()
    }
    dispatch.port1.start()
  })
  window.parent.postMessage(event.data.data, event.data.targetOrigin, [dispatch.port2])
  await done
  acknowledgement?.postMessage('dispatched')
  acknowledgement?.close()
})
