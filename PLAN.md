# CCC (Claude Code Chat) — Implementation Plan

## Context

CCC is a terminal-native messenger for Claude Code users — "Discord for developers who live in the terminal." The core value is automatic presence via CC sessions: coding = online. The TUI replicates WeeChat's layout, prefix system, hotlist, and interactions down to the detail level.

**Architecture:**

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Bun | Built-in TS, WebSocket server, SQLite (`bun:sqlite`), test runner. Zero compile step. |
| TUI | Custom ANSI engine | neo-blessed abandoned (7yr), CJK layout broken. Ink is prompt-oriented. Raw ANSI + `string-width` = full Korean/emoji control. |
| Persistence | SQLite via `bun:sqlite` | Zero-dep, WAL mode, server restart preserves history/nicks. `--no-persist` flag for dev. |
| Auth | SSH ed25519 challenge-response | No signup. Public key = user ID. |
| Presence | Poll `~/.claude/sessions/*.json` | No SDK dep. File existence + PID alive check. |
| Public server | fly.io | Free tier sufficient for MVP. Persistent volume for SQLite. `wss://ccc.fly.dev` default. |
| Package | `cc-chat` on npm | Available. CLI binary = `ccc`. `npm i -g cc-chat && ccc` to start. |

**WeeChat source references** (GPL v3, behavior spec extraction):
- `gui-chat.c` — prefix system, nick alignment, time elision
- `gui-hotlist.c` — 4-level priority, counter format
- `gui-nicklist.c` — group sorting
- `gui-line.c` — read marker, date change lines
- `gui-mouse.c` — region detection, click dispatch
- `core-completion.c` — tab completion (nick/channel/command)
- `core-command.c` — history, Ctrl+R search

**Dependencies** (client): `chalk`, `ansi-escapes`, `string-width`, `cli-cursor`, `ws`
**Dependencies** (server): none beyond Bun built-ins (`bun:sqlite`, `Bun.serve`)

---

## Phase 1: TUI Shell — "Hello WeeChat"

**Goal**: Pixel-perfect WeeChat TUI with local echo. No networking. All rendering, input, and interaction patterns finalized here.

### 1.1 Scaffolding
- `bun init`, install deps, `tsconfig.json` (strict, ES2022)
- `bin/ccc.ts` entry (`#!/usr/bin/env bun`)
- `package.json`: `"name": "cc-chat"`, `"bin": {"ccc": "./bin/ccc.ts"}`
- **Done**: `bun run bin/ccc.ts` exits clean

### 1.2 Types & Protocol
`src/shared/types.ts`, `src/shared/protocol.ts`

```typescript
type MessageType = 'chat' | 'action' | 'join' | 'part' | 'network' | 'error' | 'system' | 'date_change';
type HotlistPriority = 0 | 1 | 2 | 3;  // low | message | private | highlight
interface HotlistEntry { low: number; message: number; private: number; highlight: number; }
interface User { id: string; nick: string; publicKey: string; presence: PresenceStatus; richPresence?: RichPresence; }
interface Message { id: string; from: string; channel: string; content: string; timestamp: number; type: MessageType; }
interface Channel { name: string; topic: string; members: string[]; hotlist: HotlistEntry; }
type PresenceStatus = 'online' | 'coding' | 'reviewing' | 'dnd' | 'offline';
interface RichPresence { project: string; language?: string; file?: string; duration?: number; }
```

Protocol: discriminated union `WSMessage` — auth, chat, join, part, presence, nick, dm, members, history, error.

**Done**: types compile, importable from client/ and server/

### 1.3 Theme & Prefix System
`src/client/theme.ts`

**Prefix table** (ref: `gui-chat.c`):
```
error    =!=   red
network  --    magenta
action   *     white
join     -->   green
quit     <--   red
```

**Nick rendering**:
- 16 colors from 256-palette, `nickColor(nick)` via djb2 hash
- Format: `<nick>` with right-aligned nick column + `│` separator
- Own nick: distinct color (e.g. white)

**Time**:
- Format: `[HH:MM]` in gray
- Same-minute elision: blank if same as previous message
- Date change: `── 2026-03-26 (Thu) ──` centered, dim

**Hotlist colors** (ref: `gui-hotlist.c`):
- `low(0)`: default, `message(1)`: yellow, `private(2)`: green, `highlight(3)`: magenta bold

