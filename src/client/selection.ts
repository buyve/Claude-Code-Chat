// Text selection — drag-to-select + clipboard copy via OSC 52
// Adapted from Ink's selection.ts patterns

import stringWidth from "string-width";

export interface SelectionPoint {
  row: number; // screen row (absolute)
  col: number; // screen column (absolute)
}

export interface SelectionState {
  anchor: SelectionPoint | null; // where mouse-down occurred
  focus: SelectionPoint | null;  // current drag end
  isDragging: boolean;
}

export function createSelection(): SelectionState {
  return { anchor: null, focus: null, isDragging: false };
}

export function startSelection(
  sel: SelectionState,
  col: number,
  row: number,
): void {
  sel.anchor = { row, col };
  sel.focus = { row, col };
  sel.isDragging = true;
}

export function updateSelection(
  sel: SelectionState,
  col: number,
  row: number,
): void {
  if (!sel.isDragging) return;
  sel.focus = { row, col };
}

export function finishSelection(sel: SelectionState): void {
  sel.isDragging = false;
}

export function clearSelection(sel: SelectionState): void {
  sel.anchor = null;
  sel.focus = null;
  sel.isDragging = false;
}

/** True only if there's a real selection (not just a single-point click) */
export function hasSelection(sel: SelectionState): boolean {
  if (!sel.anchor || !sel.focus) return false;
  return sel.anchor.row !== sel.focus.row || sel.anchor.col !== sel.focus.col;
}

/** Get selection bounds ordered top-left → bottom-right */
export function selectionBounds(sel: SelectionState): {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} | null {
  if (!sel.anchor || !sel.focus) return null;
  const a = sel.anchor;
  const b = sel.focus;

  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) {
    return { startRow: a.row, startCol: a.col, endRow: b.row, endCol: b.col };
  }
  return { startRow: b.row, startCol: b.col, endRow: a.row, endCol: a.col };
}

/**
 * Apply SGR 7 (inverse) to a range of visible columns in an ANSI string.
 * Walks visible chars, inserts inverse on/off at the right column positions.
 */
export function invertRange(
  text: string,
  startCol: number,
  endCol: number,
  regionWidth: number,
): string {
  if (startCol >= endCol || startCol >= regionWidth) return text;
  const clampEnd = Math.min(endCol, regionWidth);

  const ANSI_RE = /^\x1b\[[0-9;]*m/;
  let result = "";
  let visibleCol = 0;
  let i = 0;
  let inverted = false;

  while (i < text.length) {
    // Pass through ANSI escape sequences
    if (text[i] === "\x1b") {
      const match = text.slice(i).match(ANSI_RE);
      if (match) {
        result += match[0];
        i += match[0].length;
        continue;
      }
    }

    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = stringWidth(ch);

    // Start inverse at startCol
    if (!inverted && visibleCol >= startCol && visibleCol < clampEnd) {
      result += "\x1b[7m";
      inverted = true;
    }

    // End inverse at endCol
    if (inverted && visibleCol >= clampEnd) {
      result += "\x1b[27m";
      inverted = false;
    }

    result += ch;
    visibleCol += cw;
    i += ch.length;
  }

  // Close inverse if still open
  if (inverted) result += "\x1b[27m";
  return result;
}

/**
 * Copy text to system clipboard — adapted from Ink's osc.ts setClipboard().
 * Path priority: native (pbcopy) > tmux buffer > OSC 52.
 */
export function copyToClipboard(text: string): void {
  // Path 1: Native clipboard — most reliable, fire first (Ink's pattern)
  if (!process.env["SSH_CONNECTION"]) {
    copyNative(text);
  }

  // Path 2: Tmux buffer — works over SSH, survives detach/reattach
  if (process.env["TMUX"]) {
    const proc = Bun.spawn(["tmux", "load-buffer", "-w", "-"], { stdin: "pipe" });
    proc.stdin.write(text);
    proc.stdin.end();
  }

  // Path 3: OSC 52 — terminal escape sequence (wrapped for tmux if needed)
  const b64 = Buffer.from(text, "utf-8").toString("base64");
  if (process.env["TMUX"]) {
    const inner = `\x1b]52;c;${b64}\x07`;
    const escaped = inner.replaceAll("\x1b", "\x1b\x1b");
    process.stdout.write(`\x1bPtmux;${escaped}\x1b\\`);
  } else {
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
  }
}

function copyNative(text: string): void {
  if (process.platform === "darwin") {
    try {
      const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
      proc.stdin.write(text);
      proc.stdin.end();
    } catch { /* pbcopy not available */ }
    return;
  }
  // Linux: try wl-copy, xclip, xsel in order
  for (const cmd of [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ]) {
    try {
      const proc = Bun.spawn(cmd, { stdin: "pipe" });
      proc.stdin.write(text);
      proc.stdin.end();
      return;
    } catch { /* not available, try next */ }
  }
}
