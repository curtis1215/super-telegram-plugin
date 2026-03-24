import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SocketServer } from '../../daemon/socket-server'
import { encodeMessage, type ProxyMessage, type DaemonMessage } from '../../shared/protocol'

describe('SocketServer', () => {
  let sockPath: string
  let server: SocketServer

  beforeEach(() => {
    sockPath = join(tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`)
  })

  afterEach(async () => {
    await server?.stop()
    try { unlinkSync(sockPath) } catch {}
  })

  test('starts and listens on socket path', async () => {
    const messages: Array<{ connId: string; msg: ProxyMessage }> = []
    server = new SocketServer(sockPath, {
      onMessage: (connId, msg) => { messages.push({ connId, msg }) },
      onConnect: () => {},
      onDisconnect: () => {},
    })
    await server.start()
    expect(existsSync(sockPath)).toBe(true)
  })

  test('accepts connection and receives messages', async () => {
    const received: ProxyMessage[] = []
    const connected: string[] = []

    server = new SocketServer(sockPath, {
      onMessage: (_connId, msg) => { received.push(msg) },
      onConnect: (connId) => { connected.push(connId) },
      onDisconnect: () => {},
    })
    await server.start()

    const socket = await Bun.connect({
      unix: sockPath,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    })

    await Bun.sleep(50)
    expect(connected.length).toBe(1)

    const msg: ProxyMessage = { type: 'pong' }
    socket.write(encodeMessage(msg))
    await Bun.sleep(50)

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('pong')

    socket.end()
  })

  test('sends message to specific connection', async () => {
    let clientConnId = ''
    const clientReceived: string[] = []

    server = new SocketServer(sockPath, {
      onMessage: () => {},
      onConnect: (connId) => { clientConnId = connId },
      onDisconnect: () => {},
    })
    await server.start()

    const socket = await Bun.connect({
      unix: sockPath,
      socket: {
        data(_socket, data) { clientReceived.push(Buffer.from(data).toString()) },
        open() {},
        close() {},
        error() {},
      },
    })

    await Bun.sleep(50)

    const msg: DaemonMessage = { type: 'ping' }
    server.send(clientConnId, msg)
    await Bun.sleep(50)

    expect(clientReceived.join('')).toContain('"type":"ping"')

    socket.end()
  })

  test('detects disconnection', async () => {
    const disconnected: string[] = []

    server = new SocketServer(sockPath, {
      onMessage: () => {},
      onConnect: () => {},
      onDisconnect: (connId) => { disconnected.push(connId) },
    })
    await server.start()

    const socket = await Bun.connect({
      unix: sockPath,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    })

    await Bun.sleep(50)
    socket.end()
    await Bun.sleep(50)

    expect(disconnected.length).toBe(1)
  })

  test('disconnect closes socket for given connId', async () => {
    let connId = ''
    const disconnected: string[] = []

    server = new SocketServer(sockPath, {
      onMessage: () => {},
      onConnect: (id) => { connId = id },
      onDisconnect: (id) => { disconnected.push(id) },
    })
    await server.start()

    await Bun.connect({
      unix: sockPath,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    })

    await Bun.sleep(50)
    server.disconnect(connId)
    await Bun.sleep(50)

    expect(disconnected).toContain(connId)
  })
})
