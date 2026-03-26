// Main app orchestrator — connects layout, widgets, keybindings, commands, server

import cliCursor from "cli-cursor";
import chalk from "chalk";
import {
  createLayout,
  enterScreen,
  exitScreen,
  isTooSmall,
  type Layout,
} from "./layout.ts";
import { renderTitlebar } from "./widgets/titlebar.ts";
import { renderStatusbar } from "./widgets/statusbar.ts";
import {
  renderBuflist,
  adjustBuflistScroll,
  type BuflistEntry,
} from "./widgets/buflist.ts";
import { renderChat, isAtBottom, renderCCSessionPlaceholder } from "./widgets/chat.ts";
import stringWidth from "string-width";
import { renderNicklist, renderCCSessionMeta } from "./widgets/nicklist.ts";
import {
  renderInput,
  createHistory,
  historyAdd,
  historyPrev,
  historyNext,
  tabComplete,
  applyCompletion,
  insertChar,
  deleteBack,
  deleteForward,
  moveCursorLeft,
  moveCursorRight,
  moveCursorHome,
  moveCursorEnd,
  deleteWordBack,
  deleteToEnd,
  deleteToStart,
  clearInput,
  type InputState,
  type History,
  type CompletionContext,
} from "./widgets/input.ts";
import {
  parseInput,
  enableMouse,
  disableMouse,
  identifyRegion,
  type Action,
} from "./keybindings.ts";
import { handleCommand, COMMANDS } from "./commands.ts";
import {
  createConnection,
  type Connection,
  type ConnectionStatus,
} from "./connection.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import type {
  Channel,
  Message,
  User,
  BufferType,
  CCSession,
} from "../shared/types.ts";
import { emptyHotlist } from "../shared/types.ts";
import { createPresenceWatcher, type DetectedSession } from "../cc-integration/presence.ts";
import type { ChatState } from "./widgets/chat.ts";

// --- App state ---

interface BufferState {
  channel: Channel;
  messages: Message[];
  chatScroll: number;
  readMarkerIndex: number;
  history: History;
  bufferType: BufferType;
  cachedNickWidth: number; // cached to avoid recomputation
  ccSession?: CCSession;
}

interface AppState {
  buffers: BufferState[];
  activeIndex: number;
  selfNick: string;
  selfId: string;
  users: User[];
  mouseEnabled: boolean;
  quitting: boolean;
  inputState: InputState;
  completionCtx: CompletionContext | null;
  connectionStatus: ConnectionStatus;
  connection: Connection | null;
  historySearchMode: boolean;
  historySearchQuery: string;
  selfDnd: boolean; // suppress @mention highlights when in DND
  globalHistory: History; // cross-buffer history for Ctrl+Up/Down
  altJPending: boolean; // waiting for 2-digit buffer number after Alt+J
  altJFirstDigit: string; // first digit captured
  bareMode: boolean; // Alt+L: strip colors for bare display
}

function createInitialBuffers(): BufferState[] {
  return [
    {
      channel: {
        name: "#general",
        topic: "General chat",
        members: [],
        hotlist: emptyHotlist(),
      },
      messages: [],
      chatScroll: 0,
      readMarkerIndex: -1,
      history: createHistory(),
      bufferType: "channel",
      cachedNickWidth: 4,
    },
  ];
}

