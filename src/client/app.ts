// Main app orchestrator — connects layout, widgets, keybindings, commands

import cliCursor from "cli-cursor";
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
import { renderChat, computeNickWidth, isAtBottom, renderCCSessionPlaceholder } from "./widgets/chat.ts";
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
import type {
  Channel,
  Message,
  User,
  BufferType,
  CCSession,
} from "../shared/types.ts";
import { emptyHotlist } from "../shared/types.ts";
import type { ChatState } from "./widgets/chat.ts";

// --- App state ---

interface BufferState {
  channel: Channel;
  messages: Message[];
  chatScroll: number;
  readMarkerIndex: number;
  history: History;
  bufferType: BufferType;
  ccSession?: CCSession; // only for cc_session buffers
}

interface AppState {
  buffers: BufferState[];
  activeIndex: number;
  selfNick: string;
  users: User[];
  mouseEnabled: boolean;
  quitting: boolean; // quit confirmation mode
  inputState: InputState;
  completionCtx: CompletionContext | null;
}

function createDummyUsers(): User[] {
  return [
    { id: "1", nick: "alice", publicKey: "", presence: "coding", richPresence: { project: "ccc", language: "TypeScript" } },
    { id: "2", nick: "bob", publicKey: "", presence: "online" },
    { id: "3", nick: "charlie", publicKey: "", presence: "dnd" },
    { id: "4", nick: "dave", publicKey: "", presence: "offline" },
  ];
}

function createDummyMessages(channel: string, selfNick: string): Message[] {
  const now = Date.now();
  const msgs: Message[] = [];
  const m = (from: string, content: string, type: Message["type"], offset: number): Message => ({
    id: crypto.randomUUID(), from, fromNick: from, channel, content,
    timestamp: now - offset, type,
  });

  if (channel === "#general") {
    msgs.push(m("", "Welcome to #general", "system", 600000));
    msgs.push(m("alice", `${channel}`, "join", 500000));
    msgs.push(m("bob", `${channel}`, "join", 400000));
    msgs.push(m("alice", "hey everyone!", "chat", 300000));
    msgs.push(m("bob", `what's up @${selfNick}`, "chat", 200000));
    msgs.push(m("alice", "working on the TUI 한글 테스트 🎮", "chat", 100000));
    msgs.push(m("charlie", "shrugs", "action", 50000));
  } else if (channel === "#dev") {
    msgs.push(m("", "Development discussion", "system", 300000));
    msgs.push(m("alice", `${channel}`, "join", 200000));
    msgs.push(m("alice", "PR #42 is ready for review", "chat", 100000));
  } else if (channel === "#help") {
    msgs.push(m("", "Type /help for commands", "system", 100000));
  }

  return msgs;
}

function createDummyCCSessions(): CCSession[] {
  return [
    {
      id: "session-1",
      project: "ccc",
      language: "TypeScript",
      cwd: `${process.env["HOME"] ?? "/home/user"}/projects/CCC`,
      startedAt: Date.now() - 45 * 60000, // 45 min ago
      active: true,
    },
    {
      id: "session-2",
      project: "api-server",
      language: "Go",
      cwd: `${process.env["HOME"] ?? "/home/user"}/projects/api-server`,
      startedAt: Date.now() - 120 * 60000, // 2h ago
      active: true,
    },
  ];
}

function createBuffers(selfNick: string): BufferState[] {
  const buffers: BufferState[] = [];

  // Channels
  const channels = ["#general", "#dev", "#help"];
  for (const name of channels) {
    buffers.push({
      channel: {
        name,
        topic: name === "#general" ? "General chat" : name === "#dev" ? "Dev talk" : "Help",
        members: [],
        hotlist: emptyHotlist(),
      },
      messages: createDummyMessages(name, selfNick),
      chatScroll: 0,
      readMarkerIndex: -1,
      history: createHistory(),
      bufferType: "channel",
    });
  }

  // CC Sessions (dummy)
  const sessions = createDummyCCSessions();
  for (const session of sessions) {
    buffers.push({
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
      ccSession: session,
    });
  }

  return buffers;
}

// Build buflist entries from buffers
function buildBuflistEntries(buffers: BufferState[]): BuflistEntry[] {
  return buffers.map((buf, i) => ({
    name: buf.channel.name,
    bufferType: buf.bufferType,
    channel: buf.channel,
    globalIndex: i,
  }));
}