**Other styles**:
- Read marker: `────────────` dim horizontal line
- Highlight: yellow bold (own nick in message)
- Inactive buffer: dimmed timestamp, nick, message
- Scroll indicators: `▲ more` / `▼ more`

**Done**: `nickColor('alice') === nickColor('alice')` always, all prefixes render with correct colors

### 1.4 Layout Engine
`src/client/layout.ts`

Custom ANSI renderer: `process.stdout.write()` + `ansi-escapes` cursor positioning + `string-width` for CJK width + `cli-cursor` hide/show. Alternate screen buffer (`\x1b[?1049h`). SIGWINCH resize handler.

```
┌──────────┬────────────────────────────────────┬──────────┐
│ buflist   │ titlebar                           │          │
│ col:0     │ col:20, row:0, h:1                 │          │
│ row:1     ├────────────────────────────────────┤ nicklist │
│ w:20      │ chat                               │ col:C-16 │
│ h:R-3     │ col:20, row:1, w:C-36, h:R-3      │ row:1    │
│           │                                    │ w:16     │
│           │                                    │ h:R-3    │
├───────────┴────────────────────────────────────┴──────────┤
│ statusbar  col:0, row:R-2, w:C, h:1                      │
├───────────────────────────────────────────────────────────┤
│ input      col:0, row:R-1, w:C, h:1                      │
└───────────────────────────────────────────────────────────┘
C = columns, R = rows
```

`Region` class: `{x, y, w, h}` → `writeLine(row, text)`, `clear()`, `drawBorder()`. Each `writeLine` truncates/pads via `string-width` to prevent cross-region bleed. Min terminal: 80x24.

**Done**: resize recalculates all regions, Korean text aligns, no bleed between regions

### 1.5 Widgets

**buflist** `src/client/widgets/buflist.ts`:
- Format: `1. #general (3,15,1)` — buffer number, name, hotlist counters
- Counter colors per priority level
- Active buffer: inverted. Unread: colored by highest priority.
- `▲`/`▼` scroll overflow indicators

**chat** `src/client/widgets/chat.ts`:
- Virtual scroll buffer (line array, rendered window)
- Message formatting by type:
  - `[HH:MM]    <alice> │ hello world` — normal, nick right-aligned
  - `[HH:MM]       --> │ alice has joined #general` — join, green
  - `[HH:MM]       <-- │ bob has left #general` — part, red
  - `[HH:MM]         * │ alice shrugs` — action, white
  - `[HH:MM]        -- │ server connected` — network, magenta
  - `[HH:MM]       =!= │ connection failed` — error, red
- Same-minute time elision (blank timestamp)
- Date change line: `── 2026-03-26 (Thu) ──`
- Read marker: `────────────` at last-read position
- @mention highlight: yellow bold on own nick
- Inactive buffer dimming: non-focused buffer messages rendered dim
- `▲ more` / `▼ more` overflow indicators
- Auto-scroll (disabled on scroll-up, re-enabled at bottom)

**nicklist** `src/client/widgets/nicklist.ts`:
- Group-based sorting (ref: `gui-nicklist.c`):
  - Groups: `coding` > `online` > `dnd` > `offline`
  - Header: `-- coding (2) --`
  - Alphabetical within each group
- Nick color = same hash as chat nick color
- Offline nicks dimmed

**input** `src/client/widgets/input.ts`:
- `process.stdin` raw mode, cursor tracking via `string-width`
- Tab completion (ref: `core-completion.c`):
  - Nick: partial prefix + Tab → cycle matches. Multiple → complete common prefix, show candidates.
  - Channel: `#` + Tab
  - Command: `/` + Tab
- History (ref: `core-command.c`):
  - Per-buffer + global (Ctrl+Up/Down to switch)
  - Duplicate prevention, max 100/buffer
  - `Ctrl+R`: incremental reverse search (show search prompt inline)
- Readline: Ctrl+A/E/W/K/U, Home/End, arrow keys

**statusbar** `src/client/widgets/statusbar.ts`:
- Inverted bg: `[nick] │ [status] │ [channel] │ [lag: Xms]`

**titlebar** `src/client/widgets/titlebar.ts`:
- Inverted bg: `#channel — topic text`

**Done**: all widgets render with dummy data, Korean aligns, prefix/hotlist/read-marker all visible

