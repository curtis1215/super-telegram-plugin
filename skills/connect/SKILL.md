---
name: connect
description: Connect or disconnect this session from Telegram message routing
user_invocable: true
---

# /telegram:connect

Register this Claude Code session with a name so it can receive Telegram messages.

## Usage

**`/telegram:connect <name>`** — Register this session:
1. Find the proxy PID by listing `~/.claude/channels/telegram/sessions/*.pid`
2. Read each `.pid` file to find one matching the current session (by recency if ambiguous — pick the newest)
3. Write a signal file at `~/.claude/channels/telegram/sessions/<pid>.signal`:
   ```json
   { "action": "connect", "name": "<name>" }
   ```
4. Confirm: "Connecting as `<name>`. The daemon will route Telegram messages to this session."
5. Suggest: "Use `/list` in Telegram to see sessions, `/switch <name>` to activate this one."

**`/telegram:disconnect`** — Unregister this session:
1. Find the proxy PID (same as above)
2. Write signal file:
   ```json
   { "action": "disconnect" }
   ```
3. Confirm: "Disconnected. This session will no longer receive Telegram messages but can still send replies."

**`/telegram:connect <new-name>`** (when already connected) — Rename:
- Same as connect — the proxy handles unregistering the old name before registering the new one

## Notes

- Sessions without a name can still use reply/react/edit tools (outbound only)
- Only the "active" session receives inbound messages — use `/switch <name>` in Telegram to choose
- The proxy picks up the signal file within ~500ms
