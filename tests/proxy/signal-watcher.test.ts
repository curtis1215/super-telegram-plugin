import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SignalWatcher } from '../../proxy/signal-watcher'

describe('SignalWatcher', () => {
  let testDir: string
  let watcher: SignalWatcher

  beforeEach(() => {
    testDir = join(tmpdir(), `signal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    watcher?.stop()
    rmSync(testDir, { recursive: true, force: true })
  })

  test('creates PID file on start', () => {
    const signals: Array<{ action: string; name?: string }> = []
    watcher = new SignalWatcher(testDir, 12345, 'test-session-id', {
      onSignal: (signal) => { signals.push(signal) },
    })
    watcher.start()
    expect(existsSync(join(testDir, '12345.pid'))).toBe(true)
  })

  test('removes PID file on stop', () => {
    const signals: Array<{ action: string; name?: string }> = []
    watcher = new SignalWatcher(testDir, 12345, 'test-session-id', {
      onSignal: (signal) => { signals.push(signal) },
    })
    watcher.start()
    watcher.stop()
    expect(existsSync(join(testDir, '12345.pid'))).toBe(false)
  })

  test('processes existing signal file on start', async () => {
    writeFileSync(
      join(testDir, '12345.signal'),
      JSON.stringify({ action: 'connect', name: 'research' }),
    )
    const signals: Array<{ action: string; name?: string }> = []
    watcher = new SignalWatcher(testDir, 12345, 'test-session-id', {
      onSignal: (signal) => { signals.push(signal) },
    })
    watcher.start()
    await Bun.sleep(100)
    expect(signals).toHaveLength(1)
    expect(signals[0]).toEqual({ action: 'connect', name: 'research' })
    expect(existsSync(join(testDir, '12345.signal'))).toBe(false)
  })

  test('processes new signal file written after start', async () => {
    const signals: Array<{ action: string; name?: string }> = []
    watcher = new SignalWatcher(testDir, 12345, 'test-session-id', {
      onSignal: (signal) => { signals.push(signal) },
    })
    watcher.start()
    await Bun.sleep(100)
    writeFileSync(
      join(testDir, '12345.signal'),
      JSON.stringify({ action: 'disconnect' }),
    )
    await Bun.sleep(600)
    expect(signals).toHaveLength(1)
    expect(signals[0]).toEqual({ action: 'disconnect' })
  })
})