### 1.6 Keybindings
`src/client/keybindings.ts`

Raw stdin → parse ANSI escape sequences.

| Key | Action |
|-----|--------|
| `Alt+1-9` | Switch buffer 1-9 |
| `Alt+J` + 2 digits | Switch buffer 10+ |
| `Alt+←/→` | Prev/next buffer |
| `PageUp/Down` | Chat scroll |
| `Alt+m` | Toggle mouse (`\x1b[?1000h;\x1b[?1006h` SGR extended) |
| `Alt+L` | Bare display (plain text mode) |
| `Ctrl+C/D` | Quit with confirmation ("Really quit CCC? y/N") |
| `Tab` | Complete nick/channel/command |
| `Ctrl+R` | History search |
| `Up/Down` | Input history |
| `Ctrl+Up/Down` | Global history |

Mouse (SGR mode `\x1b[<btn;col;row;M/m`):
- Buflist click → switch buffer
- Nicklist click → identify user (DM later)
- Chat scroll wheel → scroll messages
- Chat click → identify line (URL click later)

**Done**: all bindings work, buffer switch updates chat/nicklist/titlebar

### 1.7 Commands
`src/client/commands.ts`

Parse `/` prefix → dispatch. Unknown → error prefix.

| Command | Action |
|---------|--------|
| `/join #channel` | Join channel |
| `/part [msg]` | Leave current channel |
| `/msg nick text` | Send DM |
| `/nick newnick` | Change nick |
| `/dnd` | Toggle DND |
| `/me action` | Action message |
| `/help` | Show command list (network prefix) |
| `/clear` | Clear chat buffer |
| `/quit` | Quit with confirmation |

**Done**: `/help` renders command list via `--` network prefix

### 1.8 App Entry
`src/client/app.ts`

