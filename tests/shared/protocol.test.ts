import { describe, test, expect } from 'bun:test'
import {
  type ProxyMessage,
  type DaemonMessage,
  encodeMessage,
  decodeMessages,
  PROTOCOL_VERSION,
} from '../../shared/protocol'

describe('protocol', () => {
  test('PROTOCOL_VERSION is a semver string', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('encodeMessage produces JSON line', () => {
    const msg: ProxyMessage = { type: 'pong' }
    const encoded = encodeMessage(msg)
    expect(encoded).toBe('{"type":"pong"}\n')
  })

  test('decodeMessages handles single complete message', () => {
    const { messages, remainder } = decodeMessages('{"type":"ping"}\n')
    expect(messages).toEqual([{ type: 'ping' }])
    expect(remainder).toBe('')
  })

  test('decodeMessages handles multiple messages', () => {
    const input = '{"type":"ping"}\n{"type":"ping"}\n'
    const { messages, remainder } = decodeMessages(input)
    expect(messages).toHaveLength(2)
    expect(remainder).toBe('')
  })

  test('decodeMessages preserves incomplete trailing data', () => {
    const input = '{"type":"ping"}\n{"type":"po'
    const { messages, remainder } = decodeMessages(input)
    expect(messages).toHaveLength(1)
    expect(remainder).toBe('{"type":"po')
  })

  test('decodeMessages handles empty input', () => {
    const { messages, remainder } = decodeMessages('')
    expect(messages).toHaveLength(0)
    expect(remainder).toBe('')
  })

  test('decodeMessages skips blank lines', () => {
    const input = '{"type":"ping"}\n\n{"type":"ping"}\n'
    const { messages, remainder } = decodeMessages(input)
    expect(messages).toHaveLength(2)
  })

  test('type guards validate ProxyMessage types', () => {
    const register: ProxyMessage = {
      type: 'register',
      name: 'research',
      version: '1.0.0',
    }
    expect(register.type).toBe('register')

    const toolCall: ProxyMessage = {
      type: 'tool_call',
      id: 'x1',
      tool: 'reply',
      args: { chat_id: '123', text: 'hello' },
    }
    expect(toolCall.type).toBe('tool_call')
  })

  test('type guards validate DaemonMessage types', () => {
    const message: DaemonMessage = {
      type: 'message',
      meta: {
        chat_id: '123',
        message_id: '456',
        user: 'testuser',
        user_id: '789',
        ts: '2026-03-24T00:00:00.000Z',
      },
      content: 'hello',
    }
    expect(message.type).toBe('message')

    const toolResult: DaemonMessage = {
      type: 'tool_result',
      id: 'x1',
      result: { content: [{ type: 'text', text: 'sent (id: 79)' }] },
    }
    expect(toolResult.type).toBe('tool_result')

    const toolError: DaemonMessage = {
      type: 'tool_result',
      id: 'x2',
      error: 'reply failed',
    }
    expect(toolError.type).toBe('tool_result')
    expect(toolError.error).toBe('reply failed')
  })
})
