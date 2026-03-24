import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, mkdirSync,
  renameSync, realpathSync,
} from 'fs'
import { join, sep } from 'path'

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export type GateInput = {
  chatType: string
  senderId: string
  chatId: string
  botUsername?: string
  entities?: Array<{ type: string; offset: number; length: number; user?: { is_bot: boolean; username: string } }>
  text?: string
  replyToUsername?: string
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

const MAX_CHUNK_LIMIT = 4096

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

export class AccessManager {
  private stateDir: string
  private accessFile: string
  private staticAccess: Access | null = null

  constructor(stateDir: string, staticMode = false) {
    this.stateDir = stateDir
    this.accessFile = join(stateDir, 'access.json')

    if (staticMode) {
      const a = this.readAccessFile()
      if (a.dmPolicy === 'pairing') a.dmPolicy = 'allowlist'
      a.pending = {}
      this.staticAccess = a
    }
  }

  private readAccessFile(): Access {
    try {
      const raw = readFileSync(this.accessFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Access>
      return {
        dmPolicy: parsed.dmPolicy ?? 'pairing',
        allowFrom: parsed.allowFrom ?? [],
        groups: parsed.groups ?? {},
        pending: parsed.pending ?? {},
        mentionPatterns: parsed.mentionPatterns,
        ackReaction: parsed.ackReaction,
        replyToMode: parsed.replyToMode,
        textChunkLimit: parsed.textChunkLimit,
        chunkMode: parsed.chunkMode,
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
      try { renameSync(this.accessFile, `${this.accessFile}.corrupt-${Date.now()}`) } catch {}
      return defaultAccess()
    }
  }

  loadAccess(): Access {
    return this.staticAccess ?? this.readAccessFile()
  }

  saveAccess(a: Access): void {
    if (this.staticAccess) return
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const tmp = this.accessFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.accessFile)
  }

  private pruneExpired(a: Access): boolean {
    const now = Date.now()
    let changed = false
    for (const [code, p] of Object.entries(a.pending)) {
      if (p.expiresAt < now) { delete a.pending[code]; changed = true }
    }
    return changed
  }

  gate(input: GateInput): GateResult {
    const access = this.loadAccess()
    const pruned = this.pruneExpired(access)
    if (pruned) this.saveAccess(access)
    if (access.dmPolicy === 'disabled') return { action: 'drop' }

    const { chatType, senderId, chatId } = input

    if (chatType === 'private') {
      if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
      if (access.dmPolicy === 'allowlist') return { action: 'drop' }

      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          if ((p.replies ?? 1) >= 2) return { action: 'drop' }
          p.replies = (p.replies ?? 1) + 1
          this.saveAccess(access)
          return { action: 'pair', code, isResend: true }
        }
      }
      if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

      const code = randomBytes(3).toString('hex')
      const now = Date.now()
      access.pending[code] = { senderId, chatId, createdAt: now, expiresAt: now + 3600000, replies: 1 }
      this.saveAccess(access)
      return { action: 'pair', code, isResend: false }
    }

    if (chatType === 'group' || chatType === 'supergroup') {
      const policy = access.groups[chatId]
      if (!policy) return { action: 'drop' }
      if ((policy.allowFrom ?? []).length > 0 && !(policy.allowFrom ?? []).includes(senderId)) return { action: 'drop' }
      if ((policy.requireMention ?? true) && !this.isMentioned(input, access.mentionPatterns)) return { action: 'drop' }
      return { action: 'deliver', access }
    }

    return { action: 'drop' }
  }

  private isMentioned(input: GateInput, extraPatterns?: string[]): boolean {
    const entities = input.entities ?? []
    const text = input.text ?? ''
    const botUsername = input.botUsername

    for (const e of entities) {
      if (e.type === 'mention' && botUsername) {
        const mentioned = text.slice(e.offset, e.offset + e.length)
        if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
      }
      if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
    }
    if (input.replyToUsername && input.replyToUsername === botUsername) return true
    for (const pat of extraPatterns ?? []) {
      try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
    }
    return false
  }

  assertAllowedChat(chatId: string): void {
    const access = this.loadAccess()
    if (access.allowFrom.includes(chatId)) return
    if (chatId in access.groups) return
    throw new Error(`chat ${chatId} is not allowlisted — add via /telegram:access`)
  }

  assertSendable(filePath: string): void {
    let real: string, stateReal: string
    try { real = realpathSync(filePath); stateReal = realpathSync(this.stateDir) } catch { return }
    const inbox = join(stateReal, 'inbox')
    if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${filePath}`)
    }
  }

  chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
    if (text.length <= limit) return [text]
    const out: string[] = []
    let rest = text
    while (rest.length > limit) {
      let cut = limit
      if (mode === 'newline') {
        const para = rest.lastIndexOf('\n\n', limit)
        const line = rest.lastIndexOf('\n', limit)
        const space = rest.lastIndexOf(' ', limit)
        cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
      }
      out.push(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^\n+/, '')
    }
    if (rest) out.push(rest)
    return out
  }

  getChunkConfig(): { limit: number; mode: 'length' | 'newline'; replyMode: 'off' | 'first' | 'all' } {
    const access = this.loadAccess()
    return {
      limit: Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT)),
      mode: access.chunkMode ?? 'length',
      replyMode: access.replyToMode ?? 'first',
    }
  }
}
