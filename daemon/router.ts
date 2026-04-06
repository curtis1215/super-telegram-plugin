#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, statSync, chmodSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { SessionManager } from './session-manager'
import { SocketServer } from './socket-server'
import { AccessManager } from './access'
import { TelegramBot } from './bot'
import { PROTOCOL_VERSION, type ProxyMessage, type DaemonMessage, type InboundMessage } from '../shared/protocol'

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const SOCK_PATH = join(STATE_DIR, 'router.sock')
const PID_FILE = join(STATE_DIR, 'router.pid')
const STATE_FILE = join(STATE_DIR, 'router-state.json')
const LOG_FILE = join(STATE_DIR, 'router.log')
const ENV_FILE = join(STATE_DIR, '.env')

const DAEMON_APP_VERSION: string = (() => {
  try {
    const pkgPath = join(import.meta.dir, '..', 'package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version
  } catch { return '0.0.0' }
})()

const HEARTBEAT_INTERVAL = 30_000
const HEARTBEAT_TIMEOUT = 35_000
const BUFFER_RECONNECT_TIMEOUT = 30_000
const STALE_SESSION_TIMEOUT = 5 * 60_000 // 5 minutes
const LOG_MAX_SIZE = 10 * 1024 * 1024
const LOG_MAX_FILES = 3

// ── .env loading ──────────────────────────────────────────────────────────────

function loadEnv(): void {
  if (!existsSync(ENV_FILE)) return
  try {
    const lines = readFileSync(ENV_FILE, 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      let value = trimmed.slice(eqIdx + 1).trim()
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (!(key in process.env)) process.env[key] = value
    }
  } catch {
    // Ignore read errors — token may already be in environment
  }
}

// ── State persistence ─────────────────────────────────────────────────────────

type RouterState = {
  activeSession: string | null
}

function loadState(): RouterState {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<RouterState>
    return { activeSession: parsed.activeSession ?? null }
  } catch {
    return { activeSession: null }
  }
}

function saveState(sessionManager: SessionManager): void {
  try {
    const state: RouterState = { activeSession: sessionManager.getActiveSession() }
    const tmp = STATE_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, STATE_FILE)
  } catch (err) {
    process.stderr.write(`telegram daemon: failed to save state: ${err}\n`)
  }
}

// ── Log rotation ──────────────────────────────────────────────────────────────