/** Sync CC session buffers with detected sessions from PresenceWatcher. */
function syncCCSessionBuffers(state: AppState, sessions: DetectedSession[]) {
  // Remove CC session buffers that are no longer active
  const activeIds = new Set(sessions.map((s) => s.sessionId));
  for (let i = state.buffers.length - 1; i >= 0; i--) {
    const buf = state.buffers[i]!;
    if (buf.bufferType === "cc_session" && buf.ccSession && !activeIds.has(buf.ccSession.id)) {
      // Adjust activeIndex if needed
      if (state.activeIndex > i) state.activeIndex--;
      else if (state.activeIndex === i) state.activeIndex = Math.max(0, i - 1);
      state.buffers.splice(i, 1);
    }
  }

  // Add new CC session buffers
  for (const session of sessions) {
    const exists = state.buffers.some(
      (b) => b.bufferType === "cc_session" && b.ccSession?.id === session.sessionId,
    );
    if (!exists) {
      const ccSession: CCSession = {
        id: session.sessionId,
        project: session.project,
        language: session.language,
        cwd: session.cwd,
        startedAt: session.startedAt,
        active: true,
      };
      state.buffers.push({
        channel: {
          name: `⚡${session.project}`,
          topic: `CC Session — ${session.cwd}`,
          members: [],
          hotlist: emptyHotlist(),
        },
        messages: [],
        chatScroll: 0,
        readMarkerIndex: -1,
        history: createHistory(),
        bufferType: "cc_session",
        cachedNickWidth: 4,
        ccSession,
      });
    }
  }
}

// --- Buffer helpers ---

function findBufferByChannel(state: AppState, channel: string): number {
  return state.buffers.findIndex((b) => b.channel.name === channel);
}

function getOrCreateBuffer(state: AppState, channel: string, topic = ""): number {
  let idx = findBufferByChannel(state, channel);
  if (idx >= 0) return idx;

  // Determine buffer type
  const bufferType: BufferType = channel.startsWith("dm:") ? "dm" : "channel";

  // Insert before CC session buffers, or at end if none exist
  const ccIdx = state.buffers.findIndex((b) => b.bufferType === "cc_session");
  const insertIdx = ccIdx >= 0 ? ccIdx : state.buffers.length;
  state.buffers.splice(
    insertIdx,
    0,
    {
      channel: {
        name: channel,
        topic,
        members: [],
        hotlist: emptyHotlist(),
      },
      messages: [],
      chatScroll: 0,
      readMarkerIndex: -1,
      history: createHistory(),
      bufferType,
      cachedNickWidth: 4,
    },
  );

  // Recalculate index since we inserted before CC buffers
  return findBufferByChannel(state, channel);
}

/** Push a message and update the cached nick width. */
function pushMessage(buf: BufferState, msg: Message) {
  buf.messages.push(msg);
  if (msg.type === "chat" || msg.type === "action") {
    const w = stringWidth(msg.fromNick);
    if (w > buf.cachedNickWidth && w <= 16) {
      buf.cachedNickWidth = w;
    }
  }
}

function buildBuflistEntries(buffers: BufferState[]): BuflistEntry[] {
  return buffers.map((buf, i) => ({
    name: buf.channel.name,
    bufferType: buf.bufferType,
    channel: buf.channel,
    globalIndex: i,
  }));
}

// --- Server message handling ---

