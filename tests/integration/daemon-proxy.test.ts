import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionManager } from '../../daemon/session-manager'
import { SocketServer } from '../../daemon/socket-server'
import { SocketClient } from '../../proxy/socket-client'
import {
  PROTOCOL_VERSION,
  type ProxyMessage,
  type DaemonMessage,
  type InboundMessage,
  type ToolResultMessage,
} from '../../shared/protocol'

describe('Daemon-Proxy Integration', () => {
  let sockPath: string
  let sessionManager: SessionManager
  let socketServer: SocketServer
  let client: SocketClient

  beforeEach(async () => {
    sockPath = join(tmpdir(), `integration-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`)
    sessionManager = new SessionManager()

    socketServer = new SocketServer(sockPath, {
      onConnect(connId) {
        sessionManager.register(connId, null, '0.0.0')
      },
      onDisconnect(connId) {
        sessionManager.unregisterByConnId(connId)
      },
      onMessage(connId, msg: ProxyMessage) {
        switch (msg.type) {
          case 'register': {
            const evicted = sessionManager.register(connId, msg.name, msg.version)
            if (evicted) {
              socketServer.send(evicted, { type: 'unregistered', reason: 'name_taken' })
              socketServer.disconnect(evicted)
            }
            socketServer.send(connId, { type: 'registered', name: msg.name })
            break
          }
          case 'unregister': {
            sessionManager.unregisterByConnId(connId)
            sessionManager.register(connId, null, '0.0.0')
            break
          }
          case 'pong': {
            sessionManager.receivePong(connId)
            break
          }
          case 'tool_call': {
            const result: ToolResultMessage = {
              type: 'tool_result',
              id: msg.id,
              result: { content: [{ type: 'text', text: `mock result for ${msg.tool}` }] },
            }
            socketServer.send(connId, result)
            break
          }
        }
      },
    })

    await socketServer.start()
  })

  afterEach(async () => {
    client?.close()
    await socketServer?.stop()
    try { unlinkSync(sockPath) } catch {}
  })

  test('proxy connects, registers, receives confirmation', async () => {
    const daemonMessages: DaemonMessage[] = []

    client = new SocketClient(sockPath, {
      onConnect() {},
      onDisconnect() {},
      onMessage(msg) { daemonMessages.push(msg) },
    })

    await client.connect()
    await Bun.sleep(50)

    client.send({ type: 'register', name: 'research', version: PROTOCOL_VERSION })
    await Bun.sleep(50)

    expect(daemonMessages).toHaveLength(1)
    expect(daemonMessages[0].type).toBe('registered')
    if (daemonMessages[0].type === 'registered') {
      expect(daemonMessages[0].name).toBe('research')
    }

    const session = sessionManager.getSession('research')
    expect(session).not.toBeNull()
  })

  test('heartbeat ping/pong cycle', async () => {
    const daemonMessages: DaemonMessage[] = []

    client = new SocketClient(sockPath, {
      onConnect() {},
      onDisconnect() {},
      onMessage(msg) {
        daemonMessages.push(msg)
        if (msg.type === 'ping') {
          client.send({ type: 'pong' })
        }
      },
    })

    await client.connect()
    await Bun.sleep(50)

    const connIds = sessionManager.getAllConnIds()
    expect(connIds.length).toBe(1)
    socketServer.send(connIds[0], { type: 'ping' })
    await Bun.sleep(50)

    expect(daemonMessages.some(m => m.type === 'ping')).toBe(true)
  })

  test('tool call forwarding', async () => {
    const daemonMessages: DaemonMessage[] = []

    client = new SocketClient(sockPath, {
      onConnect() {},
      onDisconnect() {},
      onMessage(msg) { daemonMessages.push(msg) },
    })

    await client.connect()
    await Bun.sleep(50)

    client.send({
      type: 'tool_call',
      id: 'test-1',
      tool: 'reply',
      args: { chat_id: '123', text: 'hello' },
    })
    await Bun.sleep(50)

    const result = daemonMessages.find(m => m.type === 'tool_result') as ToolResultMessage | undefined
    expect(result).toBeDefined()
    expect(result!.id).toBe('test-1')
    expect(result!.result!.content[0].text).toContain('mock result')
  })

  test('daemon pushes inbound message to proxy', async () => {
    const daemonMessages: DaemonMessage[] = []

    client = new SocketClient(sockPath, {
      onConnect() {},
      onDisconnect() {},
      onMessage(msg) { daemonMessages.push(msg) },
    })

    await client.connect()
    await Bun.sleep(50)

    client.send({ type: 'register', name: 'research', version: PROTOCOL_VERSION })
    await Bun.sleep(50)

    sessionManager.setActiveSession('research')
    const activeConnId = sessionManager.getActiveConnId()
    expect(activeConnId).not.toBeNull()

    const inbound: InboundMessage = {
      type: 'message',
      content: 'Hello from Telegram',
      meta: {
        chat_id: '123',
        message_id: '456',
        user: 'testuser',
        user_id: '789',
        ts: new Date().toISOString(),
      },
    }
    socketServer.send(activeConnId!, inbound)
    await Bun.sleep(50)

    const msg = daemonMessages.find(m => m.type === 'message') as InboundMessage | undefined
    expect(msg).toBeDefined()
    expect(msg!.content).toBe('Hello from Telegram')
  })

  test('name collision evicts previous holder', async () => {
    const client1Messages: DaemonMessage[] = []
    const client2Messages: DaemonMessage[] = []

    const client1 = new SocketClient(sockPath, {
      onConnect() {},
      onDisconnect() {},
      onMessage(msg) { client1Messages.push(msg) },
    })
    await client1.connect()
    await Bun.sleep(50)
    client1.send({ type: 'register', name: 'research', version: PROTOCOL_VERSION })
    await Bun.sleep(50)

    client = new SocketClient(sockPath, {
      onConnect() {},
      onDisconnect() {},
      onMessage(msg) { client2Messages.push(msg) },
    })
    await client.connect()
    await Bun.sleep(50)
    client.send({ type: 'register', name: 'research', version: PROTOCOL_VERSION })
    await Bun.sleep(100)

    expect(client1Messages.some(m => m.type === 'unregistered')).toBe(true)
    expect(client2Messages.some(m => m.type === 'registered')).toBe(true)

    client1.close()
  })
})
