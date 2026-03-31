// Main app orchestrator — connects layout, widgets, keybindings, commands, server

import chalk from "chalk";
import {
  createLayout,
  enterScreen,
  exitScreen,
  isTooSmall,
  fitToWidth,
  type Layout,
} from "./layout.ts";
import { createRenderScheduler } from "./render-scheduler.ts";
import { renderTitlebar } from "./widgets/titlebar.ts";
import { renderStatusbar } from "./widgets/statusbar.ts";
import {
  renderBuflist,
  adjustBuflistScroll,
  type BuflistEntry,
} from "./widgets/buflist.ts";
import { renderChat, isAtBottom, renderCCSessionPlaceholder, getVisibleLines, extractURLs } from "./widgets/chat.ts";
import stringWidth from "string-width";
import { renderNicklist, renderCCSessionMeta, resolveNicklistClick } from "./widgets/nicklist.ts";
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
import { handleCommand, formatWhois, COMMANDS, type ClientAction } from "./commands.ts";
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
import { createCCTerminal, type CCTerminal } from "../cc-integration/pty.ts";
import type { ChatState } from "./widgets/chat.ts";
import { sendNotification } from "./notify.ts";
import { logMessage } from "./logger.ts";
import {
  createSelection,
  startSelection,
  updateSelection,
  finishSelection,
  clearSelection,
  hasSelection,
  selectionBounds,
  invertRange,
  copyToClipboard,
  type SelectionState,
} from "./selection.ts";

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
  lag?: number; // WebSocket round-trip latency in ms
  ccTerminals: Map<string, CCTerminal>;
  ccActive: boolean; // true when CC buffer is focused and PTY has input
  selection: SelectionState;
  ignoreList: Set<string>; // ignored nicks
  typingNick?: string; // nick currently typing in active channel
  typingTimer?: ReturnType<typeof setTimeout>;
  lastTypingSent?: number; // debounce outgoing typing indicator
}

// Default CC session ID prefix — not removed by syncCCSessionBuffers
const LOCAL_CC_PREFIX = "local-";

function createInitialBuffers(): BufferState[] {
  const cwd = process.cwd();
  const project = cwd.split("/").pop() || "project";

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
    {
      channel: {
        name: `⚡${project}`,
        topic: `Claude Code — ${cwd}`,
        members: [],
        hotlist: emptyHotlist(),
      },
      messages: [],
      chatScroll: 0,
      readMarkerIndex: -1,
      history: createHistory(),
      bufferType: "cc_session",
      cachedNickWidth: 4,
      ccSession: {
        id: `${LOCAL_CC_PREFIX}${project}`,
        project,
        cwd,
        startedAt: Date.now(),
        active: true,
      },
    },
  ];
}