- Create layout, init all widgets
- 3 dummy channels (#general, #dev, #help) with dummy messages
- Input submit: `/command` → handler, text → local echo to chat
- Register keybindings, graceful shutdown (restore terminal on exit)

**Done**: `bun run bin/ccc.ts` renders WeeChat TUI, local echo works

### Phase 1 Verification

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Launch 80x24 | 6 regions visible, borders correct |
| 2 | Resize 200x50 | Proportional rescale, no bleed |
| 3 | Alt+1/2/3 | Buffer switch updates titlebar/chat/nicklist |
| 4 | Type + Enter | `[HH:MM] <nick> │ text` with aligned nick |
| 5 | Join/part msgs | `-->` green, `<--` red, correct prefix |
| 6 | Korean text 한글 | Correct column width, no region overflow |
| 7 | Same-minute msgs | Timestamp blanked on 2nd+ |
| 8 | Date change sim | `── 2026-03-26 (Thu) ──` centered |
| 9 | Scroll up | `▲ more`, auto-scroll off |
| 10 | Scroll to bottom | Auto-scroll on, read marker visible |
| 11 | Buflist hotlist | `#dev (3,1)` with colored counters |
| 12 | Nicklist groups | Grouped by presence, alphabetical within |
| 13 | `s` + Tab | Nick completion cycles, shows candidates |
| 14 | `/j` + Tab | Completes to `/join` |
| 15 | Up/Down | Per-buffer history, no dupes |
| 16 | Ctrl+R | Inline search prompt, filters history |
| 17 | Mouse buflist click | Switches buffer |
| 18 | Mouse scroll | Chat scrolls |
| 19 | Ctrl+C | "Really quit? (y/N)" prompt |
| 20 | `/help` | Command list via `--` prefix |

**Output**: ~950 lines. Complete offline WeeChat TUI shell.

---

## Phase 2: Networking — "Two Terminals Talk"

**Goal**: WebSocket server + SSH auth + SQLite persistence + real-time chat. Two terminals exchange messages. Server restart preserves history.

### 2.1 SSH Key Auth
`src/shared/crypto.ts` + `src/server/auth.ts`

- `loadOrGenerateKey()`: load `~/.ssh/ccc_ed25519` or generate via `ssh-keygen -t ed25519`
- `signChallenge(challenge, privateKeyPath)`: `crypto.sign` ed25519
- Server challenge-response: open → server sends 32-byte random → client signs → server verifies publicKey + signature
- Authenticated connections tracked in `Map<WebSocket, User>`

**Done**: valid key authenticates, bad signature rejected

### 2.2 WebSocket Server
`src/server/index.ts`

- `Bun.serve()` with WebSocket upgrade
- Lifecycle: open → challenge → auth → message routing
- Heartbeat: ping 30s, drop after 60s no pong
- Health check: `GET /health` → 200
- Env: `CCC_PORT` (3337), `CCC_HOST` (0.0.0.0), `CCC_DB_PATH` (`~/.config/ccc/server.db`)

**Done**: server starts, accepts connections, handles auth

### 2.3 Channel & DM Router
`src/server/channels.ts`

- `ChannelManager`: auto-create #general/#dev/#help
- `join(user, channel)` → add member, broadcast join msg, send history
- `part(user, channel)` → remove member, broadcast part msg
- `broadcast(channel, message)` → all members
- `dm(from, to, message)` → direct
- New user auto-joins #general

**Done**: join/part/broadcast/DM routing correct

### 2.4 SQLite Message Store
`src/server/store.ts`

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_nick TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX idx_messages_channel_ts ON messages(channel, timestamp);

CREATE TABLE users (
  public_key TEXT PRIMARY KEY,
  nick TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE channel_members (
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel, user_id)
);
```

- `bun:sqlite` — zero dependencies, built into Bun
- `PRAGMA journal_mode=WAL` for concurrent reads
- `getHistory(channel, limit=50)`, `addMessage(channel, msg)`
- `getNick(publicKey)` / `setNick(publicKey, nick)` — nick persistence across reconnects
- Auto-prune: messages beyond 10,000/channel deleted on write
- `--no-persist` flag → in-memory SQLite (`:memory:`)

**Done**: send messages, restart server, history loads correctly, nicks persist

### 2.5 Client Connection
`src/client/connection.ts`

- `Connection` class: `connect(url)` with auto-auth, `send(msg)`, typed `on(type, cb)` handlers
- Auto-reconnect: exponential backoff 1s → 2s → 4s → 8s → 16s (cap)
- Connection state → statusbar: `Connecting...` / `Connected` / `Disconnected (retrying 4s...)`
- Default URL: `wss://ccc.fly.dev` (override: `CCC_SERVER` env or config)

**Done**: connects, authenticates, sends/receives, auto-reconnects

### 2.6 Wire UI to Server
Modify `src/client/app.ts`

- Replace local echo with server roundtrip
- Incoming chat → `chat.appendMessage()` with correct prefix type
- Join/part events → nicklist + chat update
- Members event → full nicklist refresh
- History event → populate chat on channel switch
- @mention detection → highlight + buflist hotlist priority 3
- DM → create buffer, hotlist priority 2

**Done**: two terminals run `ccc`, send messages to each other in real-time

### Phase 2 Verification

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Start server | Binds port, logs ready, SQLite DB created |
| 2 | Client A connects | Statusbar "Connected", auto-joined #general |
| 3 | Client B connects | Both nicklists show 2 users |
| 4 | A sends message | Appears on B with correct prefix/alignment |
| 5 | B `/join #dev` | A sees `<-- B has left`, B sees #dev |
| 6 | A `/msg B hello` | DM buffer created on B, hotlist priority 2 |
| 7 | Kill server | Clients show "Disconnected", auto-retry |
| 8 | Restart server | Clients reconnect + re-auth, **history preserved** |
| 9 | B sends `@A hi` | A sees yellow highlight, buflist priority 3 |
| 10 | Bad SSH key | Auth rejected, connection closed |
| 11 | A disconnects, reconnects | Same nick restored from SQLite |

**Output**: ~570 lines (cumulative ~1,520). Multi-user real-time chat with persistent history.

---

## Phase 3: Presence & Polish — "Who's Coding What"

**Goal**: CC session-linked presence, rich presence, nick management, code blocks, onboarding.

### 3.1 CC Session Detection
`src/cc-integration/presence.ts`

- Poll `~/.claude/sessions/` every 5s
- Read `{PID}.json`: `{pid, sessionId, cwd, startedAt, kind}`
- Verify PID alive: `process.kill(pid, 0)`
- Extract project name from `cwd` (last path segment)
- Infer language: `package.json` → TS/JS, `Cargo.toml` → Rust, `go.mod` → Go, `pyproject.toml` → Python
- `PresenceWatcher` EventEmitter: `change` event

**Done**: CC session start/stop triggers presence change

### 3.2 Server Presence Tracking
`src/server/presence.ts`

- `PresenceManager`: `Map<userId, {status, richPresence, lastSeen}>`
- Broadcast presence updates to all shared channels
- 30s grace period before marking offline on disconnect
- DND mode: server-side @mention notification suppression

**Done**: nicklist shows correct presence icons, real-time updates

### 3.3 Client Presence Integration
Modify `src/client/app.ts`, `src/client/widgets/nicklist.ts`

- Start `PresenceWatcher`, send `presence` messages on change
- Icons: `🟢` online, `⚡` coding, `💬` reviewing, `🔴` DND, `⚫` offline
- ASCII fallback option: `O`, `C`, `R`, `D`, `X`
- Click nick → popup with rich presence (project, language, duration)
- `/dnd` toggles DND

**Done**: coding in CC → `⚡ coding`, close CC → `🟢 online`

### 3.4 Nick Management
Modify `src/server/auth.ts`, `src/server/index.ts`

- First connect: nick = `user_` + fingerprint[:8]. Persisted in SQLite.
- Returning user: nick restored from `users` table.
- `/nick newnick`: uniqueness check, broadcast system message, SQLite update.

**Done**: nick change reflected everywhere instantly, persists across reconnects

### 3.5 Code Block Rendering
Modify `src/client/widgets/chat.ts`

- Detect ``` fenced blocks
- Render with box-drawing border + distinct background via chalk
- Basic keyword coloring: strings → green, keywords → cyan, comments → gray
- Inline `` code `` with background highlight

**Done**: code blocks visually distinct

### 3.6 First-Run Onboarding
`src/client/onboarding.ts`

- Detect: `~/.config/ccc/config.json` missing
- Flow: welcome → SSH key check/generate → nickname → confirm server → save config
- Subsequent runs: load config directly

**Done**: first run shows onboarding, second run straight to chat

### Phase 3 Verification

| # | Scenario | Expected |
|---|----------|----------|
| 1 | CC session active | Own presence `⚡ coding` |
| 2 | Close CC | Changes to `🟢 online` |
| 3 | `/dnd` | `🔴 DND`, @mentions suppressed |
| 4 | `/nick mynick` | System message all channels, persists on reconnect |
| 5 | Send ``` block | Boxed + colored rendering |
| 6 | Delete config, relaunch | Onboarding flow |
| 7 | Rich presence popup | `⚡ ProjectName · TypeScript · 24min` |
| 8 | Regression | All P1-P2 features intact |

**Output**: ~280 lines (cumulative ~1,800). Full-featured chat with rich presence.

---

## Phase 4: Ship — "npm i -g cc-chat && ccc"

**Goal**: Error handling, tests, npm publish, public server. Zero-config install to chatting in 30 seconds.

### 4.1 Error Handling & Resilience
- try-catch all WebSocket message handlers
- Server: malformed JSON → error response, keep connection
- Client: server errors → red `=!=` prefix in chat
- Filesystem errors (SSH key, sessions) → graceful fallback
- Auth timeout: 5s limit

**Done**: malformed messages don't crash anything

### 4.2 Tests
`tests/` — `bun test`

- `protocol.test.ts`: WSMessage serialization roundtrip
- `auth.test.ts`: challenge-response pass/fail
- `store.test.ts`: SQLite insert, history, retention prune, nick persist
- `theme.test.ts`: nickColor consistency, prefix definitions

**Done**: `bun test` all pass

### 4.3 CLI & npm Publish
- `bin/ccc.ts`: `ccc` (client), `ccc server` (self-host), `--help`, `--version`
- Env: `CCC_SERVER`, `CCC_PORT`, `CCC_NICK`
- `package.json`:
  ```json
  { "name": "cc-chat", "bin": {"ccc": "./bin/ccc.ts"},
    "files": ["bin/","src/","package.json","tsconfig.json"],
    "keywords": ["claude-code","chat","tui","terminal","messenger","weechat"] }
  ```
- Pre-publish: `npm pack --dry-run`, verify size, test global install
- `npm publish`

**Done**: `npm i -g cc-chat && ccc` works from scratch

### 4.4 Public Server
- **fly.io**: `fly.toml` + `Dockerfile` (Bun)
- Endpoint: `wss://ccc.fly.dev` (client default)
- Persistent volume at `/data` for SQLite DB
- Health: `GET /health` → 200
- Fallback: Cloudflare Tunnel from Mac mini if cost concern

```toml
[build]
  dockerfile = "Dockerfile"
[[services]]
  internal_port = 3337
  protocol = "tcp"
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
[mounts]
  source = "ccc_data"
  destination = "/data"
```

**Done**: `ccc` connects to `wss://ccc.fly.dev` out of the box, history persists across deploys

### 4.5 Documentation
- `README.md`: quick start, keybindings table, commands table, self-hosting guide, architecture ASCII diagram

**Done**: new user can install → chat from README alone

### Phase 4 Verification

| # | Scenario | Expected |
|---|----------|----------|
| 1 | `bun test` | All pass |
| 2 | `npm i -g cc-chat && ccc` fresh | Onboarding → connects to public server |
| 3 | 3+ clients on public server | Messages route correctly |
| 4 | 10min+ connection | No memory leak, heartbeat stable |
| 5 | fly.io redeploy | Clients reconnect, history preserved |
| 6 | 100 rapid messages | No UI lag |
| 7 | `ccc server` self-hosted | Works with `CCC_SERVER=ws://localhost:3337` |
| 8 | Full regression | All P1-P3 pass |

**Output**: ~250 lines (cumulative ~2,050). Published, publicly accessible.

---

## Risk Mitigation

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Custom ANSI engine complexity | Medium | Keep `Region` thin (~150 lines); reference terminal-kit for edge cases |
| Emoji width across terminals | Medium | `string-width` + ASCII icon fallback option |
| SSH key compatibility | Medium | ed25519 only; auto-generate `~/.ssh/ccc_ed25519` if missing |
| Raw stdin parsing variants | Medium | Test iTerm2, Terminal.app, Alacritty; handle common escape variants |
| npm `ccc` name taken | Low | Package = `cc-chat`, binary = `ccc` (no conflict) |
| fly.io free tier limits | Low | Monitor; fallback to Cloudflare Tunnel |
| SQLite WAL on network volume | Low | fly.io persistent volume is local SSD, not NFS |

## Schedule Risk — What to Cut

1. **First**: code block syntax highlighting (keep box border only)
2. **Second**: onboarding flow (manual config)
3. **Third**: rich presence language/file inference (simplify to online/offline)
4. **Never cut**: SSH auth, channels/DM, WeeChat prefix system, SQLite persistence, public server

---

## File Map

```
cc-chat/
├── package.json                        # name: "cc-chat", bin: "ccc"
├── tsconfig.json
├── fly.toml                            # fly.io deployment
├── Dockerfile                          # Bun server image
├── bin/
│   └── ccc.ts                          # CLI entry
├── src/
│   ├── shared/
│   │   ├── types.ts                    # Core types + WeeChat semantics
│   │   ├── protocol.ts                 # WSMessage discriminated union
│   │   └── crypto.ts                   # SSH key load/generate/sign
│   ├── client/
│   │   ├── app.ts                      # Main orchestrator
│   │   ├── layout.ts                   # ANSI 6-region engine
│   │   ├── theme.ts                    # Prefix system, colors, styles
│   │   ├── keybindings.ts              # Keyboard + mouse handler
│   │   ├── commands.ts                 # /slash commands
│   │   ├── connection.ts               # WebSocket + auto-reconnect
│   │   ├── onboarding.ts              # First-run flow
│   │   └── widgets/
│   │       ├── buflist.ts              # Hotlist counters, priorities
│   │       ├── chat.ts                 # Prefix, alignment, markers
│   │       ├── nicklist.ts             # Group sorting, presence
│   │       ├── input.ts               # Tab completion, history, Ctrl+R
│   │       ├── statusbar.ts
│   │       └── titlebar.ts
│   ├── server/
│   │   ├── index.ts                    # Bun.serve WebSocket
│   │   ├── auth.ts                     # SSH challenge-response
│   │   ├── channels.ts                 # Channel/DM routing
│   │   ├── store.ts                    # SQLite (bun:sqlite)
│   │   └── presence.ts                 # Presence tracking
│   └── cc-integration/
│       └── presence.ts                 # CC session file polling
└── tests/
    ├── protocol.test.ts
    ├── auth.test.ts
    ├── store.test.ts
    └── theme.test.ts
```
