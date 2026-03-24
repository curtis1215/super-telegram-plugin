---
name: configure
description: Set up the Telegram channel — save the bot token and review access policy
user-invocable: true
---

# /super-telegram:configure

Manage Telegram bot token and channel configuration.

## Usage

Use the `configure` MCP tool with the appropriate action:

- **`status`** — Show whether a bot token is set and current access policy summary
- **`set_token`** + token — Save the bot token (format: `digits:alphanumeric`)
- **`clear_token`** — Remove the bot token

## Security

- NEVER print the full bot token — only confirm it exists or show last 4 chars