// --- Rendering ---

function renderAll(layout: Layout, state: AppState) {
  const buf = state.buffers[state.activeIndex]!;
  const isCC = buf.bufferType === "cc_session";

  renderTitlebar(layout.titlebar, {
    channel: buf.channel.name,
    topic: buf.channel.topic,
  });

  renderStatusbar(layout.statusbar, {
    nick: state.selfNick,
    status: isCC ? "CC Session" : "Local",
    channel: buf.channel.name,
  });

  const entries = buildBuflistEntries(state.buffers);
  const buflistScroll = adjustBuflistScroll(
    entries,
    state.activeIndex,
    0,
    layout.buflist.h,
  );
  renderBuflist(layout.buflist, {
    entries,
    activeIndex: state.activeIndex,
    scrollOffset: buflistScroll,
  });

  // Chat area: CC session placeholder or normal chat
  if (isCC && buf.ccSession) {
    renderCCSessionPlaceholder(layout.chat, buf.ccSession);
  } else {
    const chatState: ChatState = {
      messages: buf.messages,
      selfNick: state.selfNick,
      nickWidth: computeNickWidth(buf.messages),
      scrollOffset: buf.chatScroll,
      readMarkerIndex: buf.readMarkerIndex,
      isActive: true,
    };
    renderChat(layout.chat, chatState);
  }

  // Nicklist: CC session metadata or normal nicklist
  if (isCC && buf.ccSession) {
    renderCCSessionMeta(layout.nicklist, buf.ccSession);
  } else {
    renderNicklist(layout.nicklist, {
      users: state.users,
      scrollOffset: 0,
    });
  }

  layout.render(); // borders

  renderInput(layout.input, state.inputState);
  cliCursor.show();
}

// --- Main ---

