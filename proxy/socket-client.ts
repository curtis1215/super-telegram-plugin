import { decodeMessages, encodeMessage, type ProxyMessage, type DaemonMessage } from '../shared/protocol'

export type SocketClientCallbacks = {
  onConnect: () => void
  onDisconnect: () => void
  onMessage: (msg: DaemonMessage) => void
}

export class SocketClient {
  private sockPath: string
  private callbacks: SocketClientCallbacks
  private socket: ReturnType<typeof Bun.connect> extends Promise<infer T> ? T : never = null as any
  private buffer = ''
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(sockPath: string, callbacks: SocketClientCallbacks) {
    this.sockPath = sockPath
    this.callbacks = callbacks
  }

  async connect(): Promise<void> {
    this.closed = false
    const self = this

    this.socket = await Bun.connect({
      unix: this.sockPath,
      socket: {
        open(socket) {
          self.socket = socket as any
          self.buffer = ''
          self.callbacks.onConnect()
        },
        data(_socket, data) {
          const raw = self.buffer + Buffer.from(data).toString()
          const { messages, remainder } = decodeMessages(raw)
          self.buffer = remainder
          for (const msg of messages) {
            self.callbacks.onMessage(msg as DaemonMessage)
          }
        },
        close() {
          self.callbacks.onDisconnect()
          if (!self.closed) {
            self.scheduleReconnect()
          }
        },
        error(_socket, error) {
          process.stderr.write(`telegram-proxy: socket error: ${error}\n`)
        },
      },
    })
  }

  send(msg: ProxyMessage): boolean {
    if (!this.socket) return false
    try {
      this.socket.write(encodeMessage(msg))
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try { this.socket?.end() } catch {}
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    this.reconnectTimer = setTimeout(async () => {
      if (this.closed) return
      try {
        await this.connect()
        process.stderr.write('telegram-proxy: reconnected to daemon\n')
      } catch {
        process.stderr.write('telegram-proxy: reconnect failed, retrying...\n')
        this.scheduleReconnect()
      }
    }, 5_000)
  }

  isConnected(): boolean {
    return !!this.socket && !this.closed
  }
}