function handleServerMessage(
  msg: ServerMessage,
  state: AppState,
  layout: Layout,
) {
  switch (msg.type) {
    case "auth_ok": {
      state.selfNick = msg.user.nick;
      state.selfId = msg.user.id;
      state.inputState.prompt = `[${state.buffers[state.activeIndex]!.channel.name}] `;
      break;
    }

    case "auth_fail": {
      const idx = findBufferByChannel(state, "#general");
      if (idx >= 0) {
        state.buffers[idx]!.messages.push({
          id: crypto.randomUUID(),
          from: "",
          fromNick: "",
          channel: "#general",
          content: `Authentication failed: ${msg.reason}`,
          timestamp: Date.now(),
          type: "error",
        });
      }
      break;
    }

    case "chat": {
      const chatMsg = msg.message;
      const idx = getOrCreateBuffer(state, chatMsg.channel);
      pushMessage(state.buffers[idx]!, chatMsg);

      // Hotlist if not active buffer
      if (idx !== state.activeIndex) {
        const h = state.buffers[idx]!.channel.hotlist;
        // Check for @mention (suppressed in DND mode)
        if (!state.selfDnd && chatMsg.content.includes(`@${state.selfNick}`)) {
          h.highlight++;
        } else if (chatMsg.channel.startsWith("dm:")) {
          h.private++;
        } else {
          h.message++;
        }
      }
      break;
    }

    case "join": {
      const idx = getOrCreateBuffer(state, msg.channel);
      const joinBuf = state.buffers[idx]!;
      // Add join message
      joinBuf.messages.push({
        id: crypto.randomUUID(),
        from: msg.user.id,
        fromNick: msg.user.nick,
        channel: msg.channel,
        content: msg.channel,
        timestamp: Date.now(),
        type: "join",
      });

      // Add to channel members
      if (!joinBuf.channel.members.includes(msg.user.id)) {
        joinBuf.channel.members.push(msg.user.id);
      }

      // Update user list
      if (!state.users.find((u) => u.id === msg.user.id)) {
        state.users.push(msg.user);
      }
      break;
    }

    case "part": {
      const idx = findBufferByChannel(state, msg.channel);
      if (idx >= 0) {
        state.buffers[idx]!.messages.push({
          id: crypto.randomUUID(),
          from: msg.userId,
          fromNick: msg.nick,
          channel: msg.channel,
          content: msg.message ?? msg.channel,
          timestamp: Date.now(),
          type: "part",
        });
      }
      // Remove user from channel members list
      const buf23 = state.buffers[idx >= 0 ? idx : 0];
      if (buf23) {
        buf23.channel.members = buf23.channel.members.filter((id) => id !== msg.userId);
      }
      // Only remove from users if not in any other buffer
      const stillInSomeBuffer = state.buffers.some(
        (b) => b.channel.members.includes(msg.userId),
      );
      if (!stillInSomeBuffer) {
        state.users = state.users.filter((u) => u.id !== msg.userId);
      }
      break;
    }

    case "members": {
      const idx = getOrCreateBuffer(state, msg.channel);
      state.buffers[idx]!.channel.members = msg.members.map((m) => m.id);

      // Merge members into users list
      for (const member of msg.members) {
        const existing = state.users.find((u) => u.id === member.id);
        if (existing) {
          Object.assign(existing, member);
        } else {
          state.users.push(member);
        }
      }
      break;
    }

    case "history": {
      const idx = getOrCreateBuffer(state, msg.channel);
      const histBuf = state.buffers[idx]!;
      histBuf.messages = [...msg.messages, ...histBuf.messages];
      // Recompute nick width from history
      for (const m of msg.messages) {
        if (m.type === "chat" || m.type === "action") {
          const w = stringWidth(m.fromNick);
          if (w > histBuf.cachedNickWidth && w <= 16) histBuf.cachedNickWidth = w;
        }
      }
      break;
    }

    case "nick_change": {
      // Update in users list
      const user = state.users.find((u) => u.id === msg.userId);
      if (user) user.nick = msg.newNick;

      // If it's us, update selfNick
      if (msg.userId === state.selfId) {
        state.selfNick = msg.newNick;
      }

      // Add system message to all channel buffers
      for (const buf of state.buffers) {
        if (buf.bufferType === "channel") {
          buf.messages.push({
            id: crypto.randomUUID(),
            from: msg.userId,
            fromNick: msg.oldNick,
            channel: buf.channel.name,
            content: `${msg.oldNick} is now known as ${msg.newNick}`,
            timestamp: Date.now(),
            type: "network",
          });
        }
      }
      break;
    }

    case "presence_update": {
      const user = state.users.find((u) => u.id === msg.userId);
      if (user) {
        user.presence = msg.status;
        if (msg.rich) user.richPresence = msg.rich;
      }
      break;
    }

    case "error": {
      // Show error in current buffer
      const buf = state.buffers[state.activeIndex]!;
      buf.messages.push({
        id: crypto.randomUUID(),
        from: "",
        fromNick: "",
        channel: buf.channel.name,
        content: `${msg.code}: ${msg.message}`,
        timestamp: Date.now(),
        type: "error",
      });
      break;
    }
  }

  renderAll(layout, state);
}

// --- Rendering ---

