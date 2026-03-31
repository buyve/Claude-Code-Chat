<p align="center">
  <img src="https://raw.githubusercontent.com/buyve/Claude-Code-Chat/main/assets/banner.png" alt="CCC — Claude Code Chat" width="100%">
</p>

<h1 align="center">CCC — Claude Code Chat 💬</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/cc-irc"><img src="https://img.shields.io/npm/v/cc-irc?style=for-the-badge&color=cb3837&label=npm" alt="npm"></a>
  <a href="https://github.com/buyve/Claude-Code-Chat"><img src="https://img.shields.io/github/stars/buyve/Claude-Code-Chat?style=for-the-badge&color=blue&label=GitHub" alt="GitHub"></a>
  <a href="https://github.com/buyve/Claude-Code-Chat/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="License"></a>
  <a href="https://cc-irc.fly.dev"><img src="https://img.shields.io/badge/server-live-brightgreen?style=for-the-badge" alt="Server"></a>
</p>

<p align="center">
  <strong>WeeChat-style terminal messenger for Claude Code users.</strong><br>
  Discord for developers who live in the terminal — no browser, no Electron, just ANSI.
</p>

---

## Why CCC?

You're running Claude Code in three terminals. Your teammate is running it in two more. You want to share a snippet, ask a quick question, or see who's coding what — without leaving the terminal.

CCC is a **real-time IRC-style chat** that lives alongside your Claude Code sessions. It auto-detects active CC sessions, shows rich presence (`⚡ coding · TypeScript · myproject`), and renders everything in a pixel-perfect WeeChat TUI.

**One command to install. One command to chat.**

```bash
npm i -g cc-irc && ccc
```

---

## Features

<table>
  <tr>
    <td><strong>WeeChat TUI</strong></td>
    <td>6-region layout with custom ANSI rendering. No blessed, no ink — raw <code>stdout.write()</code> with double-buffered screen diffing and DEC 2026 synchronized output for zero-flicker rendering.</td>
  </tr>
  <tr>
    <td><strong>CC Session Presence</strong></td>
    <td>Auto-detects Claude Code sessions via <code>~/.claude/sessions/</code>. Shows project name, language, and duration in the nicklist. Your teammates see what you're working on in real time.</td>
  </tr>
  <tr>
    <td><strong>Interactive CC Terminal</strong></td>
    <td>Run Claude Code inside CCC via full PTY integration. VTE terminal emulator renders CC output in the chat region with mouse forwarding, scrollback, and clipboard passthrough.</td>
  </tr>
  <tr>
    <td><strong>SSH Key Auth</strong></td>
    <td>No passwords, no signup. Ed25519 challenge-response authentication. Your SSH key is your identity — auto-generated on first run.</td>
  </tr>
  <tr>
    <td><strong>Korean/CJK/Emoji</strong></td>
    <td>Proper column-width calculation via <code>string-width</code>. Every widget handles double-width characters correctly — no layout breakage with 한글, 日本語, or 🎮 emoji.</td>
  </tr>
  <tr>
    <td><strong>Mouse Selection</strong></td>
    <td>Drag-to-select text in any channel or CC session. Copies to clipboard via native <code>pbcopy</code>/OSC 52. SGR 1003 full mouse tracking with press, drag, and release events.</td>
  </tr>
  <tr>
    <td><strong>Desktop Notifications</strong></td>
    <td>System notifications on @mention and DM via OSC 777 + native (<code>osascript</code>/<code>notify-send</code>). Never miss a message while focused on code.</td>
  </tr>
  <tr>
    <td><strong>Self-Hostable</strong></td>
    <td>Run your own server with one command. Docker + Fly.io ready. SQLite with WAL mode for persistence, rate limiting, and auto-reconnect built in.</td>
  </tr>
</table>

---

## Quick Install

```bash
npm i -g cc-irc
```

