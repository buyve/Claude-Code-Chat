// Custom ANSI layout engine — 6 WeeChat-style regions
// No blessed/ink — raw stdout + ansi-escapes + string-width
// Renders via ScreenBuffer for diff-based flushing

import ansiEscapes from "ansi-escapes";
import cliCursor from "cli-cursor";
import chalk from "chalk";
import { createScreenBuffer, type ScreenBuffer } from "./screen-buffer.ts";
import { fitToWidth, moveTo, stringWidth } from "./ansi-utils.ts";

// Re-export for consumers (chat.ts, etc.)
export { fitToWidth, stringWidth };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Region extends Rect {
  writeLine(row: number, text: string): void;
  writeAt(row: number, col: number, text: string): void;
  clear(): void;
  fillLine(row: number, style: (s: string) => string): void;
  /** Append raw ANSI to the buffer output (cursor positioning, etc.) */
  rawWrite(str: string): void;
}

function createRegion(rect: Rect, buffer: ScreenBuffer): Region {
  return {
    ...rect,
    writeLine(row: number, text: string) {
      if (row < 0 || row >= rect.h) return;
      buffer.writeLine(rect.x, rect.y + row, rect.w, text);
    },
    writeAt(row: number, col: number, text: string) {
      if (row < 0 || row >= rect.h) return;
      if (col < 0 || col >= rect.w) return;
      const maxW = rect.w - col;
      buffer.writeAt(rect.x, rect.y + row, col, maxW, text);
    },
    clear() {
      for (let r = 0; r < rect.h; r++) {
        buffer.writeLine(rect.x, rect.y + r, rect.w, "");
      }
    },
    fillLine(row: number, style: (s: string) => string) {
      if (row < 0 || row >= rect.h) return;
      buffer.fillLine(rect.x, rect.y + row, rect.w, style(" ".repeat(rect.w)));
    },
    rawWrite(str: string) {
      buffer.writeRaw(str);
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
  buffer: ScreenBuffer;
  recalculate(): void;
  render(): void;
  flush(): void;
  invalidateAll(): void;
}

const MIN_COLS = 80;
const MIN_ROWS = 24;
const BUFLIST_W = 20;
const NICKLIST_W = 24;

function computeRegions(cols: number, rows: number) {
  const bodyH = rows - 3;
  const blW = BUFLIST_W - 1;
  const nlW = NICKLIST_W - 1;
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
  const buffer = createScreenBuffer(cols, rows);

  let rects = computeRegions(cols, rows);
  let buflist = createRegion(rects.buflist, buffer);
  let titlebar = createRegion(rects.titlebar, buffer);
  let chat = createRegion(rects.chat, buffer);
  let nicklist = createRegion(rects.nicklist, buffer);
  let statusbar = createRegion(rects.statusbar, buffer);
  let input = createRegion(rects.input, buffer);

  function recalculate() {
    cols = process.stdout.columns || 80;
    rows = process.stdout.rows || 24;

    buffer.resize(cols, rows);

    rects = computeRegions(cols, rows);
    buflist = createRegion(rects.buflist, buffer);
    titlebar = createRegion(rects.titlebar, buffer);
    chat = createRegion(rects.chat, buffer);
    nicklist = createRegion(rects.nicklist, buffer);
    statusbar = createRegion(rects.statusbar, buffer);
    input = createRegion(rects.input, buffer);

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
    // Draw vertical borders between regions via raw writes
    const borderChar = chalk.dim("│");
    for (let r = 1; r < rows - 2; r++) {
      buffer.writeRaw(moveTo(BUFLIST_W - 1, r) + borderChar);
      buffer.writeRaw(moveTo(cols - NICKLIST_W, r) + borderChar);
    }
  }

  function flush() {
    buffer.flush();
  }

  function invalidateAll() {
    buffer.invalidateAll();
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
    buffer,
    recalculate,
    render,
    flush,
    invalidateAll,
  };

  return layout;
}

// Terminal lifecycle management

export function enterScreen() {
  process.stdout.write("\x1b[?1049h");
  process.stdout.write(ansiEscapes.clearScreen);
  cliCursor.hide();
}

export function exitScreen() {
  cliCursor.show();
  process.stdout.write("\x1b[?1049l");
}

export function isTooSmall(): boolean {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  return cols < MIN_COLS || rows < MIN_ROWS;
}
