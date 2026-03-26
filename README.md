# CCC — Claude Code Chat

WeeChat-style terminal messenger for Claude Code users. Discord for developers who live in the terminal.

```
┌──────────┬────────────────────────────────┬──────────┐
│ 📂 Chan  │ #general — General chat        │ coding(1)│
│ 1.#gen   │                                │ ⚡ alice  │
│ 2.#dev   │ [09:41] <alice> │ hey!         │ online(1)│
│ 3.#help  │ [09:41]   <bob> │ @me hi       │ ● bob    │
│ ⚡ CC     │ [09:42] <alice> │ 한글 🎮      │          │
│ 4.⚡ccc   │ [09:42]     --> │ charlie join │          │
│ 5.⚡api   │                                │          │
├──────────┴────────────────────────────────┴──────────┤
│ [me] │ Connected │ #general                          │
├──────────────────────────────────────────────────────┤
│ [#general] hello world                               │
└──────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install
npm i -g cc-chat

# Run (connects to public server)
ccc

# Self-host
ccc server --no-persist   # terminal 1
CCC_SERVER=ws://localhost:3337 ccc   # terminal 2
```

## Features

- **WeeChat TUI** — 6-region layout, prefix system, nick alignment, hotlist
- **CC Session Presence** — auto-detect Claude Code sessions (`⚡ coding`)
- **Real-time Chat** — WebSocket server, SSH ed25519 auth, SQLite persistence
- **Code Blocks** — fenced ``` with syntax coloring, inline `code`
- **Korean/CJK/Emoji** — correct column widths via `string-width`

## Keybindings

| Key | Action |
|-----|--------|
| `Alt+1-9` | Switch buffer |
| `Alt+←/→` | Prev/next buffer |
| `PageUp/Down` | Scroll chat |
| `Alt+M` | Toggle mouse |
| `Tab` | Complete nick/channel/command |
| `Ctrl+R` | History search |
| `Up/Down` | Input history |
| `Ctrl+C/D` | Quit (with confirmation) |

## Commands

| Command | Action |
|---------|--------|
| `/join #channel` | Join a channel |
| `/part [msg]` | Leave current channel |
| `/msg nick text` | Send DM |
| `/nick newnick` | Change nickname |
| `/dnd` | Toggle Do Not Disturb |
| `/me action` | Action message |
| `/clear` | Clear chat buffer |
| `/help` | Show command list |
| `/quit` | Quit CCC |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CCC_SERVER` | `ws://localhost:3337` | Server URL (use `wss://` for remote) |
| `CCC_PORT` | `3337` | Server port (server mode) |
| `CCC_NICK` | auto-generated | Default nickname |
| `CCC_DB_PATH` | `~/.config/ccc/server.db` | SQLite path |

## Architecture

```
Client (TUI)                    Server (Bun)
┌─────────────┐                ┌──────────────┐
│ Custom ANSI │ ◄── WSS ──►  │ Bun.serve()  │
│ string-width│                │ bun:sqlite   │
│ chalk       │                │ WAL mode     │
│ ws          │                │ ed25519 auth │
└─────────────┘                └──────────────┘
```

**Runtime**: Bun — built-in TypeScript, WebSocket, SQLite, test runner.

## Self-Hosting

```bash
# Start server
CCC_PORT=3337 CCC_DB_PATH=./data/server.db ccc server

# Or with Docker
docker build -t ccc .
docker run -p 3337:3337 -v ccc_data:/data ccc

# Deploy to fly.io
fly launch
fly deploy
```

## License

MIT