function rotateLog(): void {
  try {
    const st = statSync(LOG_FILE)
    if (st.size <= LOG_MAX_SIZE) return
  } catch {
    return // File doesn't exist yet
  }

  // Rotate: router.log.3 (deleted), .2 → .3, .1 → .2, .log → .1
  for (let i = LOG_MAX_FILES; i >= 1; i--) {
    const older = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`
    const newer = `${LOG_FILE}.${i}`
    try {
      if (existsSync(newer) && i === LOG_MAX_FILES) unlinkSync(newer)
      if (existsSync(older)) renameSync(older, newer)
    } catch {
      // Best-effort
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Load .env
  loadEnv()

  // 2. Check for bot token
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    process.stderr.write('telegram daemon: TELEGRAM_BOT_TOKEN not set. Exiting.\n')
    process.exit(1)
  }

  // 3. Unhandled rejection / exception handlers
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`telegram daemon: unhandledRejection: ${reason}\n`)
  })
  process.on('uncaughtException', (err) => {
    process.stderr.write(`telegram daemon: uncaughtException: ${err}\n`)
  })

  // 4. Create STATE_DIR, write PID file
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(PID_FILE, String(process.pid) + '\n', { mode: 0o600 })

  // 5. Rotate log on startup
  rotateLog()

  // 6. Create SessionManager, AccessManager
  const sessionManager = new SessionManager()
  const accessManager = new AccessManager(STATE_DIR)

  // 7. Restore activeSession from router-state.json
  const restoredState = loadState()
  let bufferReconnectTimer: ReturnType<typeof setTimeout> | null = null

  if (restoredState.activeSession !== null) {
    sessionManager.restoreActiveSession(restoredState.activeSession)
    process.stderr.write(`telegram daemon: restored active session: ${restoredState.activeSession}\n`)

    // 8. Set 30s reconnect timeout — if proxy doesn't reconnect, drain buffer and clear
    bufferReconnectTimer = setTimeout(() => {
      bufferReconnectTimer = null
      const active = sessionManager.getActiveSession()
      const connId = sessionManager.getActiveConnId()
      if (active !== null && connId === null) {
        process.stderr.write(`telegram daemon: session "${active}" did not reconnect within ${BUFFER_RECONNECT_TIMEOUT}ms, draining buffer\n`)
        sessionManager.drainBuffer()
        sessionManager.clearActiveSession()
        saveState(sessionManager)
      }
    }, BUFFER_RECONNECT_TIMEOUT)
  }

  // 9. Create SocketServer
  const socketServer = new SocketServer(SOCK_PATH, {
    onConnect(connId: string) {
      process.stderr.write(`telegram daemon: proxy connected: ${connId}\n`)
      sessionManager.register(connId, null, '')
    },

    onDisconnect(connId: string) {
      process.stderr.write(`telegram daemon: proxy disconnected: ${connId}\n`)
      sessionManager.unregisterByConnId(connId)
      saveState(sessionManager)
    },

    onMessage(connId: string, msg: ProxyMessage) {
      switch (msg.type) {
        case 'register': {
          const name = msg.name
          const version = msg.version

          // Check protocol version mismatch
          if (version !== PROTOCOL_VERSION) {
            socketServer.send(connId, {
              type: 'version_mismatch',
              daemon_version: PROTOCOL_VERSION,
              proxy_version: version,
            })
            process.stderr.write(`telegram daemon: protocol version mismatch for "${name}": daemon=${PROTOCOL_VERSION} proxy=${version}\n`)
          }

          // Check app version — if proxy is newer, daemon should restart to pick up new code
          const proxyAppVersion = msg.appVersion
          if (proxyAppVersion && proxyAppVersion > DAEMON_APP_VERSION) {
            process.stderr.write(`telegram daemon: newer proxy detected — daemon=${DAEMON_APP_VERSION} proxy=${proxyAppVersion}, restarting to update\n`)
            saveState(sessionManager)
            // Exit gracefully — launchd/systemd will restart with updated code
            setTimeout(() => process.exit(0), 500)
          }

          // Evict old holder of the same name
          const evictedConnId = sessionManager.register(connId, name, version)
          if (evictedConnId !== null) {
            socketServer.send(evictedConnId, { type: 'unregistered', reason: 'kicked' })
            socketServer.disconnect(evictedConnId)
          }

          // Send registered confirmation
          socketServer.send(connId, { type: 'registered', name })
          process.stderr.write(`telegram daemon: session registered: "${name}"\n`)

          // Cancel the reconnect timer if this is the restored session reconnecting
          if (bufferReconnectTimer !== null && name === sessionManager.getActiveSession()) {
            clearTimeout(bufferReconnectTimer)
            bufferReconnectTimer = null
          }

          // Drain buffer if this is the active session reconnecting
          const activeConnId = sessionManager.getActiveConnId()
          if (activeConnId === connId) {
            const buffered = sessionManager.drainBuffer()
            for (const bufferedMsg of buffered) {
              socketServer.send(connId, bufferedMsg)
            }
            if (buffered.length > 0) {
              process.stderr.write(`telegram daemon: drained ${buffered.length} buffered message(s) to "${name}"\n`)
            }
          }

          // Auto-activate first named session if no active session
          if (sessionManager.getActiveSession() === null) {
            const activated = sessionManager.setActiveSession(name)
            if (activated) {
              process.stderr.write(`telegram daemon: auto-activated session: "${name}"\n`)
              saveState(sessionManager)
            }
          }

          saveState(sessionManager)
          break
        }

        case 'unregister': {
          const name = sessionManager.unregisterByConnId(connId)
          // Re-register as unnamed
          sessionManager.register(connId, null, '')
          process.stderr.write(`telegram daemon: session unregistered: "${name ?? connId}"\n`)
          saveState(sessionManager)
          break
        }

        case 'pong': {
          sessionManager.receivePong(connId)
          break
        }

        case 'tool_call': {
          void bot.executeToolCall(msg).then((result) => {
            socketServer.send(connId, result)
          })
          break
        }
      }
    },
  })

  // 10. Create TelegramBot
  const bot = new TelegramBot({
    token,
    stateDir: STATE_DIR,
    accessManager,
    sessionManager,
    sendToProxy(connId: string, msg: InboundMessage) {
      socketServer.send(connId, msg)
    },
    onNoActiveSession(chatId: string) {
      void bot.sendDirectMessage(chatId, '目前沒有活躍的 session，請用 /list 查看並 /switch 選擇')
    },
  })

  // 11. Start heartbeat interval (30s)
  const heartbeatInterval = setInterval(() => {
    // Send ping to all connections
    const allConnIds = sessionManager.getAllConnIds()
    for (const connId of allConnIds) {
      socketServer.send(connId, { type: 'ping' })
    }

    // Check timeouts and disconnect stale connections
    const timedOut = sessionManager.checkHeartbeats(HEARTBEAT_TIMEOUT)
    for (const connId of timedOut) {
      process.stderr.write(`telegram daemon: heartbeat timeout for: ${connId}\n`)
      socketServer.send(connId, { type: 'unregistered', reason: 'heartbeat_timeout' })
      socketServer.disconnect(connId)
    }

    // Clean up stale disconnected sessions
    const stale = sessionManager.cleanupStale(STALE_SESSION_TIMEOUT)
    for (const name of stale) {
      process.stderr.write(`telegram daemon: removed stale session: "${name}"\n`)
    }

    // Save state
    saveState(sessionManager)

    // Rotate log if needed
    rotateLog()
  }, HEARTBEAT_INTERVAL)

  // 12. Shutdown handlers
  async function shutdown(): Promise<void> {
    process.stderr.write('telegram daemon: shutting down\n')

    clearInterval(heartbeatInterval)
    if (bufferReconnectTimer !== null) {
      clearTimeout(bufferReconnectTimer)
      bufferReconnectTimer = null
    }

    saveState(sessionManager)
    await socketServer.stop()
    bot.stop()

    try { unlinkSync(PID_FILE) } catch {}

    process.exit(0)
  }

  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })

  // 13. Start socket server, start approval polling, start bot
  process.stderr.write(`telegram daemon: starting (pid ${process.pid})\n`)
  process.stderr.write(`telegram daemon: socket: ${SOCK_PATH}\n`)
  process.stderr.write(`telegram daemon: state: ${STATE_DIR}\n`)

  await socketServer.start()
  try { chmodSync(SOCK_PATH, 0o600) } catch {}

  bot.startApprovalPolling()

  // Start bot (blocking — returns only on stop())
  await bot.start()
}

main().catch((err) => {
  process.stderr.write(`telegram daemon: fatal: ${err}\n`)
  process.exit(1)
})
