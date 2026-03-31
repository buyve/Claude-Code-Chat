// Claude Code PTY integration — full interactive terminal via Bun.Terminal + VTE
// Spawns `claude` in a real PTY, parses output through VTE for region rendering.
// Rendering is NOT done here — caller polls isDirty() on a timer.

import { createVTE } from "./vte.ts";

export interface CCTerminal {
  /** Forward raw keystrokes to Claude Code */
  write(data: string | Uint8Array): void;
  /** Resize PTY + VTE (e.g. on terminal resize or layout change) */
  resize(cols: number, rows: number): void;
  /** Get rendered line from VTE buffer (for rendering in chat region) */
  getLine(row: number): string;
  /** Whether the PTY is still alive */
  isRunning(): boolean;
  /** Kill the process and close PTY */
  close(): void;
  /** VTE dimensions */
  readonly cols: number;
  readonly rows: number;
  /** VTE cursor position */
  readonly cursorRow: number;
  readonly cursorCol: number;
  /** Whether VTE buffer has new data since last clearDirty() */
  isDirty(): boolean;
  /** Reset dirty flag after rendering */
  clearDirty(): void;
  /** Timestamp of last PTY data received (for render debouncing) */
  readonly lastDataTime: number;
  /** Scrollback viewport offset (0 = live, positive = scrolled up) */
  scrollOffset: number;
  /** Number of lines in scrollback buffer */
  readonly scrollbackSize: number;
}

export type ExitHandler = (code: number) => void;

export function createCCTerminal(
  cwd: string,
  cols: number,
  rows: number,
  onExit: ExitHandler,
): CCTerminal {
  const vte = createVTE(cols, rows, 5000);
  let dirty = false;
  let dataTime = 0;

  // Pass through OSC 52 (clipboard) from PTY to real terminal.
  // Without this, Claude Code's clipboard writes are swallowed by the VTE.
  vte.onOSC = (code, data) => {
    if (code === 52) {
      process.stdout.write(`\x1b]52;${data}\x07`);
    }
  };

  const terminal = new Bun.Terminal({
    cols,
    rows,
    data(_term: Bun.Terminal, data: Uint8Array) {
      vte.write(data);
      dirty = true;
      dataTime = performance.now();
    },
  });

  const proc = Bun.spawn(["claude"], {
    cwd,
    terminal,
  });

  proc.exited.then((code) => {
    onExit(code ?? 0);
  });

  return {
    write(data) {
      if (!terminal.closed) terminal.write(data);
    },
    resize(newCols, newRows) {
      if (!terminal.closed) {
        terminal.resize(newCols, newRows);
        vte.resize(newCols, newRows);
      }
    },
    getLine(row) {
      return vte.getLine(row);
    },
    isRunning() {
      return !terminal.closed;
    },
    close() {
      if (!terminal.closed) terminal.close();
      proc.kill();
    },
    get cols() { return vte.cols; },
    get rows() { return vte.rows; },
    get cursorRow() { return vte.cursorRow; },
    get cursorCol() { return vte.cursorCol; },
    isDirty() { return dirty; },
    clearDirty() { dirty = false; },
    get lastDataTime() { return dataTime; },
    get scrollOffset() { return vte.scrollOffset; },
    set scrollOffset(v) { vte.scrollOffset = v; },
    get scrollbackSize() { return vte.scrollbackSize; },
  };
}
