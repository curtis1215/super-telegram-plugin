---
name: connect
description: Connect or disconnect this session from Telegram message routing
user-invocable: true
---

# /super-telegram:connect

Register this Claude Code session with a name so it can receive Telegram messages.

## Usage

**`/super-telegram:connect <name>`** — Call the `connect_session` tool with the provided name.

**`/super-telegram:disconnect`** — Call the `disconnect_session` tool.

## Notes

- Sessions without a name can still use reply/react/edit tools (outbound only)
- Only the "active" session receives inbound messages — use `/switch <name>` in Telegram to choose
