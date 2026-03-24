import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AccessManager } from '../../daemon/access'

describe('AccessManager', () => {
  let testDir: string
  let am: AccessManager

  beforeEach(() => {
    testDir = join(tmpdir(), `telegram-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
    am = new AccessManager(testDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('loadAccess returns defaults when no file exists', () => {
    const access = am.loadAccess()
    expect(access.dmPolicy).toBe('pairing')
    expect(access.allowFrom).toEqual([])
    expect(access.groups).toEqual({})
    expect(access.pending).toEqual({})
  })

  test('loadAccess reads existing file', () => {
    writeFileSync(
      join(testDir, 'access.json'),
      JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['123'] }),
    )
    const access = am.loadAccess()
    expect(access.dmPolicy).toBe('allowlist')
    expect(access.allowFrom).toEqual(['123'])
  })

  test('loadAccess handles corrupt file', () => {
    writeFileSync(join(testDir, 'access.json'), 'not json{{{')
    const access = am.loadAccess()
    expect(access.dmPolicy).toBe('pairing')
    expect(existsSync(join(testDir, 'access.json'))).toBe(false)
  })

  test('gate drops when dmPolicy is disabled', () => {
    writeFileSync(join(testDir, 'access.json'), JSON.stringify({ dmPolicy: 'disabled' }))
    const result = am.gate({ chatType: 'private', senderId: '123', chatId: '123' })
    expect(result.action).toBe('drop')
  })

  test('gate delivers for allowlisted DM user', () => {
    writeFileSync(join(testDir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['123'] }))
    const result = am.gate({ chatType: 'private', senderId: '123', chatId: '123' })
    expect(result.action).toBe('deliver')
  })

  test('gate drops non-allowlisted DM user in allowlist mode', () => {
    writeFileSync(join(testDir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['999'] }))
    const result = am.gate({ chatType: 'private', senderId: '123', chatId: '123' })
    expect(result.action).toBe('drop')
  })

  test('gate generates pairing code for unknown DM user', () => {
    const result = am.gate({ chatType: 'private', senderId: '123', chatId: '123' })
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.code).toMatch(/^[0-9a-f]{6}$/)
      expect(result.isResend).toBe(false)
    }
  })

  test('gate resends existing pairing code', () => {
    const r1 = am.gate({ chatType: 'private', senderId: '123', chatId: '123' })
    expect(r1.action).toBe('pair')
    const r2 = am.gate({ chatType: 'private', senderId: '123', chatId: '123' })
    expect(r2.action).toBe('pair')
    if (r2.action === 'pair') {
      expect(r2.isResend).toBe(true)
    }
  })

  test('gate delivers for allowlisted group', () => {
    writeFileSync(join(testDir, 'access.json'), JSON.stringify({
      dmPolicy: 'pairing',
      groups: { '-100': { requireMention: false, allowFrom: [] } },
    }))
    const result = am.gate({ chatType: 'supergroup', senderId: '123', chatId: '-100' })
    expect(result.action).toBe('deliver')
  })

  test('gate drops for non-allowlisted group', () => {
    const result = am.gate({ chatType: 'supergroup', senderId: '123', chatId: '-100' })
    expect(result.action).toBe('drop')
  })

  test('assertAllowedChat passes for allowlisted chat', () => {
    writeFileSync(join(testDir, 'access.json'), JSON.stringify({ allowFrom: ['123'] }))
    expect(() => am.assertAllowedChat('123')).not.toThrow()
  })

  test('assertAllowedChat passes for allowlisted group', () => {
    writeFileSync(join(testDir, 'access.json'), JSON.stringify({ groups: { '-100': { requireMention: true, allowFrom: [] } } }))
    expect(() => am.assertAllowedChat('-100')).not.toThrow()
  })

  test('assertAllowedChat throws for unknown chat', () => {
    expect(() => am.assertAllowedChat('999')).toThrow('not allowlisted')
  })

  test('chunk splits long text', () => {
    const text = 'a'.repeat(5000)
    const chunks = am.chunk(text, 4096, 'length')
    expect(chunks.length).toBe(2)
    expect(chunks[0].length).toBe(4096)
  })

  test('chunk returns single piece for short text', () => {
    expect(am.chunk('hello', 4096, 'length')).toEqual(['hello'])
  })

  test('chunk prefers paragraph boundaries in newline mode', () => {
    const text = 'a'.repeat(3000) + '\n\n' + 'b'.repeat(3000)
    const chunks = am.chunk(text, 4096, 'newline')
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toBe('a'.repeat(3000))
  })
})