/** Sync CC session buffers with detected sessions from PresenceWatcher. */
function syncCCSessionBuffers(state: AppState, sessions: DetectedSession[]) {
  // Remove CC session buffers that are no longer active
  const activeIds = new Set(sessions.map((s) => s.sessionId));
  for (let i = state.buffers.length - 1; i >= 0; i--) {
    const buf = state.buffers[i]!;
    if (buf.bufferType === "cc_session" && buf.ccSession && !activeIds.has(buf.ccSession.id) && !buf.ccSession.id.startsWith(LOCAL_CC_PREFIX)) {
      // Stop and clean up PTY terminal
      const term = state.ccTerminals.get(buf.ccSession.id);
      if (term) {
        term.close();
        state.ccTerminals.delete(buf.ccSession.id);
      }
      // Adjust activeIndex if needed
      if (state.activeIndex > i) state.activeIndex--;
      else if (state.activeIndex === i) state.activeIndex = Math.max(0, i - 1);
      state.buffers.splice(i, 1);
    }
  }

  // Add new CC session buffers (skip if same cwd already exists as local buffer)
  for (const session of sessions) {
    const existsById = state.buffers.some(
      (b) => b.bufferType === "cc_session" && b.ccSession?.id === session.sessionId,
    );
    const existsByCwd = state.buffers.some(
      (b) => b.bufferType === "cc_session" && b.ccSession?.cwd === session.cwd,
    );
    if (!existsById && !existsByCwd) {
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

/** Resolve display name for a buffer (DM channels → peer nick). */
function displayName(buf: BufferState, state: AppState): string {
  if (buf.bufferType === "dm" && buf.channel.name.startsWith("dm:")) {
    const parts = buf.channel.name.split(":");
    const peerId = parts[1] === state.selfId ? parts[2] : parts[1];
    const peer = state.users.find((u) => u.id === peerId);
    return peer ? peer.nick : (peerId?.slice(0, 8) ?? "DM");
  }
  return buf.channel.name;
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

/** Extract plain text from the selected screen region. */
function extractSelectedText(state: AppState, layout: Layout): string | null {
  const bounds = selectionBounds(state.selection);
  if (!bounds) return null;

  const buf = state.buffers[state.activeIndex]!;
  const chatState: ChatState = {
    messages: buf.messages,
    selfNick: state.selfNick,
    nickWidth: buf.cachedNickWidth,
    scrollOffset: buf.chatScroll,
    readMarkerIndex: buf.readMarkerIndex,
    isActive: true,
  };
  const visibleLines = getVisibleLines(chatState, layout.chat.w, layout.chat.h);
  const result: string[] = [];

  for (let absRow = bounds.startRow; absRow <= bounds.endRow; absRow++) {
    const chatRow = absRow - layout.chat.y;
    if (chatRow < 0 || chatRow >= visibleLines.length) continue;
    let line = visibleLines[chatRow]!;
    // Trim columns for first/last row of selection
    if (absRow === bounds.startRow && absRow === bounds.endRow) {
      const start = Math.max(0, bounds.startCol - layout.chat.x);
      const end = Math.max(0, bounds.endCol - layout.chat.x + 1);
      line = line.slice(start, end);
    } else if (absRow === bounds.startRow) {
      const start = Math.max(0, bounds.startCol - layout.chat.x);
      line = line.slice(start);
    } else if (absRow === bounds.endRow) {
      const end = Math.max(0, bounds.endCol - layout.chat.x + 1);
      line = line.slice(0, end);
    }
    result.push(line.trimEnd());
  }

  return result.length > 0 ? result.join("\n") : null;
}

/** Extract text from CC session VTE buffer for the selected screen region. */
function extractCCSelectedText(state: AppState, layout: Layout): string | null {
  const bounds = selectionBounds(state.selection);
  if (!bounds) return null;

  const buf = state.buffers[state.activeIndex]!;
  if (!buf.ccSession) return null;
  const term = state.ccTerminals.get(buf.ccSession.id);
  if (!term) return null;

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const result: string[] = [];

  for (let absRow = bounds.startRow; absRow <= bounds.endRow; absRow++) {
    const chatRow = absRow - layout.chat.y;
    if (chatRow < 0 || chatRow >= layout.chat.h) continue;
    let line = stripAnsi(term.getLine(chatRow));
    if (absRow === bounds.startRow && absRow === bounds.endRow) {
      const start = Math.max(0, bounds.startCol - layout.chat.x);
      const end = Math.max(0, bounds.endCol - layout.chat.x + 1);
      line = line.slice(start, end);
    } else if (absRow === bounds.startRow) {
      line = line.slice(Math.max(0, bounds.startCol - layout.chat.x));
    } else if (absRow === bounds.endRow) {
      line = line.slice(0, Math.max(0, bounds.endCol - layout.chat.x + 1));
    }
    result.push(line.trimEnd());
  }

  return result.length > 0 ? result.join("\n") : null;
}

/** Handle client-only actions from slash commands */
function handleClientAction(
  action: ClientAction,
  state: AppState,
  buf: BufferState,
  layout: Layout,
) {
  switch (action.type) {
    case "ignore":
      state.ignoreList.add(action.nick.toLowerCase());
      break;
    case "unignore":
      state.ignoreList.delete(action.nick.toLowerCase());
      break;
    case "buffer_close": {
      if (state.buffers.length <= 1) {
        pushMessage(buf, {
          id: crypto.randomUUID(), from: "", fromNick: "",
          channel: buf.channel.name,
          content: "Cannot close the last buffer",
          timestamp: Date.now(), type: "error",
        });
        return;
      }
      const idx = state.activeIndex;
      state.buffers.splice(idx, 1);
      state.activeIndex = Math.min(idx, state.buffers.length - 1);
      const newBuf = state.buffers[state.activeIndex]!;
      state.inputState.prompt = `[${displayName(newBuf, state)}] `;
      break;
    }
    case "search": {
      // /whois nick
      if (action.query.startsWith("__whois__")) {
        const nick = action.query.slice(9);
        const user = state.users.find(
          (u) => u.nick.toLowerCase() === nick.toLowerCase(),
        );
        if (user) {
          for (const msg of formatWhois(user)) {
            msg.channel = buf.channel.name;
            pushMessage(buf, msg);
          }
        } else {
          pushMessage(buf, {
            id: crypto.randomUUID(), from: "", fromNick: "",
            channel: buf.channel.name,
            content: `User '${nick}' not found`,
            timestamp: Date.now(), type: "error",
          });
        }
        return;
      }
      // /list
      if (action.query === "__list__") {
        const lines = state.buffers
          .filter((b) => b.bufferType === "channel")
          .map((b) => `  ${b.channel.name} (${b.channel.members.length} members) — ${b.channel.topic || "(no topic)"}`);
        if (lines.length === 0) lines.push("  No channels");
        pushMessage(buf, {
          id: crypto.randomUUID(), from: "", fromNick: "",
          channel: buf.channel.name, content: "Channels:",
          timestamp: Date.now(), type: "network",
        });
        for (const l of lines) {
          pushMessage(buf, {
            id: crypto.randomUUID(), from: "", fromNick: "",
            channel: buf.channel.name, content: l,
            timestamp: Date.now(), type: "network",
          });
        }
        return;
      }
      // /search pattern — highlight matches in current buffer
      const query = action.query.toLowerCase();
      const matches = buf.messages.filter(
        (m) => m.content.toLowerCase().includes(query) ||
               m.fromNick.toLowerCase().includes(query),
      );
      if (matches.length === 0) {
        pushMessage(buf, {
          id: crypto.randomUUID(), from: "", fromNick: "",
          channel: buf.channel.name,
          content: `No results for '${action.query}'`,
          timestamp: Date.now(), type: "network",
        });
      } else {
        pushMessage(buf, {
          id: crypto.randomUUID(), from: "", fromNick: "",
          channel: buf.channel.name,
          content: `Found ${matches.length} result(s) for '${action.query}':`,
          timestamp: Date.now(), type: "network",
        });
        for (const m of matches.slice(-10)) {
          const ts = new Date(m.timestamp).toLocaleTimeString("en", {
            hour: "2-digit", minute: "2-digit",
          });
          pushMessage(buf, {
            id: crypto.randomUUID(), from: "", fromNick: "",
            channel: buf.channel.name,
            content: `  [${ts}] <${m.fromNick}> ${m.content}`,
            timestamp: Date.now(), type: "network",
          });
        }
      }
      break;
    }
  }
}

function buildBuflistEntries(state: AppState): BuflistEntry[] {
  return state.buffers.map((buf, i) => ({
    name: displayName(buf, state),
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
  scheduleRender: () => void,
) {
  switch (msg.type) {
    case "auth_ok": {
      state.selfNick = msg.user.nick;
      state.selfId = msg.user.id;
      state.inputState.prompt = `[${displayName(state.buffers[state.activeIndex]!, state)}] `;

      // If user configured a nick (via onboarding/env) that differs, request change
      const desiredNick = process.env["CCC_NICK"];
      if (desiredNick && desiredNick !== msg.user.nick && state.connection) {
        state.connection.send({ type: "nick", nick: desiredNick });
      }
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
      // Ignore filter
      if (state.ignoreList.has(chatMsg.fromNick.toLowerCase())) break;
      const idx = getOrCreateBuffer(state, chatMsg.channel);
      pushMessage(state.buffers[idx]!, chatMsg);

      // Log to file
      logMessage(chatMsg);

      // Hotlist + notifications if not active buffer
      if (idx !== state.activeIndex) {
        const h = state.buffers[idx]!.channel.hotlist;
        const isMention = !state.selfDnd && chatMsg.content.includes(`@${state.selfNick}`);
        if (isMention) {
          h.highlight++;
          sendNotification(chatMsg.channel, `${chatMsg.fromNick}: ${chatMsg.content}`);
        } else if (chatMsg.channel.startsWith("dm:")) {
          h.private++;
          sendNotification(`DM from ${chatMsg.fromNick}`, chatMsg.content);
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
      // Dedup by message ID to prevent duplicates on reconnect
      const existingIds = new Set(histBuf.messages.map((m) => m.id));
      const newMessages = msg.messages.filter((m) => !existingIds.has(m.id));
      histBuf.messages = [...newMessages, ...histBuf.messages];
      // Recompute nick width from history
      for (const m of newMessages) {
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

    case "topic_change": {
      const idx = findBufferByChannel(state, msg.channel);
      if (idx >= 0) {
        state.buffers[idx]!.channel.topic = msg.topic;
        pushMessage(state.buffers[idx]!, {
          id: crypto.randomUUID(), from: "", fromNick: msg.nick,
          channel: msg.channel,
          content: `${msg.nick} changed topic to: ${msg.topic}`,
          timestamp: Date.now(), type: "network",
        });
      }
      break;
    }

    case "typing": {
      // Show typing indicator in statusbar (clear after 3 seconds)
      const activeBuf = state.buffers[state.activeIndex]!;
      if (msg.channel === activeBuf.channel.name) {
        state.typingNick = msg.nick;
        if (state.typingTimer) clearTimeout(state.typingTimer);
        state.typingTimer = setTimeout(() => {
          state.typingNick = undefined;
          state.typingTimer = undefined;
          scheduleRender();
        }, 3000);
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

  scheduleRender();
}

// --- Rendering ---

function renderAll(layout: Layout, state: AppState) {
  const buf = state.buffers[state.activeIndex]!;
  const isCC = buf.bufferType === "cc_session";

  renderTitlebar(layout.titlebar, {
    channel: displayName(buf, state),
    topic: buf.channel.topic,
  });

  let statusText =
    state.connectionStatus === "connected"
      ? "Connected"
      : state.connectionStatus === "connecting"
        ? "Connecting..."
        : "Disconnected";
  if (state.typingNick) statusText = `${state.typingNick} is typing...`;

  renderStatusbar(layout.statusbar, {
    nick: state.selfNick,
    status: isCC ? "CC Session" : statusText,
    channel: displayName(buf, state),
    lag: state.lag,
  });

  const entries = buildBuflistEntries(state);
  const buflistScroll = adjustBuflistScroll(
    entries, state.activeIndex, 0, layout.buflist.h,
  );
  renderBuflist(layout.buflist, {
    entries, activeIndex: state.activeIndex, scrollOffset: buflistScroll,
  });

  if (isCC && buf.ccSession) {
    const term = state.ccTerminals.get(buf.ccSession.id);
    if (term) {
      const sel = state.selection;
      const sBounds = hasSelection(sel) || sel.isDragging ? selectionBounds(sel) : null;
      for (let row = 0; row < layout.chat.h; row++) {
        let line = row < term.rows ? term.getLine(row) : "";
        // Apply selection overlay on CC session VTE lines
        if (sBounds) {
          const absRow = layout.chat.y + row;
          if (absRow >= sBounds.startRow && absRow <= sBounds.endRow) {
            const colStart = absRow === sBounds.startRow
              ? Math.max(0, sBounds.startCol - layout.chat.x) : 0;
            const colEnd = absRow === sBounds.endRow
              ? Math.max(0, sBounds.endCol - layout.chat.x + 1) : layout.chat.w;
            line = invertRange(line, colStart, colEnd, layout.chat.w);
          }
        }
        layout.chat.writeLine(row, line);
      }
    } else {
      renderCCSessionPlaceholder(layout.chat, buf.ccSession);
    }
  } else {
    const chatState: ChatState = {
      messages: buf.messages,
      selfNick: state.selfNick,
      nickWidth: buf.cachedNickWidth,
      scrollOffset: buf.chatScroll,
      readMarkerIndex: buf.readMarkerIndex,
      isActive: true,
      selection: state.selection,
    };
    renderChat(layout.chat, chatState);
  }

  if (isCC && buf.ccSession) {
    renderCCSessionMeta(layout.nicklist, buf.ccSession);
  } else {
    renderNicklist(layout.nicklist, { users: state.users, scrollOffset: 0 });
  }

  // Borders + cursor positioning via screen buffer
  layout.render();

  if (state.ccActive && isCC && buf.ccSession) {
    layout.input.writeLine(0, "");
    const term = state.ccTerminals.get(buf.ccSession.id);
    if (term) {
      term.clearDirty();
      if (term.scrollOffset === 0) {
        layout.buffer.writeRaw(
          `\x1b[${layout.chat.y + term.cursorRow + 1};${layout.chat.x + term.cursorCol + 1}H`,
        );
      }
    }
  } else {
    renderInput(layout.input, state.inputState);
  }

  layout.flush();
}

// --- Main ---

export function startApp() {
  const state: AppState = {
    buffers: createInitialBuffers(),
    activeIndex: 0,
    selfNick: process.env["CCC_NICK"] ?? "me",
    selfId: "",
    users: [],
    mouseEnabled: true,
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
    ccTerminals: new Map(),
    ccActive: false,
    selection: createSelection(),
    ignoreList: new Set(),
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
  // setEncoding('utf8') before setRawMode — ensures Node/Bun's StringDecoder
  // buffers incomplete multi-byte sequences (Korean/CJK/emoji) across chunks,
  // preventing the "press Enter twice" bug with Korean IME input.
  // Adapted from Ink's App.tsx stdin setup.
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const layout = createLayout();
  const scheduler = createRenderScheduler(() => renderAll(layout, state));
  enableMouse();
  renderAll(layout, state);

  // CC PTY render loop — debounced: wait 8ms after last data chunk before rendering
  // so we capture CC's full TUI redraw instead of half-drawn intermediate states
  setInterval(() => {
    if (!state.ccActive) return;
    const activeBuf = state.buffers[state.activeIndex];
    if (!activeBuf?.ccSession) return;
    const term = state.ccTerminals.get(activeBuf.ccSession.id);
    if (!term || !term.isDirty()) return;
    if (performance.now() - term.lastDataTime < 8) return; // wait for redraw to finish
    term.clearDirty();

    for (let row = 0; row < layout.chat.h; row++) {
      layout.chat.writeLine(row, row < term.rows ? term.getLine(row) : "");
    }
    layout.render();
    if (term.scrollOffset === 0) {
      layout.buffer.writeRaw(
        `\x1b[${layout.chat.y + term.cursorRow + 1};${layout.chat.x + term.cursorCol + 1}H`,
      );
    }
    layout.flush();
  }, 16);

  // Connect to server
  const conn = createConnection({
    onMessage(msg: ServerMessage) {
      handleServerMessage(msg, state, layout, scheduler.schedule);
    },
    onStatusChange(status: ConnectionStatus, detail?: string) {
      state.connectionStatus = status;
      if (status === "disconnected" && detail) {
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
      scheduler.schedule();
    },
    onLagUpdate(lagMs: number) {
      state.lag = lagMs;
      scheduler.schedule();
    },
  });
  state.connection = conn;

  // Start CC session presence watcher — only send after auth
  const presenceWatcher = createPresenceWatcher();
  presenceWatcher.onChange((status, rich, sessions) => {
    if (state.connectionStatus === "connected") {
      conn.send({ type: "presence", status, rich });
    }
    if (sessions) {
      syncCCSessionBuffers(state, sessions);
    }
    scheduler.schedule();
  });
  presenceWatcher.start();

  // Cleanup on exit — guard against double invocation
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    scheduler.cancel();
    presenceWatcher.stop();
    for (const term of state.ccTerminals.values()) term.close();
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
    layout.invalidateAll();
    const activeBuf = state.buffers[state.activeIndex];
    if (activeBuf?.ccSession) {
      const term = state.ccTerminals.get(activeBuf.ccSession.id);
      if (term) term.resize(layout.chat.w, layout.chat.h);
    }
    process.stdout.write("\x1b[2J");
    renderAll(layout, state);
  });

  // Input loop — data arrives as string because of setEncoding('utf8')
  process.stdin.on("data", (data: string) => {
    // CC active: forward input to PTY with mouse coordinate translation
    if (state.ccActive) {
      const s = data;
      // Alt+1~9: ESC + digit → switch buffer (CCC intercepts)
      if (s.length === 2 && s[0] === "\x1b" && s[1]! >= "1" && s[1]! <= "9") {
        const num = parseInt(s[1]!, 10);
        switchBuffer(state, num - 1, layout, scheduler.schedule);
        renderAll(layout, state);
        return;
      }

      const activeBuf = state.buffers[state.activeIndex];
      const term = activeBuf?.ccSession
        ? state.ccTerminals.get(activeBuf.ccSession.id)
        : null;
      if (!term) return;

      // Parse SGR mouse events: \x1b[<btn;col;row;M/m
      const mouseRe = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      let match: RegExpExecArray | null;
      let lastIdx = 0;
      let hasMouseEvent = false;
      let ccScrollDelta = 0;

      while ((match = mouseRe.exec(s)) !== null) {
        hasMouseEvent = true;
        if (match.index > lastIdx) {
          term.write(s.slice(lastIdx, match.index));
        }
        lastIdx = match.index + match[0].length;

        const btnNum = parseInt(match[1]!, 10);
        const col = parseInt(match[2]!, 10);
        const row = parseInt(match[3]!, 10);
        const suffix = match[4]!;

        if (btnNum === 64) {
          ccScrollDelta++; // wheel up → scroll into history
        } else if (btnNum === 65) {
          ccScrollDelta--; // wheel down → scroll toward live
        } else {
          // Selection is handled by CCC directly (like tmux), not by
          // forwarding to PTY. PTY pipe can't handle drag event volume.
          const col0 = col - 1;
          const row0 = row - 1;
          const isDrag = (btnNum & 0x20) !== 0;
          const isRelease = suffix === "m";
          const isPress = suffix === "M" && !isDrag;
          const bounds = {
            buflistW: layout.buflist.w,
            nicklistX: layout.nicklist.x,
            statusbarY: layout.statusbar.y,
            inputY: layout.input.y,
          };
          const rgn = identifyRegion(col0, row0, bounds);

          if (isDrag && state.selection.isDragging) {
            updateSelection(state.selection, col0, row0);
            renderAll(layout, state);
          } else if (isPress && rgn === "chat") {
            startSelection(state.selection, col0, row0);
          } else if (isRelease) {
            if (hasSelection(state.selection) && state.selection.isDragging) {
              finishSelection(state.selection);
              const selectedText = extractCCSelectedText(state, layout);
              if (selectedText) copyToClipboard(selectedText);
              renderAll(layout, state);
            } else {
              clearSelection(state.selection);
              // Simple click (no drag) — forward to PTY or handle buflist
              if (rgn === "buflist") {
                const entries = buildBuflistEntries(state);
                const bScroll = adjustBuflistScroll(entries, state.activeIndex, 0, layout.buflist.h);
                const clickRow = row0 - layout.buflist.y + bScroll;
                const clicked = resolveClickedBuffer(entries, clickRow);
                if (clicked !== null) {
                  switchBuffer(state, clicked, layout, scheduler.schedule);
                  renderAll(layout, state);
                }
              } else if (rgn === "chat") {
                // Forward click to PTY for interactive elements
                const newCol = col - layout.chat.x;
                const newRow = row - layout.chat.y;
                if (newCol >= 1 && newCol <= layout.chat.w &&
                    newRow >= 1 && newRow <= layout.chat.h) {
                  term.write(`\x1b[<0;${newCol};${newRow}M\x1b[<0;${newCol};${newRow}m`);
                }
              }
            }
          }
        }
      }

      // Apply VTE scrollback offset (clamped ±3 per chunk)
      if (ccScrollDelta !== 0) {
        const clamped = Math.sign(ccScrollDelta) * Math.min(Math.abs(ccScrollDelta), 3);
        term.scrollOffset = Math.max(0, Math.min(term.scrollbackSize, term.scrollOffset + clamped));
        for (let r = 0; r < layout.chat.h; r++) {
          layout.chat.writeLine(r, term.getLine(r));
        }
        if (term.scrollOffset === 0) {
          const absRow = layout.chat.y + term.cursorRow + 1;
          const absCol = layout.chat.x + term.cursorCol + 1;
          layout.buffer.writeRaw(`\x1b[${absRow};${absCol}H`);
        }
        layout.flush();
      }

      if (hasMouseEvent) {
        if (lastIdx < s.length) term.write(s.slice(lastIdx));
      } else {
        // No mouse events — forward raw data as-is
        term.write(data);
      }
      return;
    }

    // Normal CCC input
    const actions = parseInput(data);
    // Normalize scroll: collapse burst of wheel events in one chunk, clamp to ±3 lines
    let scrollDelta = 0;
    for (const action of actions) {
      if (action.type === "mouse_scroll_up") scrollDelta++;
      else if (action.type === "mouse_scroll_down") scrollDelta--;
      else handleAction(action, layout, state, scheduler.schedule);
    }
    if (scrollDelta !== 0) {
      const buf = state.buffers[state.activeIndex]!;
      const clamped = Math.sign(scrollDelta) * Math.min(Math.abs(scrollDelta), 3);
      if (clamped > 0 && buf.messages.length > 0) {
        buf.chatScroll += clamped;
      } else if (clamped < 0) {
        buf.chatScroll = Math.max(0, buf.chatScroll + clamped);
        if (buf.chatScroll === 0 && buf.messages.length > 0) {
          buf.readMarkerIndex = buf.messages.length - 1;
        }
      }
    }
    renderAll(layout, state);
  });
}

function switchBuffer(
  state: AppState,
  index: number,
  layout?: Layout,
  onRender?: () => void,
) {
  if (index < 0 || index >= state.buffers.length) return;
  const curBuf = state.buffers[state.activeIndex]!;
  if (curBuf.messages.length > 0) {
    curBuf.readMarkerIndex = curBuf.messages.length - 1;
  }
  state.activeIndex = index;
  state.buffers[index]!.channel.hotlist = emptyHotlist();
  state.inputState.prompt = `[${displayName(state.buffers[index]!, state)}] `;
  state.completionCtx = null;

  const newBuf = state.buffers[index]!;
  if (newBuf.bufferType === "cc_session" && newBuf.ccSession && layout) {
    ensureCCTerminal(state, newBuf, layout, onRender);
    state.ccActive = true;
  } else {
    state.ccActive = false;
  }
}

/** Create CC PTY terminal lazily, sized to chat region. */
function ensureCCTerminal(
  state: AppState,
  buf: BufferState,
  layout: Layout,
  onRender?: () => void,
) {
  const sid = buf.ccSession!.id;
  if (state.ccTerminals.has(sid)) return;

  const term = createCCTerminal(
    buf.ccSession!.cwd,
    layout.chat.w,
    layout.chat.h,
    (code) => {
      state.ccTerminals.delete(sid);
      const activeBuf = state.buffers[state.activeIndex];
      if (activeBuf?.ccSession?.id === sid) {
        state.ccActive = false;
        if (onRender) onRender();
      }
    },
  );
  state.ccTerminals.set(sid, term);
}

function handleAction(action: Action, layout: Layout, state: AppState, onRender?: () => void) {
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
        state.inputState.prompt = `[${displayName(buf, state)}] `;
        switchBuffer(state, bufNum - 1, layout, onRender);
        return;
      }
    }
    // Any non-digit cancels
    state.altJPending = false;
    state.altJFirstDigit = "";
    state.inputState.prompt = `[${displayName(buf, state)}] `;
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
      state.inputState.prompt = `[${displayName(buf, state)}] `;
      return;
    } else {
      // Any other key exits search
      state.historySearchMode = false;
      state.inputState.prompt = `[${displayName(buf, state)}] `;
    }
  }

  if (action.type !== "tab") {
    state.completionCtx = null;
  }

  // Clear selection on non-mouse actions
  if (
    action.type !== "mouse_press" &&
    action.type !== "mouse_drag" &&
    action.type !== "mouse_click" &&
    action.type !== "mouse_scroll_up" &&
    action.type !== "mouse_scroll_down"
  ) {
    clearSelection(state.selection);
  }

  switch (action.type) {
    case "alt_num":
      switchBuffer(state, action.num - 1, layout, onRender);
      break;
    case "alt_left":
      switchBuffer(state, Math.max(0, state.activeIndex - 1), layout, onRender);
      break;
    case "alt_right":
      switchBuffer(state, Math.min(state.buffers.length - 1, state.activeIndex + 1), layout, onRender);
      break;

    case "page_up":
      buf.chatScroll += layout.chat.h;
      break;
    case "page_down":
      buf.chatScroll = Math.max(0, buf.chatScroll - layout.chat.h);
      if (buf.chatScroll === 0 && buf.messages.length > 0) {
        buf.readMarkerIndex = buf.messages.length - 1;
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

    // mouse_scroll_up/down: handled in input loop with normalization (not here)
    case "mouse_press": {
      // Start text selection in chat region
      const pressBounds = {
        buflistW: layout.buflist.w,
        nicklistX: layout.nicklist.x,
        statusbarY: layout.statusbar.y,
        inputY: layout.input.y,
      };
      const pressRegion = identifyRegion(action.col, action.row, pressBounds);
      if (pressRegion === "chat") {
        startSelection(state.selection, action.col, action.row);
      } else {
        clearSelection(state.selection);
      }
      break;
    }

    case "mouse_drag": {
      // Extend text selection
      if (state.selection.isDragging) {
        updateSelection(state.selection, action.col, action.row);
      }
      break;
    }

    case "mouse_click": {
      // Finalize selection and copy if text was selected
      if (hasSelection(state.selection) && state.selection.isDragging) {
        finishSelection(state.selection);
        const selectedText = extractSelectedText(state, layout);
        if (selectedText) copyToClipboard(selectedText);
        // Selection remains visible until next non-mouse action
        break;
      }
      clearSelection(state.selection);

      const bounds = {
        buflistW: layout.buflist.w,
        nicklistX: layout.nicklist.x,
        statusbarY: layout.statusbar.y,
        inputY: layout.input.y,
      };
      const region = identifyRegion(action.col, action.row, bounds);
      if (region === "buflist") {
        const entries = buildBuflistEntries(state);
        const buflistScroll = adjustBuflistScroll(
          entries, state.activeIndex, 0, layout.buflist.h,
        );
        const clickRow = action.row - layout.buflist.y + buflistScroll;
        const clickedEntry = resolveClickedBuffer(entries, clickRow);
        if (clickedEntry !== null) switchBuffer(state, clickedEntry, layout, onRender);
      } else if (region === "nicklist") {
        // Show rich presence of clicked user in statusbar
        const clickedRow = action.row - layout.nicklist.y;
        const clickedUser = resolveNicklistClick(state.users, clickedRow, 0);
        if (clickedRow >= 0 && clickedUser) {
          const rich = clickedUser.richPresence;
          const info = rich
            ? `${clickedUser.nick} — ${rich.project}${rich.language ? ` · ${rich.language}` : ""}${rich.duration ? ` · ${rich.duration}m` : ""}`
            : `${clickedUser.nick} — ${clickedUser.presence}`;
          renderStatusbar(layout.statusbar, {
            nick: state.selfNick,
            status: info,
            channel: displayName(buf, state),
          });
          layout.render();
          renderInput(layout.input, state.inputState);
          layout.flush();
        }
      } else if (region === "chat") {
        // Click in chat: open URL if the clicked line contains one
        const chatRow = action.row - layout.chat.y;
        const chatState: ChatState = {
          messages: buf.messages, selfNick: state.selfNick,
          nickWidth: buf.cachedNickWidth, scrollOffset: buf.chatScroll,
          readMarkerIndex: buf.readMarkerIndex, isActive: true,
        };
        const lines = getVisibleLines(chatState, layout.chat.w, layout.chat.h);
        if (chatRow >= 0 && chatRow < lines.length) {
          const urls = extractURLs(lines[chatRow]!);
          if (urls.length > 0) {
            const cmd = process.platform === "darwin" ? "open" : "xdg-open";
            try { Bun.spawn([cmd, urls[0]!]); } catch { /* no opener */ }
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
      // Send typing indicator (debounced, max once per 2s)
      if (conn && !isCC) {
        const now = Date.now();
        if (!state.lastTypingSent || now - state.lastTypingSent > 2000) {
          conn.send({ type: "typing", channel: buf.channel.name });
          state.lastTypingSent = now;
        }
      }
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

      historyAdd(buf.history, text);
      historyAdd(state.globalHistory, text);

      // CCC-only commands: /clear, /quit, /help — work in all buffers
      const cccCmd = text.match(/^\/(clear|quit|help)(\s|$)/)?.[1];
      if (cccCmd === "clear") {
        buf.messages = [];
        buf.chatScroll = 0;
      } else if (cccCmd === "quit") {
        state.quitting = true;
        state.inputState = { text: "", cursor: 0, prompt: "Really quit CCC? (y/N) " };
        return;
      } else if (cccCmd === "help") {
        const result = handleCommand(text, buf.channel.name);
        if (result.messages) {
          for (const msg of result.messages) {
            msg.channel = buf.channel.name;
            pushMessage(buf, msg);
          }
        }
      } else if (text.startsWith("/")) {
        const result = handleCommand(text, buf.channel.name);
        // Handle client-side actions
        if (result.clientAction) {
          handleClientAction(result.clientAction, state, buf, layout);
        }
        // Handle server actions
        if (result.serverAction && conn) {
          const sa = result.serverAction;
          switch (sa.type) {
            case "join":
              conn.send({ type: "join", channel: sa.channel });
              break;
            case "part":
              conn.send({ type: "part", channel: buf.channel.name, message: sa.message });
              break;
            case "dm": {
              const target = state.users.find((u) => u.nick === sa.nick);
              if (target) {
                conn.send({ type: "dm", to: target.id, content: sa.content });
              } else {
                pushMessage(buf, {
                  id: crypto.randomUUID(), from: "", fromNick: "",
                  channel: buf.channel.name,
                  content: `User '${sa.nick}' not found`,
                  timestamp: Date.now(), type: "error",
                });
              }
              break;
            }
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
            case "topic":
              conn.send({ type: "topic", channel: sa.channel, topic: sa.topic });
              break;
          }
        }
        // Display local messages
        if (result.messages) {
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
      state.inputState.prompt = `[${displayName(buf, state)}] `;
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

    // Match buildLines: cc_session has no section header
    if (section !== "cc_session") {
      if (lineIndex === clickRow) return null; // clicked on header
      lineIndex++;
    }

    for (const entry of sectionEntries) {
      if (lineIndex === clickRow) return entry.globalIndex;
      lineIndex++;
    }
  }

  return null;
}
