# telegram-router

Telegram channel plugin for Claude Code with centralized daemon routing.

Replaces the official `telegram@claude-plugins-official` plugin with a daemon + proxy architecture that eliminates 409 polling conflicts and enables multi-session message routing.

## Architecture

```
Telegram Bot API
       | long-polling (single consumer)
       v
  telegram-router (Daemon)
  |  grammy bot polling
  |  Session registry + heartbeat
  |  Bot commands: /list /switch /status /disconnect
  |  Access control (gate, pairing, allowlists)
  |  Unix socket server
       |
  +----|----+
  v    v    v
Proxy Proxy Proxy   (one per Claude Code session)
  |    |    |
  v    v    v
Claude Code sessions (stdio MCP)
```

**Daemon** (`daemon/router.ts`): Long-running background service managed by launchd (macOS) or systemd (Linux). Holds the sole grammY polling connection. Manages session registration, heartbeat detection, and message routing via Unix domain socket.

**Proxy** (`proxy/server.ts`): Lightweight MCP server spawned per Claude Code session. Forwards tool calls to daemon and delivers inbound messages to Claude via MCP notifications. Connects to daemon over Unix socket.

## Why

The official Telegram plugin spawns a separate grammY polling process per session. This causes:

- **409 Conflict**: Telegram Bot API allows only one polling consumer per token
- **Orphan processes**: Session cleanup doesn't always kill the bot process
- **No routing**: No mechanism to route messages between multiple sessions

This plugin solves all three by centralizing polling in a single daemon.

## Installation

```bash
claude plugin marketplace add https://github.com/curtis1215/super-telegram-plugin
claude plugin install super-telegram@super-telegram-plugin
```

### Launch with plugin

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:super-telegram@super-telegram-plugin
```

The proxy auto-installs and starts the daemon on first session launch.

### Manual daemon management

```bash
bun run daemon:install    # Install as launchd/systemd service
bun run daemon:uninstall  # Remove service
bun run daemon:status     # Check if running
```

## Migration from Official Plugin

This plugin is a **drop-in replacement** for `telegram@claude-plugins-official`.

### What carries over (zero config)

- Bot token from `~/.claude/channels/telegram/.env`
- Access policy from `~/.claude/channels/telegram/access.json`
- All MCP tools: `reply`, `react`, `edit_message`, `download_attachment`
- Skills: `/super-telegram:configure`, `/super-telegram:access`
- Channel notification format (`<channel source="telegram" ...>`)

### What's new

- `/super-telegram:connect <name>` — register session for message routing
- `/super-telegram:disconnect` — unregister session
- Telegram bot commands: `/list`, `/switch <name>`, `/status`, `/disconnect`
- Multi-session support with active session switching
- Daemon auto-start and heartbeat monitoring

### Migration steps

1. **Remove** the official plugin:
   ```bash
   claude plugin remove telegram@claude-plugins-official
   ```
2. **Install** this plugin:
   ```bash
   claude plugin marketplace add https://github.com/curtis1215/super-telegram-plugin
   claude plugin install super-telegram@super-telegram-plugin
   ```
3. **Done**. Existing `.env` and `access.json` are reused automatically.

> **Important**: The two plugins cannot run simultaneously. They share the same bot token, state directory, MCP server name, and tool names. Remove one before installing the other.

## Usage

### Session routing

```bash
# In Claude Code, register this session
/super-telegram:connect research

# In Telegram, switch to this session
/switch research

# Messages now route to this Claude Code session
```

### Environment variable

```bash
# Auto-register on session start
TELEGRAM_SESSION_NAME="research" claude
```

### Unnamed sessions

Sessions without a name can still use outbound tools (reply, react, edit) but won't receive inbound messages.

## Project Structure

```
telegram-router-plugin/
├── shared/protocol.ts          # Socket protocol types
├── daemon/
│   ├── router.ts               # Daemon main entry
│   ├── bot.ts                  # grammY bot + commands
│   ├── access.ts               # Access control (gate, pairing)
│   ├── session-manager.ts      # Session registry + heartbeat
│   └── socket-server.ts        # Unix socket server
├── proxy/
│   ├── server.ts               # MCP proxy entry point
│   ├── socket-client.ts        # Daemon client
│   └── signal-watcher.ts       # File signal mechanism
├── scripts/setup-daemon.ts     # Service installation
└── skills/
    ├── configure/SKILL.md      # /super-telegram:configure
    ├── access/SKILL.md         # /super-telegram:access
    └── connect/SKILL.md        # /super-telegram:connect
```

## Development

```bash
bun install          # Install dependencies
bun test             # Run tests (60 tests)
bun run typecheck    # TypeScript check
bun run daemon       # Start daemon directly
bun run start        # Start proxy directly
```

## License

MIT
