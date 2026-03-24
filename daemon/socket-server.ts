import { unlinkSync, existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { decodeMessages, encodeMessage, type ProxyMessage, type DaemonMessage } from '../shared/protocol'
import type { Socket } from 'bun'

type SocketData = {
  connId: string
  buffer: string
}

export type SocketServerCallbacks = {
  onConnect: (connId: string) => void
  onDisconnect: (connId: string) => void
  onMessage: (connId: string, msg: ProxyMessage) => void
}

export class SocketServer {
  private sockPath: string
  private callbacks: SocketServerCallbacks
  private connections = new Map<string, Socket<SocketData>>()
  private server: ReturnType<typeof Bun.listen> | null = null

  constructor(sockPath: string, callbacks: SocketServerCallbacks) {
    this.sockPath = sockPath
    this.callbacks = callbacks
  }

  async start(): Promise<void> {
    if (existsSync(this.sockPath)) {
      try { unlinkSync(this.sockPath) } catch {}
    }

    const self = this
    this.server = Bun.listen<SocketData>({
      unix: this.sockPath,
      socket: {
        open(socket) {
          const connId = randomBytes(8).toString('hex')
          socket.data = { connId, buffer: '' }
          self.connections.set(connId, socket)
          self.callbacks.onConnect(connId)
        },
        data(socket, data) {
          const raw = socket.data.buffer + Buffer.from(data).toString()
          const { messages, remainder } = decodeMessages(raw)
          socket.data.buffer = remainder
          for (const msg of messages) {
            self.callbacks.onMessage(socket.data.connId, msg as ProxyMessage)
          }
        },
        close(socket) {
          const connId = socket.data.connId
          self.connections.delete(connId)
          self.callbacks.onDisconnect(connId)
        },
        error(_socket, error) {
          process.stderr.write(`socket server error: ${error}\n`)
        },
      },
    })
  }

  send(connId: string, msg: DaemonMessage): boolean {
    const socket = this.connections.get(connId)
    if (!socket) return false
    socket.write(encodeMessage(msg))
    return true
  }

  sendAll(msg: DaemonMessage): void {
    const encoded = encodeMessage(msg)
    for (const socket of this.connections.values()) {
      socket.write(encoded)
    }
  }

  disconnect(connId: string): void {
    const socket = this.connections.get(connId)
    if (socket) socket.end()
  }

  async stop(): Promise<void> {
    for (const socket of this.connections.values()) {
      socket.end()
    }
    this.connections.clear()
    this.server?.stop()
    this.server = null
    try { unlinkSync(this.sockPath) } catch {}
  }

  getConnectionCount(): number {
    return this.connections.size
  }
}
