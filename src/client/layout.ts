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

// Truncate/pad a string to exactly `width` visible columns
export function fitToWidth(text: string, width: number): string {
  const w = stringWidth(text);
  if (w === width) return text;
  if (w > width) {
    // Truncate: walk chars until we reach width
    let acc = 0;
    let i = 0;
    for (; i < text.length; i++) {
      const cw = stringWidth(text[i]!);
      if (acc + cw > width) break;
      acc += cw;
    }
    // Pad remaining with spaces if CJK char was cut
    return text.slice(0, i) + " ".repeat(width - acc);
  }
  // Pad with spaces
  return text + " ".repeat(width - w);
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

export function createLayout(): Layout {
  let cols = process.stdout.columns || 80;
  let rows = process.stdout.rows || 24;

  let buflist = createRegion({ x: 0, y: 1, w: BUFLIST_W, h: rows - 3 });
  let titlebar = createRegion({ x: BUFLIST_W, y: 0, w: cols - BUFLIST_W, h: 1 });
  let chat = createRegion({
    x: BUFLIST_W,
    y: 1,
    w: cols - BUFLIST_W - NICKLIST_W,
    h: rows - 3,
  });
  let nicklist = createRegion({
    x: cols - NICKLIST_W,
    y: 1,
    w: NICKLIST_W,
    h: rows - 3,
  });
  let statusbar = createRegion({ x: 0, y: rows - 2, w: cols, h: 1 });
  let input = createRegion({ x: 0, y: rows - 1, w: cols, h: 1 });

  function recalculate() {
    cols = process.stdout.columns || 80;
    rows = process.stdout.rows || 24;

    buflist = createRegion({ x: 0, y: 1, w: BUFLIST_W, h: rows - 3 });
    titlebar = createRegion({ x: BUFLIST_W, y: 0, w: cols - BUFLIST_W, h: 1 });
    chat = createRegion({
      x: BUFLIST_W,
      y: 1,
      w: cols - BUFLIST_W - NICKLIST_W,
      h: rows - 3,
    });
    nicklist = createRegion({
      x: cols - NICKLIST_W,
      y: 1,
      w: NICKLIST_W,
      h: rows - 3,
    });
    statusbar = createRegion({ x: 0, y: rows - 2, w: cols, h: 1 });
    input = createRegion({ x: 0, y: rows - 1, w: cols, h: 1 });

    // Re-expose updated regions
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
    // Draw vertical borders between regions
    const borderChar = chalk.dim("│");
    for (let r = 1; r < rows - 2; r++) {
      // Border between buflist and chat
      write(moveTo(BUFLIST_W - 1, r) + borderChar);
      // Border between chat and nicklist
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
