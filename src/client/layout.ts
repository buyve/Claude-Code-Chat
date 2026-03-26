// Custom ANSI layout engine — 6 WeeChat-style regions
// No blessed/ink — raw stdout + ansi-escapes + string-width

import ansiEscapes from "ansi-escapes";
import stringWidth from "string-width";
import cliCursor from "cli-cursor";
import chalk from "chalk";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Region extends Rect {
  writeLine(row: number, text: string): void;
  clear(): void;
  fillLine(row: number, style: (s: string) => string): void;
}

// Write directly to stdout, bypassing buffering for perf
const write = (s: string) => process.stdout.write(s);

function moveTo(col: number, row: number): string {
  return ansiEscapes.cursorTo(col, row);
}

// ANSI SGR escape sequence pattern (covers chalk output)
const ANSI_RE = /\x1b\[[0-9;]*m/;

// Truncate/pad a string to exactly `width` visible columns.
// ANSI-aware: preserves escape sequences, appends reset on truncation.
export function fitToWidth(text: string, width: number): string {
  const w = stringWidth(text);
  if (w === width) return text;
  if (w < width) return text + " ".repeat(width - w);

  // Truncate: walk the string, skip ANSI sequences, count visible chars
  let visibleW = 0;
  let i = 0;
  while (i < text.length && visibleW < width) {
    // Skip ANSI escape sequences (zero visual width)
    if (text[i] === "\x1b") {
      const match = text.slice(i).match(ANSI_RE);
      if (match && text.slice(i).indexOf(match[0]) === 0) {
        i += match[0].length;
        continue;
      }
    }
    // Measure full code-point character
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = stringWidth(ch);
    if (visibleW + cw > width) break;
    visibleW += cw;
    i += ch.length;
  }

  // Collect any trailing ANSI codes right after the cut point
  let tail = "";
  while (i < text.length && text[i] === "\x1b") {
    const match = text.slice(i).match(ANSI_RE);
    if (match && text.slice(i).indexOf(match[0]) === 0) {
      tail += match[0];
      i += match[0].length;
    } else {
      break;
    }
  }

  // Reset styles to prevent color bleed into adjacent regions, then pad
  return text.slice(0, i - (tail ? tail.length : 0)) + "\x1b[0m" + " ".repeat(width - visibleW);
}

function createRegion(rect: Rect): Region {
  return {
    ...rect,
    writeLine(row: number, text: string) {
      if (row < 0 || row >= rect.h) return;
      const fitted = fitToWidth(text, rect.w);
      write(moveTo(rect.x, rect.y + row) + fitted);
    },
    clear() {
      const blank = " ".repeat(rect.w);
      for (let r = 0; r < rect.h; r++) {
        write(moveTo(rect.x, rect.y + r) + blank);
      }
    },
    fillLine(row: number, style: (s: string) => string) {
      if (row < 0 || row >= rect.h) return;
      write(moveTo(rect.x, rect.y + row) + style(" ".repeat(rect.w)));
    },
  };
}

export interface Layout {
  buflist: Region;
  titlebar: Region;
  chat: Region;
  nicklist: Region;
  statusbar: Region;
  input: Region;
  cols: number;
  rows: number;
  recalculate(): void;
  render(): void;
}

const MIN_COLS = 80;
const MIN_ROWS = 24;
const BUFLIST_W = 20;
const NICKLIST_W = 16;

// Compute region rects accounting for 1-col borders between panels
function computeRegions(cols: number, rows: number) {
  const bodyH = rows - 3; // rows minus titlebar(1) + statusbar(1) + input(1)
  // Buflist: 1 col narrower to leave room for left border
  const blW = BUFLIST_W - 1;
  // Nicklist: 1 col narrower to leave room for right border
  const nlW = NICKLIST_W - 1;
  // Chat fills the middle (between two border columns)
  const chatX = BUFLIST_W;
  const chatW = cols - BUFLIST_W - NICKLIST_W;
  const nlX = cols - NICKLIST_W + 1;

  return {
    buflist: { x: 0, y: 1, w: blW, h: bodyH },
    titlebar: { x: BUFLIST_W, y: 0, w: cols - BUFLIST_W, h: 1 },
    chat: { x: chatX, y: 1, w: chatW, h: bodyH },
    nicklist: { x: nlX, y: 1, w: nlW, h: bodyH },
    statusbar: { x: 0, y: rows - 2, w: cols, h: 1 },
    input: { x: 0, y: rows - 1, w: cols, h: 1 },
  };
}

export function createLayout(): Layout {
  let cols = process.stdout.columns || 80;
  let rows = process.stdout.rows || 24;

  let rects = computeRegions(cols, rows);
  let buflist = createRegion(rects.buflist);
  let titlebar = createRegion(rects.titlebar);
  let chat = createRegion(rects.chat);
  let nicklist = createRegion(rects.nicklist);
  let statusbar = createRegion(rects.statusbar);
  let input = createRegion(rects.input);

  function recalculate() {
    cols = process.stdout.columns || 80;
    rows = process.stdout.rows || 24;

    rects = computeRegions(cols, rows);
    buflist = createRegion(rects.buflist);
    titlebar = createRegion(rects.titlebar);
    chat = createRegion(rects.chat);
    nicklist = createRegion(rects.nicklist);
    statusbar = createRegion(rects.statusbar);
    input = createRegion(rects.input);

    layout.buflist = buflist;
    layout.titlebar = titlebar;
    layout.chat = chat;
    layout.nicklist = nicklist;
    layout.statusbar = statusbar;
    layout.input = input;
    layout.cols = cols;
    layout.rows = rows;
  }

  function render() {
    // Draw vertical borders between regions (dedicated border columns)
    const borderChar = chalk.dim("│");
    for (let r = 1; r < rows - 2; r++) {
      // Border between buflist and chat (col = BUFLIST_W - 1)
      write(moveTo(BUFLIST_W - 1, r) + borderChar);
      // Border between chat and nicklist (col = cols - NICKLIST_W)
      write(moveTo(cols - NICKLIST_W, r) + borderChar);
    }
  }

  const layout: Layout = {
    buflist,
    titlebar,
    chat,
    nicklist,
    statusbar,
    input,
    cols,
    rows,
    recalculate,
    render,
  };

  return layout;
}

// Terminal lifecycle management

export function enterScreen() {
  write("\x1b[?1049h"); // Alternate screen buffer
  write(ansiEscapes.clearScreen);
  cliCursor.hide();
}

export function exitScreen() {
  cliCursor.show();
  write("\x1b[?1049l"); // Exit alternate screen
}

export function isTooSmall(): boolean {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  return cols < MIN_COLS || rows < MIN_ROWS;
}

export { stringWidth };
