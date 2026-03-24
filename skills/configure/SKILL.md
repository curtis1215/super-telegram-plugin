---
name: configure
description: Set up the Telegram channel — save the bot token and review access policy
user_invocable: true
---

# /telegram:configure

Manage Telegram bot token and channel configuration.

## File locations

- Token: `~/.claude/channels/telegram/.env` (format: `TELEGRAM_BOT_TOKEN=...`)
- Access policy: `~/.claude/channels/telegram/access.json`

## Behavior

**No arguments** → show current status:
1. Read `~/.claude/channels/telegram/.env` — report whether a token is set (never print it)
2. Read `~/.claude/channels/telegram/access.json` — summarize dmPolicy, allowFrom count, group count
3. Suggest next steps (set token, change policy, pair users)

**`<token>` argument** (looks like `digits:alphanumeric`):
1. Write `TELEGRAM_BOT_TOKEN=<token>` to `~/.claude/channels/telegram/.env`
2. `chmod 600` the file
3. Confirm saved, show status, suggest restarting the session

**`clear` argument**:
1. Remove the `TELEGRAM_BOT_TOKEN=...` line from `.env`
2. Confirm cleared

## Security

- NEVER print the full bot token — only confirm it exists or show last 4 chars
- chmod 600 on .env file after writing
- Proactively suggest `allowlist` policy over `pairing` for production use