function renderAll(layout: Layout, state: AppState) {
  const buf = state.buffers[state.activeIndex]!;
  const isCC = buf.bufferType === "cc_session";

  renderTitlebar(layout.titlebar, {
    channel: buf.channel.name,
    topic: buf.channel.topic,
  });

  const statusText =
    state.connectionStatus === "connected"
      ? "Connected"
      : state.connectionStatus === "connecting"
        ? "Connecting..."
        : "Disconnected";

  renderStatusbar(layout.statusbar, {
    nick: state.selfNick,
    status: isCC ? "CC Session" : statusText,
    channel: buf.channel.name,
  });

  const entries = buildBuflistEntries(state.buffers);
  const buflistScroll = adjustBuflistScroll(
    entries, state.activeIndex, 0, layout.buflist.h,
  );
  renderBuflist(layout.buflist, {
    entries, activeIndex: state.activeIndex, scrollOffset: buflistScroll,
  });

  if (isCC && buf.ccSession) {
    renderCCSessionPlaceholder(layout.chat, buf.ccSession);
  } else {
    const chatState: ChatState = {
      messages: buf.messages,
      selfNick: state.selfNick,
      nickWidth: buf.cachedNickWidth,
      scrollOffset: buf.chatScroll,
      readMarkerIndex: buf.readMarkerIndex,
      isActive: true,
    };
    renderChat(layout.chat, chatState);
  }

  if (isCC && buf.ccSession) {
    renderCCSessionMeta(layout.nicklist, buf.ccSession);
  } else {
    renderNicklist(layout.nicklist, { users: state.users, scrollOffset: 0 });
  }

  layout.render();
  renderInput(layout.input, state.inputState);
  cliCursor.show();
}

// --- Main ---

export function startApp() {
  const state: AppState = {
    buffers: createInitialBuffers(),
    activeIndex: 0,
    selfNick: process.env["CCC_NICK"] ?? "me",
    selfId: "",
    users: [],
    mouseEnabled: false,
    quitting: false,
    inputState: { text: "", cursor: 0, prompt: "[#general] " },
    completionCtx: null,
    connectionStatus: "disconnected",
    connection: null,
    historySearchMode: false,
    historySearchQuery: "",
    selfDnd: false,
    globalHistory: createHistory(),
    altJPending: false,
    altJFirstDigit: "",
    bareMode: false,
  };

  if (!process.stdin.isTTY) {
    console.error("ccc requires an interactive terminal (TTY). Run it directly, not piped.");
    process.exit(1);
  }

  if (isTooSmall()) {
    console.error("Terminal too small. Minimum 80x24 required.");
    process.exit(1);
  }

  enterScreen();
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const layout = createLayout();
  renderAll(layout, state);

  // Connect to server
  const conn = createConnection({
    onMessage(msg: ServerMessage) {
      handleServerMessage(msg, state, layout);
    },
    onStatusChange(status: ConnectionStatus, detail?: string) {
      state.connectionStatus = status;
      if (status === "disconnected" && detail) {
        // Show disconnect info in current buffer
        const buf = state.buffers[state.activeIndex]!;
        buf.messages.push({
          id: crypto.randomUUID(),
          from: "", fromNick: "",
          channel: buf.channel.name,
          content: `Disconnected (${detail})`,
          timestamp: Date.now(),
          type: "network",
        });
      }
      renderAll(layout, state);
    },
  });
  state.connection = conn;

  // Start CC session presence watcher — only send after auth
  const presenceWatcher = createPresenceWatcher();
  presenceWatcher.onChange((status, rich, sessions) => {
    if (state.connectionStatus === "connected") {
      conn.send({ type: "presence", status, rich });
    }
    // Dynamically update CC session buffers
    if (sessions) {
      syncCCSessionBuffers(state, sessions);
    }
    renderAll(layout, state);
  });
  presenceWatcher.start();

  // Cleanup on exit — guard against double invocation
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    presenceWatcher.stop();
    conn.close();
    if (state.mouseEnabled) disableMouse();
    process.stdin.setRawMode(false);
    exitScreen();
  }

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("uncaughtException", (err) => {
    cleanup();
    console.error("Uncaught exception:", err);
    process.exit(1);
  });

  // Resize
  process.stdout.on("resize", () => {
    if (isTooSmall()) {
      // Don't render — just show warning in alternate screen
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write("Terminal too small. Minimum 80x24 required.\r\n");
      return;
    }
    layout.recalculate();
    process.stdout.write("\x1b[2J");
    renderAll(layout, state);
  });

  // Input loop
  process.stdin.on("data", (data: Buffer) => {
    const actions = parseInput(data);
    for (const action of actions) {
      handleAction(action, layout, state);
    }
    renderAll(layout, state);
  });
}

