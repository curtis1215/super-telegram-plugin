import { describe, test, expect, beforeEach } from 'bun:test'
import { SessionManager, type SessionEntry } from '../../daemon/session-manager'

describe('SessionManager', () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager()
  })

  // --- Registration ---

  test('register adds a named session', () => {
    const evicted = sm.register('conn-1', 'research', '1.0.0')
    expect(evicted).toBeNull()
    expect(sm.getSession('research')).toEqual({
      connId: 'conn-1',
      name: 'research',
      version: '1.0.0',
      lastPong: expect.any(Number),
      disconnectedAt: null,
    })
  })

  test('register same name evicts previous connection', () => {
    sm.register('conn-1', 'research', '1.0.0')
    const evicted = sm.register('conn-2', 'research', '1.0.0')
    expect(evicted).toBe('conn-1')
    expect(sm.getSession('research')!.connId).toBe('conn-2')
  })

  test('register unnamed session (null name) is tracked but not routable', () => {
    sm.register('conn-1', null, '1.0.0')
    expect(sm.getNamedSessions()).toHaveLength(0)
    expect(sm.getUnnamedCount()).toBe(1)
  })

  // --- Unregistration ---

  test('unregisterByConnId keeps named session with null connId', () => {
    sm.register('conn-1', 'research', '1.0.0')
    const removed = sm.unregisterByConnId('conn-1')
    expect(removed).toBe('research')
    const session = sm.getSession('research')
    expect(session).not.toBeNull()
    expect(session!.connId).toBeNull()
  })

  test('unregisterByConnId preserves activeSession when proxy disconnects', () => {
    sm.register('conn-1', 'research', '1.0.0')
    sm.setActiveSession('research')
    sm.unregisterByConnId('conn-1')
    expect(sm.getActiveSession()).toBe('research')
    expect(sm.getActiveConnId()).toBeNull()
  })

  test('unregisterByConnId removes unnamed session', () => {
    sm.register('conn-1', null, '1.0.0')
    const removed = sm.unregisterByConnId('conn-1')
    expect(removed).toBeNull()
    expect(sm.getUnnamedCount()).toBe(0)
  })

  // --- Active session ---

  test('setActiveSession sets and gets', () => {
    sm.register('conn-1', 'research', '1.0.0')
    expect(sm.setActiveSession('research')).toBe(true)
    expect(sm.getActiveSession()).toBe('research')
  })

  test('setActiveSession fails for unknown name', () => {
    expect(sm.setActiveSession('ghost')).toBe(false)
    expect(sm.getActiveSession()).toBeNull()
  })

  test('clearActiveSession sets to null', () => {
    sm.register('conn-1', 'research', '1.0.0')
    sm.setActiveSession('research')
    sm.clearActiveSession()
    expect(sm.getActiveSession()).toBeNull()
  })

  test('restoreActiveSession sets without requiring registration', () => {
    sm.restoreActiveSession('research')
    expect(sm.getActiveSession()).toBe('research')
  })

  // --- Routing ---

  test('getActiveConnId returns connId of active session', () => {
    sm.register('conn-1', 'research', '1.0.0')
    sm.setActiveSession('research')
    expect(sm.getActiveConnId()).toBe('conn-1')
  })

  test('getActiveConnId returns null when active session not connected', () => {
    sm.restoreActiveSession('research')
    expect(sm.getActiveConnId()).toBeNull()
  })

  // --- Heartbeat ---

  test('receivePong updates lastPong', () => {
    sm.register('conn-1', 'research', '1.0.0')
    const before = sm.getSession('research')!.lastPong
    sm.receivePong('conn-1')
    const after = sm.getSession('research')!.lastPong
    expect(after).toBeGreaterThanOrEqual(before)
  })

  test('checkHeartbeats removes timed-out connections but keeps session name', () => {
    sm.register('conn-1', 'research', '1.0.0')
    const session = sm.getSession('research')!
    ;(session as any).lastPong = Date.now() - 60_000
    const timedOut = sm.checkHeartbeats(5_000)
    expect(timedOut).toEqual(['conn-1'])
    const afterTimeout = sm.getSession('research')
    expect(afterTimeout).not.toBeNull()
    expect(afterTimeout!.connId).toBeNull()
  })

  test('reconnect takes over disconnected session', () => {
    sm.register('conn-1', 'research', '1.0.0')
    sm.setActiveSession('research')
    sm.unregisterByConnId('conn-1')
    expect(sm.getActiveConnId()).toBeNull()
    // New proxy reconnects with same name
    sm.register('conn-2', 'research', '1.0.0')
    expect(sm.getActiveSession()).toBe('research')
    expect(sm.getActiveConnId()).toBe('conn-2')
  })

  test('checkHeartbeats does not remove healthy connections', () => {
    sm.register('conn-1', 'research', '1.0.0')
    const timedOut = sm.checkHeartbeats(5_000)
    expect(timedOut).toHaveLength(0)
    expect(sm.getSession('research')).not.toBeNull()
  })

  // --- Listing ---

  test('getNamedSessions returns all named sessions', () => {
    sm.register('conn-1', 'research', '1.0.0')
    sm.register('conn-2', 'polyfun', '1.0.0')
    sm.register('conn-3', null, '1.0.0')
    sm.setActiveSession('research')
    const sessions = sm.getNamedSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions.find(s => s.name === 'research')!.isActive).toBe(true)
    expect(sessions.find(s => s.name === 'research')!.isConnected).toBe(true)
    expect(sessions.find(s => s.name === 'polyfun')!.isActive).toBe(false)
    expect(sessions.find(s => s.name === 'polyfun')!.isConnected).toBe(true)
  })

  test('getNamedSessions shows disconnected sessions as not connected', () => {
    sm.register('conn-1', 'research', '1.0.0')
    sm.unregisterByConnId('conn-1')
    const sessions = sm.getNamedSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].isConnected).toBe(false)
  })

  // --- Stale cleanup ---

  test('cleanupStale removes sessions disconnected longer than maxAge', () => {
    sm.register('conn-1', 'stale-session', '1.0.0')
    sm.unregisterByConnId('conn-1')
    // Backdate disconnectedAt
    const session = sm.getSession('stale-session')!
    ;(session as any).disconnectedAt = Date.now() - 10 * 60_000
    const removed = sm.cleanupStale(5 * 60_000)
    expect(removed).toEqual(['stale-session'])
    expect(sm.getSession('stale-session')).toBeNull()
  })

  test('cleanupStale does not remove recently disconnected sessions', () => {
    sm.register('conn-1', 'recent', '1.0.0')
    sm.unregisterByConnId('conn-1')
    const removed = sm.cleanupStale(5 * 60_000)
    expect(removed).toHaveLength(0)
    expect(sm.getSession('recent')).not.toBeNull()
  })

  test('cleanupStale does not remove connected sessions', () => {
    sm.register('conn-1', 'alive', '1.0.0')
    const removed = sm.cleanupStale(0) // Even with 0 timeout
    expect(removed).toHaveLength(0)
    expect(sm.getSession('alive')).not.toBeNull()
  })

  test('cleanupStale clears activeSession and drains buffer if stale session was active', () => {
    sm.register('conn-1', 'active-stale', '1.0.0')
    sm.setActiveSession('active-stale')
    sm.unregisterByConnId('conn-1')
    // Buffer some messages while disconnected
    sm.bufferMessage({ type: 'message', content: 'orphan', meta: { chat_id: '1', user: 'u', user_id: '1', ts: '' } })
    expect(sm.getBufferSize()).toBe(1)
    const session = sm.getSession('active-stale')!
    ;(session as any).disconnectedAt = Date.now() - 10 * 60_000
    sm.cleanupStale(5 * 60_000)
    expect(sm.getActiveSession()).toBeNull()
    expect(sm.getBufferSize()).toBe(0)
  })

  // --- Message buffer ---

  test('bufferMessage and drainBuffer work together', () => {
    sm.bufferMessage({ type: 'message', content: 'hello', meta: { chat_id: '1', user: 'u', user_id: '1', ts: '' } })
    sm.bufferMessage({ type: 'message', content: 'world', meta: { chat_id: '1', user: 'u', user_id: '1', ts: '' } })
    const msgs = sm.drainBuffer()
    expect(msgs).toHaveLength(2)
    expect(sm.drainBuffer()).toHaveLength(0)
  })

  test('bufferMessage respects max limit of 50', () => {
    for (let i = 0; i < 60; i++) {
      sm.bufferMessage({ type: 'message', content: `msg-${i}`, meta: { chat_id: '1', user: 'u', user_id: '1', ts: '' } })
    }
    expect(sm.drainBuffer()).toHaveLength(50)
  })
})