> **Requires [Bun](https://bun.sh) runtime.** Install with `curl -fsSL https://bun.sh/install | bash`

Then just run:

```bash
ccc
```

Connects to the public server at `wss://cc-irc.fly.dev` automatically. No configuration needed.

---

## TUI Preview

```
┌──────────┬────────────────────────────────────┬──────────┐
│ 📂 Chan  │ #general — General discussion      │ coding(2)│
│ 1.#gen   │                                    │ ⚡ alice  │
│ 2.#dev   │ [09:41] <alice> │ hey everyone!    │ ⚡ charlie│
│          │ [09:41]   <bob> │ check this out:  │ online(1)│
│ 💬 DMs   │         <bob> │ https://x.com/... │ ● bob    │
│ 3.alice  │ [09:42] <alice> │ 한글 테스트 🎮   │          │
│          │ [09:42]     --> │ charlie joined   │ offline  │
│ ⚡ CC     │ ──────────────── (read marker)     │ ○ dave   │
│ 4.⚡myapp │ [09:43]   <bob> │ @alice look ↑   │          │
├──────────┴────────────────────────────────────┴──────────┤
│ [me] │ Connected │ #general │ lag: 12ms                  │
├──────────────────────────────────────────────────────────┤
│ [#general] hello world█                                  │
└──────────────────────────────────────────────────────────┘
```

---

## Commands

| Command | Description |
|---------|-------------|
| `/join #channel` | Join a channel |
| `/part [message]` | Leave current channel |
| `/msg nick text` | Send a direct message |
| `/nick newnick` | Change your nickname |
| `/topic [text]` | View or set channel topic |
| `/whois nick` | Show user presence info |
| `/list` | List all channels |
| `/search text` | Search messages in current buffer |
| `/ignore nick` | Ignore a user's messages |
| `/unignore nick` | Stop ignoring a user |
| `/me action` | Send an action message |
| `/dnd` | Toggle Do Not Disturb |
| `/close` | Close current buffer |
| `/clear` | Clear chat buffer |
| `/help` | Show all commands |

---

## Keybindings

| Key | Action |
|-----|--------|
| `Alt+1-9` | Switch to buffer 1–9 |
| `Alt+J` `NN` | Switch to buffer 10+ (two-digit) |
| `Alt+←/→` | Previous / next buffer |
| `PageUp/Down` | Scroll chat history |
| `Alt+M` | Toggle mouse tracking |
| `Alt+L` | Toggle bare mode (strip colors) |
| `Tab` | Complete nick / channel / command |
| `Ctrl+R` | Reverse history search |
| `Up/Down` | Per-buffer input history |
| `Ctrl+Up/Down` | Global input history |
| `Ctrl+A/E` | Home / End |
| `Ctrl+W` | Delete word backward |
| `Ctrl+K/U` | Delete to end / start of line |
| `Ctrl+C/D` | Quit (with confirmation) |
| Mouse click | Switch buffer (buflist) / Open URL (chat) / DM user (nicklist) |
| Mouse drag | Select text → auto-copy to clipboard |
| Scroll wheel | Scroll chat / buflist / nicklist |

---

## Architecture

```
┌─────────────────────────┐         ┌─────────────────────────┐
│      Client (TUI)       │         │     Server (Bun)        │
│                         │         │                         │
│  Custom ANSI Renderer   │◄─WSS──►│  Bun.serve() WebSocket  │
│  Screen Buffer + Diff   │         │  bun:sqlite (WAL)       │
│  DEC 2026 Sync Output   │         │  SSH ed25519 Auth       │
│  string-width (CJK)     │         │  Rate Limiting          │
│  PTY + VTE (CC Session) │         │  Channel Management     │
│  Selection + Clipboard  │         │  Presence Broadcasting  │
└─────────────────────────┘         └─────────────────────────┘
```

**Runtime**: [Bun](https://bun.sh) — built-in TypeScript, WebSocket, SQLite, and test runner. No transpilation step.

**Rendering**: Custom ANSI engine with double-buffered screen, slot-based line diffing, and [DEC 2026 synchronized output](https://gist.github.com/christianparpart/d8a62cc1ab659194571024e46c2e2c70) for flicker-free rendering at 60fps.

**Authentication**: SSH ed25519 challenge-response. No passwords, no accounts. Your key pair is auto-generated on first run at `~/.ssh/ccc_ed25519`.

---

## Self-Hosting

Run your own CCC server:

```bash
# Quick start (in-memory, no persistence)
ccc server --no-persist

# Production (SQLite persistence)
CCC_PORT=3337 CCC_DB_PATH=./data/server.db ccc server

# Docker
docker build -t ccc .
docker run -p 3337:3337 -v ccc_data:/data ccc

# Fly.io (one-click cloud deploy)
fly launch && fly deploy
```

Point clients to your server:

```bash
CCC_SERVER=wss://your-server.example.com ccc
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CCC_SERVER` | `wss://cc-irc.fly.dev` | Server URL |
| `CCC_PORT` | `3337` | Server listen port |
| `CCC_NICK` | auto | Default nickname |
| `CCC_KEY_PATH` | `~/.ssh/ccc_ed25519` | SSH key path (for multi-user testing) |
| `CCC_DB_PATH` | `~/.config/ccc/server.db` | SQLite database path |
| `CCC_HOST` | `0.0.0.0` | Server bind address |

---

## Chat Logging

Messages are automatically logged to `~/.local/share/ccc/logs/`:

```
~/.local/share/ccc/logs/
├── _general.log
├── _dev.log
└── dm_alice_bob.log
```

Standard IRC log format with timestamps.

---

## Contributing

```bash
git clone https://github.com/buyve/Claude-Code-Chat.git
cd Claude-Code-Chat
bun install
bun run bin/ccc.ts server    # Terminal 1: start server
CCC_SERVER=ws://localhost:3337 bun run bin/ccc.ts client  # Terminal 2: connect
bun test                     # Run tests
```

---

## License

MIT — [LICENSE](LICENSE)
