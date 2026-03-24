import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

export type Signal = {
  action: 'connect' | 'disconnect'
  name?: string
}

export type SignalWatcherCallbacks = {
  onSignal: (signal: Signal) => void
}

export class SignalWatcher {
  private sessionsDir: string
  private pid: number
  private sessionId: string
  private callbacks: SignalWatcherCallbacks
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private pidFile: string
  private signalFile: string

  constructor(
    sessionsDir: string,
    pid: number,
    sessionId: string,
    callbacks: SignalWatcherCallbacks,
  ) {
    this.sessionsDir = sessionsDir
    this.pid = pid
    this.sessionId = sessionId
    this.callbacks = callbacks
    this.pidFile = join(sessionsDir, `${pid}.pid`)
    this.signalFile = join(sessionsDir, `${pid}.signal`)
  }

  start(): void {
    mkdirSync(this.sessionsDir, { recursive: true })
    writeFileSync(this.pidFile, JSON.stringify({
      sessionId: this.sessionId,
      startedAt: Date.now(),
    }))
    this.checkSignal()
    this.pollInterval = setInterval(() => this.checkSignal(), 500)
    this.pollInterval.unref()
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    try { unlinkSync(this.pidFile) } catch {}
  }

  private checkSignal(): void {
    try {
      if (!existsSync(this.signalFile)) return
      const raw = readFileSync(this.signalFile, 'utf8')
      const signal = JSON.parse(raw) as Signal
      try { unlinkSync(this.signalFile) } catch {}
      this.callbacks.onSignal(signal)
    } catch {
      try { unlinkSync(this.signalFile) } catch {}
    }
  }
}