function switchBuffer(state: AppState, index: number) {
  if (index < 0 || index >= state.buffers.length) return;
  const curBuf = state.buffers[state.activeIndex]!;
  if (curBuf.messages.length > 0) {
    curBuf.readMarkerIndex = curBuf.messages.length - 1;
  }
  state.activeIndex = index;
  state.buffers[index]!.channel.hotlist = emptyHotlist();
  state.inputState.prompt = `[${state.buffers[index]!.channel.name}] `;
  state.completionCtx = null;
}

function handleAction(action: Action, layout: Layout, state: AppState) {
  const buf = state.buffers[state.activeIndex]!;
  const isCC = buf.bufferType === "cc_session";
  const conn = state.connection;

  // Alt+J two-digit buffer select mode
  if (state.altJPending) {
    if (action.type === "char" && action.ch >= "0" && action.ch <= "9") {
      if (state.altJFirstDigit === "") {
        state.altJFirstDigit = action.ch;
        state.inputState.prompt = `[Alt+J] ${action.ch}_: `;
        return;
      } else {
        const bufNum = parseInt(state.altJFirstDigit + action.ch, 10);
        state.altJPending = false;
        state.altJFirstDigit = "";
        state.inputState.prompt = `[${buf.channel.name}] `;
        switchBuffer(state, bufNum - 1);
        return;
      }
    }
    // Any non-digit cancels
    state.altJPending = false;
    state.altJFirstDigit = "";
    state.inputState.prompt = `[${buf.channel.name}] `;
  }

  // Quit confirmation mode
  if (state.quitting) {
    if (action.type === "char" && (action.ch === "y" || action.ch === "Y")) {
      conn?.close();
      disableMouse();
      process.stdin.setRawMode(false);
      exitScreen();
      process.exit(0);
    }
    state.quitting = false;
    return;
  }

  // Ctrl+R history search mode
  if (state.historySearchMode) {
    if (action.type === "char") {
      state.historySearchQuery += action.ch;
      const match = buf.history.entries.find((e) =>
        e.toLowerCase().includes(state.historySearchQuery.toLowerCase()),
      );
      if (match) {
        state.inputState = { ...state.inputState, text: match, cursor: match.length };
      }
      state.inputState.prompt = `(search) '${state.historySearchQuery}': `;
      return;
    } else if (action.type === "backspace") {
      state.historySearchQuery = state.historySearchQuery.slice(0, -1);
      state.inputState.prompt = `(search) '${state.historySearchQuery}': `;
      return;
    } else if (action.type === "enter" || action.type === "ctrl_r") {
      // Accept or cycle
      state.historySearchMode = false;
      state.inputState.prompt = `[${buf.channel.name}] `;
      return;
    } else {
      // Any other key exits search
      state.historySearchMode = false;
      state.inputState.prompt = `[${buf.channel.name}] `;
    }
  }

  if (action.type !== "tab") {
    state.completionCtx = null;
  }

  switch (action.type) {
    case "alt_num":
      switchBuffer(state, action.num - 1);
      break;
    case "alt_left":
      switchBuffer(state, Math.max(0, state.activeIndex - 1));
      break;
    case "alt_right":
      switchBuffer(state, Math.min(state.buffers.length - 1, state.activeIndex + 1));
      break;

    case "page_up":
      if (!isCC) buf.chatScroll = Math.min(buf.chatScroll + layout.chat.h, buf.messages.length);
      break;
    case "page_down":
      if (!isCC) {
        buf.chatScroll = Math.max(0, buf.chatScroll - layout.chat.h);
        if (buf.chatScroll === 0 && buf.messages.length > 0) {
          buf.readMarkerIndex = buf.messages.length - 1;
        }
      }
      break;

    case "alt_m":
      state.mouseEnabled = !state.mouseEnabled;
      if (state.mouseEnabled) enableMouse(); else disableMouse();
      break;
    case "alt_j":
      // Buffer 10+ — enter 2-digit mode
      state.altJPending = true;
      state.altJFirstDigit = "";
      state.inputState.prompt = "[Alt+J] __: ";
      break;
    case "alt_l":
      // Toggle bare display mode (strip colors)
      state.bareMode = !state.bareMode;
      chalk.level = state.bareMode ? 0 : 3;
      break;
    case "ctrl_r":
      state.historySearchMode = true;
      state.historySearchQuery = "";
      state.inputState.prompt = "(search) '': ";
      break;

    case "mouse_scroll_up":
      if (!isCC) buf.chatScroll = Math.min(buf.chatScroll + 3, buf.messages.length);
      break;
    case "mouse_scroll_down":
      if (!isCC) {
        buf.chatScroll = Math.max(0, buf.chatScroll - 3);
        if (buf.chatScroll === 0 && buf.messages.length > 0) {
          buf.readMarkerIndex = buf.messages.length - 1;
        }
      }
      break;
    case "mouse_click": {
      const bounds = {
        buflistW: layout.buflist.w,
        nicklistX: layout.nicklist.x,
        statusbarY: layout.statusbar.y,
        inputY: layout.input.y,
      };
      const region = identifyRegion(action.col, action.row, bounds);
      if (region === "buflist") {
        const entries = buildBuflistEntries(state.buffers);
        const buflistScroll = adjustBuflistScroll(
          entries, state.activeIndex, 0, layout.buflist.h,
        );
        const clickRow = action.row - layout.buflist.y + buflistScroll;
        const clickedEntry = resolveClickedBuffer(entries, clickRow);
        if (clickedEntry !== null) switchBuffer(state, clickedEntry);
      } else if (region === "nicklist") {
        // Show rich presence of clicked user in statusbar
        const clickedRow = action.row - layout.nicklist.y;
        if (clickedRow >= 0 && clickedRow < state.users.length) {
          const clickedUser = state.users[clickedRow];
          if (clickedUser) {
            const rich = clickedUser.richPresence;
            const info = rich
              ? `${clickedUser.nick} — ${rich.project}${rich.language ? ` · ${rich.language}` : ""}${rich.duration ? ` · ${rich.duration}m` : ""}`
              : `${clickedUser.nick} — ${clickedUser.presence}`;
            renderStatusbar(layout.statusbar, {
              nick: state.selfNick,
              status: info,
              channel: buf.channel.name,
            });
            layout.render();
            renderInput(layout.input, state.inputState);
          }
        }
      }
      break;
    }

    case "ctrl_c":
    case "ctrl_d":
      state.quitting = true;
      state.inputState = { text: "", cursor: 0, prompt: "Really quit CCC? (y/N) " };
      break;

    case "char":
      state.inputState = insertChar(state.inputState, action.ch);
      break;
    case "backspace":
      state.inputState = deleteBack(state.inputState);
      break;
    case "delete":
      state.inputState = deleteForward(state.inputState);
      break;
    case "left":
      state.inputState = moveCursorLeft(state.inputState);
      break;
    case "right":
      state.inputState = moveCursorRight(state.inputState);
      break;
    case "ctrl_a":
    case "home":
      state.inputState = moveCursorHome(state.inputState);
      break;
    case "ctrl_e":
    case "end":
      state.inputState = moveCursorEnd(state.inputState);
      break;
    case "ctrl_w":
      state.inputState = deleteWordBack(state.inputState);
      break;
    case "ctrl_k":
      state.inputState = deleteToEnd(state.inputState);
      break;
    case "ctrl_u":
      state.inputState = deleteToStart(state.inputState);
      break;

    case "up": {
      const prev = historyPrev(buf.history, state.inputState.text);
      if (prev !== null) state.inputState = { ...state.inputState, text: prev, cursor: prev.length };
      break;
    }
    case "down": {
      const next = historyNext(buf.history);
      if (next !== null) state.inputState = { ...state.inputState, text: next, cursor: next.length };
      break;
    }
    case "ctrl_up": {
      const prev = historyPrev(state.globalHistory, state.inputState.text);
      if (prev !== null) state.inputState = { ...state.inputState, text: prev, cursor: prev.length };
      break;
    }
    case "ctrl_down": {
      const next = historyNext(state.globalHistory);
      if (next !== null) state.inputState = { ...state.inputState, text: next, cursor: next.length };
      break;
    }

    case "tab": {
      if (state.completionCtx) {
        state.completionCtx.cycleIndex++;
        const result = applyCompletion(state.inputState.text, state.completionCtx);
        state.inputState = { ...state.inputState, text: result.text, cursor: result.cursor };
      } else {
        const nicks = state.users.map((u) => u.nick);
        const channels = state.buffers
          .filter((b) => b.bufferType !== "cc_session")
          .map((b) => b.channel.name);
        const ctx = tabComplete(state.inputState.text, state.inputState.cursor, nicks, channels, COMMANDS);
        if (ctx) {
          state.completionCtx = ctx;
          const result = applyCompletion(state.inputState.text, ctx);
          state.inputState = { ...state.inputState, text: result.text, cursor: result.cursor };
        }
      }
      break;
    }

    case "enter": {
      const text = state.inputState.text.trim();
      if (!text) break;
      if (isCC) break;

      historyAdd(buf.history, text);
      historyAdd(state.globalHistory, text);

      if (text.startsWith("/")) {
        const result = handleCommand(text, buf.channel.name);

        if (text === "/clear") {
          buf.messages = [];
          buf.chatScroll = 0;
        } else if (text === "/quit") {
          state.quitting = true;
          state.inputState = { text: "", cursor: 0, prompt: "Really quit CCC? (y/N) " };
          return;
        } else if (result.serverAction && conn) {
          // Send server actions
          const sa = result.serverAction;
          switch (sa.type) {
            case "join":
              conn.send({ type: "join", channel: sa.channel });
              break;
            case "part":
              conn.send({ type: "part", channel: buf.channel.name, message: sa.message });
              break;
            case "dm":
              // Find user ID by nick
              const target = state.users.find((u) => u.nick === sa.nick);
              if (target) {
                conn.send({ type: "dm", to: target.id, content: sa.content });
              } else {
                buf.messages.push({
                  id: crypto.randomUUID(), from: "", fromNick: "",
                  channel: buf.channel.name,
                  content: `User '${sa.nick}' not found`,
                  timestamp: Date.now(), type: "error",
                });
              }
              break;
            case "nick":
              conn.send({ type: "nick", nick: sa.nick });
              break;
            case "dnd":
              state.selfDnd = !state.selfDnd;
              conn.send({ type: "presence", status: state.selfDnd ? "dnd" : "online" });
              break;
            case "action":
              conn.send({ type: "action", channel: buf.channel.name, content: sa.content });
              break;
          }
        } else if (result.messages) {
          for (const msg of result.messages) {
            msg.channel = buf.channel.name;
            pushMessage(buf, msg);
          }
        }
      } else {
        // Send chat to server
        if (conn) {
          conn.send({ type: "chat", channel: buf.channel.name, content: text });
        }
      }

      state.inputState = clearInput(state.inputState);
      state.inputState.prompt = `[${buf.channel.name}] `;
      break;
    }

    default:
      break;
  }
}

function resolveClickedBuffer(entries: BuflistEntry[], clickRow: number): number | null {
  const sectionOrder: BufferType[] = ["channel", "dm", "cc_session"];
  let lineIndex = 0;

  for (const section of sectionOrder) {
    const sectionEntries = entries.filter((e) => e.bufferType === section);
    if (sectionEntries.length === 0) continue;

    if (lineIndex === clickRow) return null;
    lineIndex++;

    for (const entry of sectionEntries) {
      if (lineIndex === clickRow) return entry.globalIndex;
      lineIndex++;
    }
  }

  return null;
}
