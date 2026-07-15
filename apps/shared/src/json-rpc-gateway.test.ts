import { describe, expect, it } from 'vitest'

import { JsonRpcGatewayClient, JsonRpcGatewayError } from './json-rpc-gateway'

type Listener = (event: { data?: string }) => void

class FakeSocket {
  readonly sent: string[] = []
  readyState: number = WebSocket.CONNECTING
  private readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }

  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data })
    }
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.emit('open')
  }

  send(payload: string): void {
    this.sent.push(payload)
  }
}

describe('JsonRpcGatewayClient errors', () => {
  it('preserves the numeric JSON-RPC error code on the rejected Error', async () => {
    const socket = new FakeSocket()
    const client = new JsonRpcGatewayClient({
      socketFactory: () => socket as unknown as WebSocket
    })
    const connecting = client.connect('ws://gateway.test')
    socket.open()
    await connecting

    const pending = client.request('slash.exec', { command: 'review-pack' })
    const request = JSON.parse(socket.sent[0]!) as { id: string }
    socket.emit(
      'message',
      JSON.stringify({
        error: { code: 4018, message: 'bundle command: use command.dispatch for /review-pack' },
        id: request.id,
        jsonrpc: '2.0'
      })
    )

    await expect(pending).rejects.toEqual(
      expect.objectContaining<JsonRpcGatewayError>({
        code: 4018,
        message: 'bundle command: use command.dispatch for /review-pack',
        name: 'JsonRpcGatewayError'
      })
    )
  })
})
