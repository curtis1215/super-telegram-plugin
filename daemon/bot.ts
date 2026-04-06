import { Bot, GrammyError, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { join, extname } from 'path'
import { AccessManager, type GateInput } from './access'
import { SessionManager } from './session-manager'
import type { InboundMessage, ToolCallMessage, ToolResultMessage } from '../shared/protocol'

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

export type BotConfig = {
  token: string
  stateDir: string
  accessManager: AccessManager
  sessionManager: SessionManager
  sendToProxy: (connId: string, message: InboundMessage) => void
  onNoActiveSession: (chatId: string) => void
}

type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

// Filenames and titles are uploader-controlled. They land inside the <channel>
// notification — delimiter chars would let the uploader break out of the tag
// or forge a second meta entry.
function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

export class TelegramBot {
  private bot: Bot
  private config: BotConfig
  private botUsername = ''
  private inboxDir: string
  private approvedDir: string
  private approvalInterval: ReturnType<typeof setInterval> | null = null
  private shuttingDown = false

  constructor(config: BotConfig) {
    this.config = config
    this.bot = new Bot(config.token)
    this.inboxDir = join(config.stateDir, 'inbox')
    this.approvedDir = join(config.stateDir, 'approved')
    this.setupHandlers()
  }

  private setupHandlers(): void {
    const { bot } = this

    // Commands are DM-only. Responding in groups would: (1) leak pairing codes
    // via /status to other group members, (2) confirm bot presence in
    // non-allowlisted groups, (3) spam channels the operator never approved.
    // Silent drop matches the gate's behavior for unrecognized groups.

    bot.command('start', async ctx => {
      if (ctx.chat?.type !== 'private') return
      const access = this.config.accessManager.loadAccess()
      if (access.dmPolicy === 'disabled') {
        await ctx.reply(`This bot isn't accepting new connections.`)
        return
      }
      const activeName = this.config.sessionManager.getActiveSession()
      const sessionCount = this.config.sessionManager.getNamedSessions().length
      await ctx.reply(
        `This bot bridges Telegram to a Claude Code session.\n\n` +
        `To pair:\n` +
        `1. DM me anything — you'll get a 6-char code\n` +
        `2. In Claude Code: /telegram:access pair <code>\n\n` +
        `After that, DMs here reach that session.\n\n` +
        `Session commands: /list /switch <name> /disconnect /status`,
      )
    })

    bot.command('help', async ctx => {
      if (ctx.chat?.type !== 'private') return
      await ctx.reply(
        `Messages you send here route to a paired Claude Code session. ` +
        `Text, photos, documents, voice, audio, video, stickers are forwarded; ` +
        `replies and reactions come back.\n\n` +
        `/start — welcome and pairing instructions\n` +
        `/status — pairing state, active session, session count\n` +
        `/list — named sessions with active/standby markers\n` +
        `/switch <name> — set active session\n` +
        `/disconnect — clear active session`,
      )
    })

    bot.command('status', async ctx => {
      if (ctx.chat?.type !== 'private') return
      const from = ctx.from
      if (!from) return
      const senderId = String(from.id)
      const access = this.config.accessManager.loadAccess()

      if (access.allowFrom.includes(senderId)) {
        const name = from.username ? `@${from.username}` : senderId
        const activeName = this.config.sessionManager.getActiveSession()
        const sessions = this.config.sessionManager.getNamedSessions()
        const connected = sessions.filter(s => s.isConnected).length
        const sessionInfo = activeName ? `Active session: ${activeName}` : `No active session`
        const countInfo = `Connected: ${connected} / Registered: ${sessions.length}`
        await ctx.reply(`Paired as ${name}.\n${sessionInfo}\n${countInfo}`)
        return
      }

      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          await ctx.reply(`Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`)
          return
        }
      }

      await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
    })

    bot.command('list', async ctx => {
      if (ctx.chat?.type !== 'private') return
      if (!this.isAllowed(ctx)) return
      const sessions = this.config.sessionManager.getNamedSessions()
      if (sessions.length === 0) {
        await ctx.reply('No named sessions connected.')
        return
      }
      const lines = sessions.map(s => {
        const icon = s.isActive ? '●' : s.isConnected ? '○' : '◌'
        const suffix = !s.isConnected ? ' (disconnected)' : ''
        return `${icon} ${s.name}${suffix}`
      })
      await ctx.reply(lines.join('\n'))
    })

    bot.command('switch', async ctx => {
      if (ctx.chat?.type !== 'private') return
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim()
      if (!args) {
        await ctx.reply('Usage: /switch <name>')
        return
      }
      const ok = this.config.sessionManager.setActiveSession(args)
      if (!ok) {
        await ctx.reply(`Session "${args}" not found. Use /list to see available sessions.`)
        return
      }
      // Drain buffer to newly active session
      const connId = this.config.sessionManager.getActiveConnId()
      if (connId) {
        const buffered = this.config.sessionManager.drainBuffer()
        for (const msg of buffered) {
          this.config.sendToProxy(connId, msg)
        }
      }
      await ctx.reply(`Switched to session: ${args}`)
    })

    bot.command('disconnect', async ctx => {
      if (ctx.chat?.type !== 'private') return
      if (!this.isAllowed(ctx)) return
      this.config.sessionManager.clearActiveSession()
      await ctx.reply('Active session cleared.')
    })

    bot.on('message:text', async ctx => {
      await this.handleInbound(ctx, ctx.message.text, undefined)
    })

    bot.on('message:photo', async ctx => {
      const caption = ctx.message.caption ?? '(photo)'
      // Defer download until after the gate approves — any user can send photos,
      // and we don't want to burn API quota or fill the inbox for dropped messages.
      await this.handleInbound(ctx, caption, async () => {
        const photos = ctx.message.photo
        const best = photos[photos.length - 1]
        try {
          const file = await ctx.api.getFile(best.file_id)
          if (!file.file_path) return undefined
          const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`
          const res = await fetch(url)
          const buf = Buffer.from(await res.arrayBuffer())
          const ext = file.file_path.split('.').pop() ?? 'jpg'
          const path = join(this.inboxDir, `${Date.now()}-${best.file_unique_id}.${ext}`)
          mkdirSync(this.inboxDir, { recursive: true })
          writeFileSync(path, buf)
          return path
        } catch (err) {
          process.stderr.write(`telegram daemon: photo download failed: ${err}\n`)
          return undefined
        }
      })
    })

    bot.on('message:document', async ctx => {
      const doc = ctx.message.document
      const name = safeName(doc.file_name)
      const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
      await this.handleInbound(ctx, text, undefined, {
        kind: 'document',
        file_id: doc.file_id,
        size: doc.file_size,
        mime: doc.mime_type,
        name,
      })
    })

    bot.on('message:voice', async ctx => {
      const voice = ctx.message.voice
      const text = ctx.message.caption ?? '(voice message)'
      await this.handleInbound(ctx, text, undefined, {
        kind: 'voice',
        file_id: voice.file_id,
        size: voice.file_size,
        mime: voice.mime_type,
      })
    })

    bot.on('message:audio', async ctx => {
      const audio = ctx.message.audio
      const name = safeName(audio.file_name)
      const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
      await this.handleInbound(ctx, text, undefined, {
        kind: 'audio',
        file_id: audio.file_id,
        size: audio.file_size,
        mime: audio.mime_type,
        name,
      })
    })

    bot.on('message:video', async ctx => {
      const video = ctx.message.video
      const text = ctx.message.caption ?? '(video)'
      await this.handleInbound(ctx, text, undefined, {
        kind: 'video',
        file_id: video.file_id,
        size: video.file_size,
        mime: video.mime_type,
        name: safeName(video.file_name),
      })
    })

    bot.on('message:video_note', async ctx => {
      const vn = ctx.message.video_note
      await this.handleInbound(ctx, '(video note)', undefined, {
        kind: 'video_note',
        file_id: vn.file_id,
        size: vn.file_size,
      })
    })

    bot.on('message:sticker', async ctx => {
      const sticker = ctx.message.sticker
      const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
      await this.handleInbound(ctx, `(sticker${emoji})`, undefined, {
        kind: 'sticker',
        file_id: sticker.file_id,
        size: sticker.file_size,
      })
    })

    // Without this, any throw in a message handler stops polling permanently
    // (grammy's default error handler calls bot.stop() and rethrows).
    bot.catch(err => {
      process.stderr.write(`telegram daemon: handler error (polling continues): ${err.error}\n`)
    })
  }

  /** Check if the sender is in the allowFrom list. Silently drops unauthorized users. */
  private isAllowed(ctx: Context): boolean {
    const from = ctx.from
    if (!from) return false
    const senderId = String(from.id)
    const access = this.config.accessManager.loadAccess()
    return access.allowFrom.includes(senderId)
  }

  private async handleInbound(
    ctx: Context,
    text: string,
    downloadImage: (() => Promise<string | undefined>) | undefined,
    attachment?: AttachmentMeta,
  ): Promise<void> {
    const from = ctx.from
    if (!from) return

    const chatType = ctx.chat?.type ?? 'private'
    const senderId = String(from.id)
    const chatId = String(ctx.chat!.id)
    const entities = (ctx.message?.entities ?? ctx.message?.caption_entities ?? []).map(e => ({
      type: e.type,
      offset: e.offset,
      length: e.length,
      user: e.type === 'text_mention' && 'user' in e
        ? { is_bot: (e as any).user.is_bot, username: (e as any).user.username }
        : undefined,
    }))
    const replyToUsername = ctx.message?.reply_to_message?.from?.username

    const gateInput: GateInput = {
      chatType,
      senderId,
      chatId,
      botUsername: this.botUsername || undefined,
      entities,
      text,
      replyToUsername,
    }

    const result = this.config.accessManager.gate(gateInput)

    if (result.action === 'drop') return

    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
      return
    }

    // action === 'deliver'
    const access = result.access
    const msgId = ctx.message?.message_id

    // Typing indicator — signals "processing" until we reply (or ~5s elapses).
    void this.bot.api.sendChatAction(chatId, 'typing').catch(() => {})

    // Ack reaction — lets the user know we're processing. Fire-and-forget.
    if (access.ackReaction && msgId != null) {
      void this.bot.api
        .setMessageReaction(chatId, msgId, [
          { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
        ])
        .catch(() => {})
    }

    const imagePath = downloadImage ? await downloadImage() : undefined

    const inbound: InboundMessage = {
      type: 'message',
      meta: {
        chat_id: chatId,
        ...(msgId != null ? { message_id: String(msgId) } : {}),
        user: from.username ?? String(from.id),
        user_id: String(from.id),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
        ...(imagePath ? { image_path: imagePath } : {}),
        ...(attachment
          ? {
              attachment_kind: attachment.kind,
              attachment_file_id: attachment.file_id,
              ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
              ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
              ...(attachment.name ? { attachment_name: attachment.name } : {}),
            }
          : {}),
      },
      content: text,
    }

    const connId = this.config.sessionManager.getActiveConnId()
    if (connId) {
      this.config.sendToProxy(connId, inbound)
    } else if (this.config.sessionManager.getActiveSession() !== null) {
      // Active session set but connection not live — buffer the message
      this.config.sessionManager.bufferMessage(inbound)
    } else {
      // No active session at all
      this.config.onNoActiveSession(chatId)
    }
  }

  async executeToolCall(msg: ToolCallMessage): Promise<ToolResultMessage> {
    const args = msg.args
    try {
      switch (msg.tool) {
        case 'reply': {
          const chat_id = args.chat_id as string
          const text = args.text as string
          const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
          const files = (args.files as string[] | undefined) ?? []
          const format = (args.format as string | undefined) ?? 'text'
          const parseMode = format === 'markdownv2' ? ('MarkdownV2' as const) : undefined

          this.config.accessManager.assertAllowedChat(chat_id)

          for (const f of files) {
            this.config.accessManager.assertSendable(f)
            const st = statSync(f)
            if (st.size > MAX_ATTACHMENT_BYTES) {
              throw new Error(
                `file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`,
              )
            }
          }

          const { limit, mode, replyMode } = this.config.accessManager.getChunkConfig()
          const chunks = this.config.accessManager.chunk(text, limit, mode)
          const sentIds: number[] = []

          try {
            for (let i = 0; i < chunks.length; i++) {
              const shouldReplyTo =
                reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
              const sent = await this.bot.api.sendMessage(chat_id, chunks[i], {
                ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
                ...(parseMode ? { parse_mode: parseMode } : {}),
              })
              sentIds.push(sent.message_id)
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            throw new Error(
              `reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${errMsg}`,
            )
          }

          for (const f of files) {
            const ext = extname(f).toLowerCase()
            const input = new InputFile(f)
            const opts =
              reply_to != null && replyMode !== 'off'
                ? { reply_parameters: { message_id: reply_to } }
                : undefined
            if (PHOTO_EXTS.has(ext)) {
              const sent = await this.bot.api.sendPhoto(chat_id, input, opts)
              sentIds.push(sent.message_id)
            } else {
              const sent = await this.bot.api.sendDocument(chat_id, input, opts)
              sentIds.push(sent.message_id)
            }
          }

          const resultText =
            sentIds.length === 1
              ? `sent (id: ${sentIds[0]})`
              : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
          return {
            type: 'tool_result',
            id: msg.id,
            result: { content: [{ type: 'text', text: resultText }] },
          }
        }

        case 'react': {
          this.config.accessManager.assertAllowedChat(args.chat_id as string)
          await this.bot.api.setMessageReaction(
            args.chat_id as string,
            Number(args.message_id),
            [{ type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] }],
          )
          return {
            type: 'tool_result',
            id: msg.id,
            result: { content: [{ type: 'text', text: 'reacted' }] },
          }
        }

        case 'edit_message': {
          this.config.accessManager.assertAllowedChat(args.chat_id as string)
          const editFormat = (args.format as string | undefined) ?? 'text'
          const editParseMode = editFormat === 'markdownv2' ? ('MarkdownV2' as const) : undefined
          const edited = await this.bot.api.editMessageText(
            args.chat_id as string,
            Number(args.message_id),
            args.text as string,
            ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
          )
          const id = typeof edited === 'object' ? edited.message_id : args.message_id
          return {
            type: 'tool_result',
            id: msg.id,
            result: { content: [{ type: 'text', text: `edited (id: ${id})` }] },
          }
        }

        case 'download_attachment': {
          const file_id = args.file_id as string
          const file = await this.bot.api.getFile(file_id)
          if (!file.file_path)
            throw new Error('Telegram returned no file_path — file may have expired')
          const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`
          const res = await fetch(url)
          if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
          const buf = Buffer.from(await res.arrayBuffer())
          const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
          const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
          const uniqueId =
            (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
          const path = join(this.inboxDir, `${Date.now()}-${uniqueId}.${ext}`)
          mkdirSync(this.inboxDir, { recursive: true })
          writeFileSync(path, buf)
          return {
            type: 'tool_result',
            id: msg.id,
            result: { content: [{ type: 'text', text: path }] },
          }
        }

        default: {
          return {
            type: 'tool_result',
            id: msg.id,
            error: `unknown tool: ${msg.tool}`,
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return {
        type: 'tool_result',
        id: msg.id,
        error: `${msg.tool} failed: ${errMsg}`,
      }
    }
  }

  async sendDirectMessage(chatId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(chatId, text).catch(() => {})
  }

  getBotUsername(): string {
    return this.botUsername
  }

  // The /telegram:access skill drops a file at approved/<senderId> when it pairs
  // someone. Poll for it, send confirmation, clean up.
  startApprovalPolling(): void {
    const check = (): void => {
      let files: string[]
      try {
        files = readdirSync(this.approvedDir)
      } catch {
        return
      }
      if (files.length === 0) return

      for (const senderId of files) {
        const file = join(this.approvedDir, senderId)
        void this.bot.api.sendMessage(senderId, 'Paired! Say hi to Claude.').then(
          () => rmSync(file, { force: true }),
          err => {
            process.stderr.write(`telegram daemon: failed to send approval confirm: ${err}\n`)
            rmSync(file, { force: true })
          },
        )
      }
    }

    this.approvalInterval = setInterval(check, 5000)
    this.approvalInterval.unref()
  }

  async start(): Promise<void> {
    // 409 Conflict = another getUpdates consumer is still active (zombie from a
    // previous session, or a second Claude Code instance). Retry with backoff
    // until the slot frees up instead of crashing on the first rejection.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.bot.start({
          onStart: info => {
            this.botUsername = info.username
            process.stderr.write(`telegram daemon: polling as @${info.username}\n`)
            void this.bot.api
              .setMyCommands(
                [
                  { command: 'start', description: 'Welcome and setup guide' },
                  { command: 'help', description: 'What this bot can do' },
                  { command: 'status', description: 'Check pairing and session state' },
                  { command: 'list', description: 'List connected sessions' },
                  { command: 'switch', description: 'Switch active session' },
                  { command: 'disconnect', description: 'Clear active session' },
                ],
                { scope: { type: 'all_private_chats' } },
              )
              .catch(() => {})
          },
        })
        return // bot.stop() was called — clean exit from the loop
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 409) {
          const delay = Math.min(1000 * attempt, 15000)
          const detail =
            attempt === 1
              ? ' — another instance is polling (zombie session, or a second Claude Code running?)'
              : ''
          process.stderr.write(
            `telegram daemon: 409 Conflict${detail}, retrying in ${delay / 1000}s\n`,
          )
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        // bot.stop() mid-setup rejects with grammy's "Aborted delay" — expected, not an error.
        if (err instanceof Error && err.message === 'Aborted delay') return
        process.stderr.write(`telegram daemon: polling failed: ${err}\n`)
        return
      }
    }
  }

  stop(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    if (this.approvalInterval) {
      clearInterval(this.approvalInterval)
      this.approvalInterval = null
    }
    process.stderr.write('telegram daemon: bot stopping\n')
    // bot.stop() signals the poll loop to end; the current getUpdates request
    // may take up to its long-poll timeout to return. Force-exit after 2s.
    setTimeout(() => process.exit(0), 2000).unref()
    void Promise.resolve(this.bot.stop()).finally(() => process.exit(0))
  }
}