export function startApp() {
  const selfNick = "me";
  const state: AppState = {
    buffers: createBuffers(selfNick),
    activeIndex: 0,
    selfNick,
    users: createDummyUsers(),
    mouseEnabled: false,
    quitting: false,
    inputState: { text: "", cursor: 0, prompt: "[#general] " },
    completionCtx: null,
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
  // Mouse OFF by default (like WeeChat) — Alt+M to toggle
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const layout = createLayout();
  renderAll(layout, state);

  // Cleanup on exit
  function cleanup() {
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
    layout.recalculate();
    process.stdout.write("\x1b[2J"); // clear
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
  // Mark current buffer's read marker
  const curBuf = state.buffers[state.activeIndex]!;
  if (curBuf.messages.length > 0) {
    curBuf.readMarkerIndex = curBuf.messages.length - 1;
  }
  state.activeIndex = index;
  state.buffers[index]!.channel.hotlist = emptyHotlist();
  state.inputState.prompt = `[${state.buffers[index]!.channel.name}] `;
  state.completionCtx = null;
}

function addMessage(state: AppState, bufferIndex: number, msg: Message) {
  const buf = state.buffers[bufferIndex]!;
  buf.messages.push(msg);
}

function handleAction(action: Action, layout: Layout, state: AppState) {
  const buf = state.buffers[state.activeIndex]!;
  const isCC = buf.bufferType === "cc_session";

  // Quit confirmation mode
  if (state.quitting) {
    if (action.type === "char" && (action.ch === "y" || action.ch === "Y")) {
      disableMouse();
      process.stdin.setRawMode(false);
      exitScreen();
      process.exit(0);
    }
    state.quitting = false;
    return;
  }

  // Reset completion on non-tab
  if (action.type !== "tab") {
    state.completionCtx = null;
  }

  switch (action.type) {
    // Buffer navigation
    case "alt_num":
      switchBuffer(state, action.num - 1);
      break;
    case "alt_left":
      switchBuffer(state, Math.max(0, state.activeIndex - 1));
      break;
    case "alt_right":
      switchBuffer(state, Math.min(state.buffers.length - 1, state.activeIndex + 1));
      break;

    // Chat scroll (only for non-CC buffers)
    case "page_up":
      if (!isCC) {
        buf.chatScroll = Math.min(buf.chatScroll + layout.chat.h, buf.messages.length);
      }
      break;
    case "page_down":
      if (!isCC) {
        buf.chatScroll = Math.max(0, buf.chatScroll - layout.chat.h);
      }
      break;

    // Mouse
    case "alt_m":
      state.mouseEnabled = !state.mouseEnabled;
      if (state.mouseEnabled) enableMouse(); else disableMouse();
      break;
    case "mouse_scroll_up":
      if (!isCC) {
        buf.chatScroll = Math.min(buf.chatScroll + 3, buf.messages.length);
      }
      break;
    case "mouse_scroll_down":
      if (!isCC) {
        buf.chatScroll = Math.max(0, buf.chatScroll - 3);
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
        // Need to map visual row to actual buffer index
        const entries = buildBuflistEntries(state.buffers);
        const clickRow = action.row - layout.buflist.y;
        const clickedEntry = resolveClickedBuffer(entries, clickRow);
        if (clickedEntry !== null) {
          switchBuffer(state, clickedEntry);
        }
      }
      break;
    }

    // Quit
    case "ctrl_c":
    case "ctrl_d": {
      state.quitting = true;
      state.inputState = { text: "", cursor: 0, prompt: "Really quit CCC? (y/N) " };
      break;
    }

    // Input editing (disabled for CC session buffers — no chat input)
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

    // History
    case "up": {
      const prev = historyPrev(buf.history, state.inputState.text);
      if (prev !== null) {
        state.inputState = { ...state.inputState, text: prev, cursor: prev.length };
      }
      break;
    }
    case "down": {
      const next = historyNext(buf.history);
      if (next !== null) {
        state.inputState = { ...state.inputState, text: next, cursor: next.length };
      }
      break;
    }

    // Tab completion
    case "tab": {
      if (state.completionCtx) {
        state.completionCtx.cycleIndex++;
        const result = applyCompletion(state.inputState.text, state.completionCtx);
        state.inputState = { ...state.inputState, text: result.text, cursor: result.cursor };
      } else {
        const nicks = state.users.map((u) => u.nick);
        const channels = state.buffers.map((b) => b.channel.name);
        const ctx = tabComplete(state.inputState.text, state.inputState.cursor, nicks, channels, COMMANDS);
        if (ctx) {
          state.completionCtx = ctx;
          const result = applyCompletion(state.inputState.text, ctx);
          state.inputState = { ...state.inputState, text: result.text, cursor: result.cursor };
        }
      }
      break;
    }

    // Submit
    case "enter": {
      const text = state.inputState.text.trim();
      if (!text) break;

      // CC session buffers don't accept chat input (Phase 3 will pipe to CC subprocess)
      if (isCC) {
        break;
      }

      historyAdd(buf.history, text);

      if (text.startsWith("/")) {
        const result = handleCommand(text, buf.channel.name);

        if (text === "/clear") {
          buf.messages = [];
          buf.chatScroll = 0;
        } else if (text === "/quit") {
          state.quitting = true;
          state.inputState = { text: "", cursor: 0, prompt: "Really quit CCC? (y/N) " };
          return;
        } else if (result.messages) {
          for (const msg of result.messages) {
            msg.channel = buf.channel.name;
            addMessage(state, state.activeIndex, msg);
          }
        }
      } else {
        // Local echo (Phase 2 will send to server)
        const msg: Message = {
          id: crypto.randomUUID(),
          from: "self",
          fromNick: state.selfNick,
          channel: buf.channel.name,
          content: text,
          timestamp: Date.now(),
          type: "chat",
        };
        addMessage(state, state.activeIndex, msg);
      }

      state.inputState = clearInput(state.inputState);
      state.inputState.prompt = `[${buf.channel.name}] `;
      break;
    }

    default:
      break;
  }
}

// Resolve a clicked row in the buflist to a buffer global index
function resolveClickedBuffer(entries: BuflistEntry[], clickRow: number): number | null {
  // Reconstruct the visual lines to map clickRow to an entry
  const sectionOrder: BufferType[] = ["channel", "dm", "cc_session"];
  let lineIndex = 0;

  for (const section of sectionOrder) {
    const sectionEntries = entries.filter((e) => e.bufferType === section);
    if (sectionEntries.length === 0) continue;

    // Section header line
    if (lineIndex === clickRow) return null; // clicked on header
    lineIndex++;

    for (const entry of sectionEntries) {
      if (lineIndex === clickRow) return entry.globalIndex;
      lineIndex++;
    }
  }

  return null;
}
