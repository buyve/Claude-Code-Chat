// Input widget — single-line text input with history, tab completion, readline

import stringWidth from "string-width";
import ansiEscapes from "ansi-escapes";
import type { Region } from "../layout.ts";
import chalk from "chalk";

export interface InputState {
  text: string;
  cursor: number; // character index (not byte)
  prompt: string; // e.g. "[#general] "
}

// --- History ---

export interface History {
  entries: string[];
  index: number; // -1 = current input, 0+ = browsing history
  maxSize: number;
  savedInput: string; // input text saved when entering history browse
}

export function createHistory(maxSize = 100): History {
  return { entries: [], index: -1, maxSize, savedInput: "" };
}

export function historyAdd(h: History, text: string) {
  // Duplicate prevention — remove existing occurrence, then prepend
  const existing = h.entries.indexOf(text);
  if (existing !== -1) h.entries.splice(existing, 1);
  h.entries.unshift(text);
  if (h.entries.length > h.maxSize) h.entries.pop();
  h.index = -1;
  h.savedInput = "";
}

export function historyPrev(h: History, currentText: string): string | null {
  if (h.entries.length === 0) return null;
  if (h.index === -1) {
    h.savedInput = currentText;
    h.index = 0;
    return h.entries[0] ?? null;
  }
  if (h.index < h.entries.length - 1) {
    h.index++;
    return h.entries[h.index] ?? null;
  }
  return null; // at oldest
}

export function historyNext(h: History): string | null {
  if (h.index <= -1) return null;
  h.index--;
  if (h.index === -1) {
    return h.savedInput;
  }
  return h.entries[h.index] ?? null;
}

// --- Tab completion ---

export interface CompletionContext {
  candidates: string[];
  cycleIndex: number;
  startPos: number;
  prefix: string;
  appliedLength: number; // length of the currently applied candidate (including suffix)
}

export function tabComplete(
  text: string,
  cursor: number,
  nicks: string[],
  channels: string[],
  commands: string[],
): CompletionContext | null {
  // Find word being typed (from cursor backwards to space or start)
  let start = cursor;
  while (start > 0 && text[start - 1] !== " ") start--;
  const prefix = text.slice(start, cursor).toLowerCase();
  if (prefix.length === 0) return null;

  let candidates: string[];

  if (prefix.startsWith("/")) {
    // Command completion
    const cmdPrefix = prefix.slice(1);
    candidates = commands
      .filter((c) => c.toLowerCase().startsWith(cmdPrefix))
      .map((c) => `/${c}`);
  } else if (prefix.startsWith("#")) {
    // Channel completion
    candidates = channels.filter((c) =>
      c.toLowerCase().startsWith(prefix),
    );
  } else {
    // Nick completion
    candidates = nicks.filter((n) =>
      n.toLowerCase().startsWith(prefix),
    );
  }

  if (candidates.length === 0) return null;

  return { candidates, cycleIndex: 0, startPos: start, prefix, appliedLength: prefix.length };
}

export function applyCompletion(
  text: string,
  ctx: CompletionContext,
): { text: string; cursor: number } {
  const candidate = ctx.candidates[ctx.cycleIndex % ctx.candidates.length];
  if (!candidate) return { text, cursor: text.length };

  const before = text.slice(0, ctx.startPos);
  const after = text.slice(ctx.startPos + ctx.appliedLength);
  // Add space after completion if at end of input
  const suffix = after.length === 0 ? " " : "";
  const newText = before + candidate + suffix + after;
  const newCursor = ctx.startPos + candidate.length + suffix.length;

  // Track the applied length for next cycle
  ctx.appliedLength = candidate.length + suffix.length;

  return { text: newText, cursor: newCursor };
}

// --- Rendering ---

export function renderInput(region: Region, state: InputState) {
  const { text, cursor, prompt } = state;
  const promptW = stringWidth(prompt);
  const availableW = region.w - promptW;

  // Scroll input text if cursor would be off-screen
  let displayStart = 0;
  const cursorVisualPos = stringWidth(text.slice(0, cursor));
  if (cursorVisualPos >= availableW) {
    // Find start position that puts cursor near the right
    let acc = 0;
    for (let i = 0; i < text.length; i++) {
      const cw = stringWidth(text[i]!);
      if (cursorVisualPos - acc < availableW - 2) {
        displayStart = i;
        break;
      }
      acc += cw;
    }
  }

  const displayText = text.slice(displayStart);
  const line = chalk.cyan(prompt) + displayText;
  region.writeLine(0, line);

  // Position hardware cursor via screen buffer
  const cursorCol =
    region.x + promptW + stringWidth(text.slice(displayStart, cursor));
  region.rawWrite(ansiEscapes.cursorTo(cursorCol, region.y));
}

// --- Input text manipulation ---

export function insertChar(state: InputState, ch: string): InputState {
  const before = state.text.slice(0, state.cursor);
  const after = state.text.slice(state.cursor);
  return { ...state, text: before + ch + after, cursor: state.cursor + ch.length };
}

export function deleteBack(state: InputState): InputState {
  if (state.cursor === 0) return state;
  const before = state.text.slice(0, state.cursor - 1);
  const after = state.text.slice(state.cursor);
  return { ...state, text: before + after, cursor: state.cursor - 1 };
}

export function deleteForward(state: InputState): InputState {
  if (state.cursor >= state.text.length) return state;
  const before = state.text.slice(0, state.cursor);
  const after = state.text.slice(state.cursor + 1);
  return { ...state, text: before + after };
}

export function moveCursorLeft(state: InputState): InputState {
  return { ...state, cursor: Math.max(0, state.cursor - 1) };
}

export function moveCursorRight(state: InputState): InputState {
  return { ...state, cursor: Math.min(state.text.length, state.cursor + 1) };
}

export function moveCursorHome(state: InputState): InputState {
  return { ...state, cursor: 0 };
}

export function moveCursorEnd(state: InputState): InputState {
  return { ...state, cursor: state.text.length };
}

export function deleteWordBack(state: InputState): InputState {
  // Delete from cursor back to previous word boundary
  let pos = state.cursor;
  // Skip trailing spaces
  while (pos > 0 && state.text[pos - 1] === " ") pos--;
  // Skip word chars
  while (pos > 0 && state.text[pos - 1] !== " ") pos--;
  const before = state.text.slice(0, pos);
  const after = state.text.slice(state.cursor);
  return { ...state, text: before + after, cursor: pos };
}

export function deleteToEnd(state: InputState): InputState {
  return { ...state, text: state.text.slice(0, state.cursor) };
}

export function deleteToStart(state: InputState): InputState {
  return { ...state, text: state.text.slice(state.cursor), cursor: 0 };
}

export function clearInput(state: InputState): InputState {
  return { ...state, text: "", cursor: 0 };
}
