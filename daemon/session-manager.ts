import type { InboundMessage } from '../shared/protocol'

export type SessionEntry = {
  connId: string
  name: string | null
  version: string
  lastPong: number
}

export type NamedSessionInfo = {
  name: string
  isActive: boolean
}

const MAX_BUFFER = 50

export class SessionManager {
  private named = new Map<string, SessionEntry>()
  private connections = new Map<string, SessionEntry>()
  private activeSession: string | null = null
  private messageBuffer: InboundMessage[] = []

  register(connId: string, name: string | null, version: string): string | null {
    let evictedConnId: string | null = null
    this.unregisterByConnId(connId)

    const entry: SessionEntry = { connId, name, version, lastPong: Date.now() }

    if (name !== null) {
      const existing = this.named.get(name)
      if (existing && existing.connId !== connId) {
        evictedConnId = existing.connId
        this.connections.delete(existing.connId)
      }
      this.named.set(name, entry)
    }

    this.connections.set(connId, entry)
    return evictedConnId
  }

  unregisterByConnId(connId: string): string | null {
    const entry = this.connections.get(connId)
    if (!entry) return null
    this.connections.delete(connId)
    if (entry.name !== null) {
      const current = this.named.get(entry.name)
      if (current && current.connId === connId) {
        this.named.delete(entry.name)
        if (this.activeSession === entry.name) this.activeSession = null
      }
      return entry.name
    }
    return null
  }

  getSession(name: string): SessionEntry | null {
    return this.named.get(name) ?? null
  }

  getActiveSession(): string | null { return this.activeSession }

  setActiveSession(name: string): boolean {
    if (!this.named.has(name)) return false
    this.activeSession = name
    return true
  }

  clearActiveSession(): void { this.activeSession = null }

  restoreActiveSession(name: string): void { this.activeSession = name }

  getActiveConnId(): string | null {
    if (!this.activeSession) return null
    return this.named.get(this.activeSession)?.connId ?? null
  }

  receivePong(connId: string): void {
    const entry = this.connections.get(connId)
    if (entry) entry.lastPong = Date.now()
  }

  checkHeartbeats(timeoutMs: number): string[] {
    const now = Date.now()
    const timedOut: string[] = []
    for (const [connId, entry] of this.connections) {
      if (now - entry.lastPong > timeoutMs) timedOut.push(connId)
    }
    for (const connId of timedOut) this.unregisterByConnId(connId)
    return timedOut
  }

  getNamedSessions(): NamedSessionInfo[] {
    return Array.from(this.named.values())
      .filter((e): e is SessionEntry & { name: string } => e.name !== null)
      .map(e => ({ name: e.name, isActive: e.name === this.activeSession }))
  }

  getUnnamedCount(): number {
    let count = 0
    for (const entry of this.connections.values()) {
      if (entry.name === null) count++
    }
    return count
  }

  getAllConnIds(): string[] {
    return Array.from(this.connections.keys())
  }

  bufferMessage(msg: InboundMessage): void {
    if (this.messageBuffer.length >= MAX_BUFFER) return
    this.messageBuffer.push(msg)
  }

  drainBuffer(): InboundMessage[] {
    const msgs = this.messageBuffer
    this.messageBuffer = []
    return msgs
  }

  getBufferSize(): number {
    return this.messageBuffer.length
  }
}
