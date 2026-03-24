import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SocketClient } from '../../proxy/socket-client'
import { encodeMessage, type DaemonMessage, type ProxyMessage } from '../../shared/protocol'

describe('SocketClient', () => {
  let sockPath: string
  let bunServer: ReturnType<typeof Bun.listen> | null = null

  beforeEach(() => {
    sockPath = join(tmpdir(), `test-client-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`)
  })

  afterEach(async () => {
    bunServer?.stop()
    bunServer = null
    try { unlinkSync(sockPath) } catch {}
  })

  test('connects and receives messages from server', async () => {
    const received: DaemonMessage[] = []

    bunServer = Bun.listen<{}>({
      unix: sockPath,
      socket: {
        open(socket) {
          socket.write(encodeMessage({ type: 'ping' }))
        },
        data() {},
        close() {},
        error() {},
      },
    })
    await Bun.sleep(50)

    const client = new SocketClient(sockPath, {
      onMessage: (msg) => { received.push(msg) },
      onConnect: () => {},
      onDisconnect: () => {},
    })

    await client.connect()
    await Bun.sleep(100)

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('ping')

    client.close()
  })

  test('sends messages to server', async () => {
    const serverReceived: string[] = []

    bunServer = Bun.listen<{}>({
      unix: sockPath,
      socket: {
        open() {},
        data(_socket, data) { serverReceived.push(Buffer.from(data).toString()) },
        close() {},
        error() {},
      },
    })
    await Bun.sleep(50)

    const client = new SocketClient(sockPath, {
      onMessage: () => {},
      onConnect: () => {},
      onDisconnect: () => {},
    })

    await client.connect()
    await Bun.sleep(50)

    client.send({ type: 'pong' })
    await Bun.sleep(50)

    expect(serverReceived.join('')).toContain('"type":"pong"')

    client.close()
  })

  test('fires onConnect and onDisconnect', async () => {
    const events: string[] = []

    bunServer = Bun.listen<{}>({
      unix: sockPath,
      socket: {
        open() {},
        data() {},
        close() {},
        error() {},
      },
    })
    await Bun.sleep(50)

    const client = new SocketClient(sockPath, {
      onMessage: () => {},
      onConnect: () => { events.push('connected') },
      onDisconnect: () => { events.push('disconnected') },
    })

    await client.connect()
    await Bun.sleep(50)
    expect(events).toContain('connected')

    client.close()
    await Bun.sleep(50)
    expect(events).toContain('disconnected')
  })
})
