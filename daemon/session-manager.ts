import type { InboundMessage } from '../shared/protocol'

export type SessionEntry = {
  connId: string | null
  name: string | null
  version: string
  lastPong: number
  disconnectedAt: number | null
}

export type NamedSessionInfo = {
  name: string
  isActive: boolean
  isConnected: boolean
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

    const entry: SessionEntry = { connId, name, version, lastPong: Date.now(), disconnectedAt: null }

    if (name !== null) {
      const existing = this.named.get(name)
      if (existing) {
        if (existing.connId === null) {
          // Reconnect: take over disconnected session
          existing.connId = connId
          existing.version = version
          existing.lastPong = Date.now()
          existing.disconnectedAt = null
          this.connections.set(connId, existing)
          return null
        } else if (existing.connId !== connId) {
          // Evict active connection with same name
          evictedConnId = existing.connId
          this.connections.delete(existing.connId)
        }
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
        // Keep session name registered but mark as disconnected (connId = null)
        // activeSession is preserved — messages will be buffered
        current.connId = null
        current.disconnectedAt = Date.now()
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
      .map(e => ({ name: e.name, isActive: e.name === this.activeSession, isConnected: e.connId !== null }))
  }

  /** Remove named sessions that have been disconnected longer than maxAgeMs */
  cleanupStale(maxAgeMs: number): string[] {
    const now = Date.now()
    const removed: string[] = []
    for (const [name, entry] of this.named) {
      if (entry.connId === null && entry.disconnectedAt !== null && now - entry.disconnectedAt > maxAgeMs) {
        // Clear active session and drain orphaned buffer if it's the one being removed
        if (this.activeSession === name) {
          this.activeSession = null
          this.messageBuffer = []
        }
        this.named.delete(name)
        removed.push(name)
      }
    }
    return removed
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
