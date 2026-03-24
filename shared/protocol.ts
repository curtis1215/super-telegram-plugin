export const PROTOCOL_VERSION = '1.0.0'

// --- Proxy → Daemon messages ---

export type RegisterMessage = {
  type: 'register'
  name: string
  version: string
}

export type UnregisterMessage = {
  type: 'unregister'
}

export type PongMessage = {
  type: 'pong'
}

export type ToolCallMessage = {
  type: 'tool_call'
  id: string
  tool: 'reply' | 'react' | 'edit_message' | 'download_attachment'
  args: Record<string, unknown>
}

export type ProxyMessage =
  | RegisterMessage
  | UnregisterMessage
  | PongMessage
  | ToolCallMessage

// --- Daemon → Proxy messages ---

export type PingMessage = {
  type: 'ping'
}

export type RegisteredMessage = {
  type: 'registered'
  name: string
}

export type UnregisteredMessage = {
  type: 'unregistered'
  reason: 'name_taken' | 'kicked' | 'heartbeat_timeout'
}

export type VersionMismatchMessage = {
  type: 'version_mismatch'
  daemon_version: string
  proxy_version: string
}

export type InboundMessage = {
  type: 'message'
  meta: {
    chat_id: string
    message_id?: string
    user: string
    user_id: string
    ts: string
    image_path?: string
    attachment_kind?: string
    attachment_file_id?: string
    attachment_size?: string
    attachment_mime?: string
    attachment_name?: string
  }
  content: string
}

export type ToolResultMessage = {
  type: 'tool_result'
  id: string
  result?: { content: Array<{ type: string; text: string }> }
  error?: string
}

export type DaemonMessage =
  | PingMessage
  | RegisteredMessage
  | UnregisteredMessage
  | VersionMismatchMessage
  | InboundMessage
  | ToolResultMessage

// --- Wire protocol helpers ---

export function encodeMessage(msg: ProxyMessage | DaemonMessage): string {
  return JSON.stringify(msg) + '\n'
}

export function decodeMessages(
  data: string,
): { messages: Array<ProxyMessage | DaemonMessage>; remainder: string } {
  const messages: Array<ProxyMessage | DaemonMessage> = []
  const lines = data.split('\n')
  const remainder = lines.pop() ?? ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      messages.push(JSON.parse(trimmed))
    } catch {
      // Skip malformed lines
    }
  }

  return { messages, remainder }
}
