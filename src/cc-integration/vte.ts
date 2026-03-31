// Minimal Virtual Terminal Emulator — parses ANSI output into a 2D character buffer.
// Used to render PTY output (like Claude Code) into a region of CCC's TUI.
// Analogous to what tmux does for each pane.

/** Fast wide-character detection for CJK, Hangul, Fullwidth, Emoji. */
function wcwidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33bf) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1ffff) ||
    (cp >= 0x20000 && cp <= 0x3ffff)
  ) return 2;
  return 1;
}

interface Cell {
  ch: string;
  wide: boolean; // true = this is a wide char occupying 2 columns
  cont: boolean; // true = continuation cell (right half of a wide char)
  fg: number; // -1 = default, 0-255 = 256-color, 0x1000000+ = 24-bit
  bg: number;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
}

function emptyCell(): Cell {
  return { ch: " ", wide: false, cont: false, fg: -1, bg: -1, bold: false, dim: false, italic: false, underline: false, reverse: false };
}

function cloneCell(c: Cell): Cell {
  return { ...c };
}

export interface VTE {
  write(data: Uint8Array | string): void;
  getLine(row: number): string;
  resize(cols: number, rows: number): void;
  readonly cols: number;
  readonly rows: number;
  readonly cursorRow: number;
  readonly cursorCol: number;
  /** Viewport offset: 0 = live screen, positive = scrolled into history */
  scrollOffset: number;
  /** Number of lines in scrollback buffer */
  readonly scrollbackSize: number;
  /** Callback fired for OSC sequences (e.g. OSC 52 clipboard) */
  onOSC?: (code: number, data: string) => void;
}

export function createVTE(initCols: number, initRows: number, scrollbackLimit: number = 0): VTE {
  let cols = initCols;
  let rows = initRows;
  let buf = makeBuffer(cols, rows);
  let altBuf: Cell[][] | null = null;
  const scrollback: Cell[][] = [];
  let viewOffset = 0;

  let cr = 0; // cursor row
  let cc = 0; // cursor col
  let savedCr = 0;
  let savedCc = 0;
  let scrollTop = 0;
  let scrollBottom = rows - 1;

  // Current style
  let fg = -1;
  let bg = -1;
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;
  let reverse = false;

  // Parser state
  let state: "normal" | "esc" | "csi" | "osc" | "scs" | "dcs" = "normal";
  let csiParams = "";
  let oscData = "";

  function makeBuffer(c: number, r: number): Cell[][] {
    const b: Cell[][] = [];
    for (let i = 0; i < r; i++) {
      const row: Cell[] = [];
      for (let j = 0; j < c; j++) row.push(emptyCell());
      b.push(row);
    }
    return b;
  }

  function scrollUp() {
    // Save top line to scrollback when scroll region starts at row 0
    if (scrollTop === 0 && scrollbackLimit > 0) {
      scrollback.push(buf[0]!.map(cloneCell));
      if (scrollback.length > scrollbackLimit) scrollback.shift();
    }
    buf.splice(scrollTop, 1);
    const row: Cell[] = [];
    for (let j = 0; j < cols; j++) row.push(emptyCell());
    buf.splice(scrollBottom, 0, row);
  }

  function scrollDown() {
    buf.splice(scrollBottom, 1);
    const row: Cell[] = [];
    for (let j = 0; j < cols; j++) row.push(emptyCell());
    buf.splice(scrollTop, 0, row);
  }

  function putChar(ch: string) {
    const w = wcwidth(ch);
    if (w === 0) return; // skip zero-width

    if (cc + w > cols) {
      // Auto-wrap: fill remaining cols with spaces, move to next line
      for (let i = cc; i < cols; i++) eraseCell(cr, i);
      cc = 0;
      cr++;
      if (cr > scrollBottom) {
        cr = scrollBottom;
        scrollUp();
      }
    }
    if (cr >= 0 && cr < rows && cc >= 0 && cc < cols) {
      // If overwriting a wide char's left half, erase its right half
      const existing = buf[cr]![cc]!;
      if (existing.cont && cc > 0) {
        buf[cr]![cc - 1]!.ch = " ";
        buf[cr]![cc - 1]!.wide = false;
      }
      // If overwriting a wide char's right continuation, erase its left half
      if (existing.wide && cc + 1 < cols) {
        buf[cr]![cc + 1]!.ch = " ";
        buf[cr]![cc + 1]!.cont = false;
      }

      const cell = buf[cr]![cc]!;
      cell.ch = ch;
      cell.wide = w === 2;
      cell.cont = false;
      cell.fg = fg;
      cell.bg = bg;
      cell.bold = bold;
      cell.dim = dim;
      cell.italic = italic;
      cell.underline = underline;
      cell.reverse = reverse;

      // Wide char: mark next cell as continuation
      if (w === 2 && cc + 1 < cols) {
        const next = buf[cr]![cc + 1]!;
        next.ch = "";
        next.wide = false;
        next.cont = true;
        next.fg = fg;
        next.bg = bg;
        next.bold = bold;
        next.dim = dim;
        next.italic = italic;
        next.underline = underline;
        next.reverse = reverse;
      }
    }
    cc += w;
  }

  function eraseCell(r: number, c: number) {
    if (r >= 0 && r < rows && c >= 0 && c < cols) {
      buf[r]![c] = emptyCell();
    }
  }

  function execCSI(params: string, cmd: string) {
    // DEC private mode sequences (?, >, !) — only handle h/l
    const hasPrefix = /[?!>]/.test(params);
    if (hasPrefix) {
      if (cmd === "h" || cmd === "l") {
        const modeStr = params.replace(/[?!>]/g, "");
        const modes = modeStr.split(";").map((s) => parseInt(s, 10));
        for (const mode of modes) {
          if (isNaN(mode)) continue;
          if (cmd === "h" && mode === 1049) {
            altBuf = buf;
            buf = makeBuffer(cols, rows);
            cr = 0; cc = 0;
            scrollTop = 0; scrollBottom = rows - 1;
          } else if (cmd === "l" && mode === 1049 && altBuf) {
            buf = altBuf;
            altBuf = null;
          }
        }
      }
      return; // Skip all other prefixed CSI sequences
    }

    const parts = params.split(";").map((s) => (s === "" ? 0 : parseInt(s, 10)));
    const p0 = parts[0] ?? 0;
    const p1 = parts[1] ?? 0;

    switch (cmd) {
      case "H": // CUP - cursor position
      case "f":
        cr = Math.max(0, Math.min(rows - 1, (p0 || 1) - 1));
        cc = Math.max(0, Math.min(cols - 1, (p1 || 1) - 1));
        break;
      case "A": // CUU - cursor up
        cr = Math.max(scrollTop, cr - (p0 || 1));
        break;
      case "B": // CUD - cursor down
        cr = Math.min(scrollBottom, cr + (p0 || 1));
        break;
      case "C": // CUF - cursor right
        cc = Math.min(cols - 1, cc + (p0 || 1));
        break;
      case "D": // CUB - cursor left
        cc = Math.max(0, cc - (p0 || 1));
        break;
      case "G": // CHA - cursor horizontal absolute
        cc = Math.max(0, Math.min(cols - 1, (p0 || 1) - 1));
        break;
      case "d": // VPA - cursor vertical absolute
        cr = Math.max(0, Math.min(rows - 1, (p0 || 1) - 1));
        break;
      case "E": // CNL - cursor next line
        cr = Math.min(scrollBottom, cr + (p0 || 1));
        cc = 0;
        break;
      case "F": // CPL - cursor previous line
        cr = Math.max(scrollTop, cr - (p0 || 1));
        cc = 0;
        break;
      case "J": // ED - erase display
        if (p0 === 0) {
          // Erase from cursor to end
          for (let c = cc; c < cols; c++) eraseCell(cr, c);
          for (let r = cr + 1; r < rows; r++)
            for (let c = 0; c < cols; c++) eraseCell(r, c);
        } else if (p0 === 1) {
          // Erase from start to cursor
          for (let r = 0; r < cr; r++)
            for (let c = 0; c < cols; c++) eraseCell(r, c);
          for (let c = 0; c <= cc; c++) eraseCell(cr, c);
        } else if (p0 === 2 || p0 === 3) {
          // Erase all
          for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++) eraseCell(r, c);
        }
        break;
      case "K": // EL - erase line
        if (p0 === 0) {
          for (let c = cc; c < cols; c++) eraseCell(cr, c);
        } else if (p0 === 1) {
          for (let c = 0; c <= cc; c++) eraseCell(cr, c);
        } else if (p0 === 2) {
          for (let c = 0; c < cols; c++) eraseCell(cr, c);
        }
        break;
      case "r": // DECSTBM - set scroll region
        scrollTop = Math.max(0, (p0 || 1) - 1);
        scrollBottom = Math.min(rows - 1, (p1 || rows) - 1);
        cr = 0;
        cc = 0;
        break;
      case "S": // SU - scroll up
        for (let i = 0; i < (p0 || 1); i++) scrollUp();
        break;
      case "T": // SD - scroll down
        for (let i = 0; i < (p0 || 1); i++) scrollDown();
        break;
      case "L": // IL - insert lines
        for (let i = 0; i < (p0 || 1); i++) {
          const row: Cell[] = [];
          for (let j = 0; j < cols; j++) row.push(emptyCell());
          buf.splice(cr, 0, row);
          if (buf.length > rows) buf.splice(scrollBottom + 1, 1);
        }
        break;
      case "M": // DL - delete lines
        for (let i = 0; i < (p0 || 1); i++) {
          buf.splice(cr, 1);
          const row: Cell[] = [];
          for (let j = 0; j < cols; j++) row.push(emptyCell());
          buf.splice(scrollBottom, 0, row);
        }
        break;
      case "X": // ECH - erase characters
        for (let i = 0; i < (p0 || 1) && cc + i < cols; i++) eraseCell(cr, cc + i);
        break;
      case "m": // SGR - select graphic rendition
        parseSGR(parts);
        break;
      case "s": // SCP - save cursor position
        savedCr = cr;
        savedCc = cc;
        break;
      case "u": // RCP - restore cursor position
        cr = savedCr;
        cc = savedCc;
        break;
      // h/l with ? prefix already handled above; plain h/l (SM/RM) ignored
      // Ignore unknown
    }
  }

  function parseSGR(parts: number[]) {
    let i = 0;
    while (i < parts.length) {
      const p = parts[i]!;
      if (isNaN(p)) { i++; continue; }
      if (p === 0) {
        fg = -1; bg = -1; bold = false; dim = false;
        italic = false; underline = false; reverse = false;
      } else if (p === 1) bold = true;
      else if (p === 2) dim = true;
      else if (p === 3) italic = true;
      else if (p === 4) underline = true;
      else if (p === 7) reverse = true;
      else if (p === 22) { bold = false; dim = false; }
      else if (p === 23) italic = false;
      else if (p === 24) underline = false;
      else if (p === 27) reverse = false;
      else if (p >= 30 && p <= 37) fg = p - 30;
      else if (p === 38) {
        // Extended fg: 38;5;n or 38;2;r;g;b
        if (parts[i + 1] === 5 && parts[i + 2] !== undefined) {
          fg = parts[i + 2]!; i += 2;
        } else if (parts[i + 1] === 2 && parts[i + 4] !== undefined) {
          fg = 0x1000000 | ((parts[i + 2]! & 0xff) << 16) | ((parts[i + 3]! & 0xff) << 8) | (parts[i + 4]! & 0xff);
          i += 4;
        }
      } else if (p === 39) fg = -1;
      else if (p >= 40 && p <= 47) bg = p - 40;
      else if (p === 48) {
        if (parts[i + 1] === 5 && parts[i + 2] !== undefined) {
          bg = parts[i + 2]!; i += 2;
        } else if (parts[i + 1] === 2 && parts[i + 4] !== undefined) {
          bg = 0x1000000 | ((parts[i + 2]! & 0xff) << 16) | ((parts[i + 3]! & 0xff) << 8) | (parts[i + 4]! & 0xff);
          i += 4;
        }
      } else if (p === 49) bg = -1;
      else if (p >= 90 && p <= 97) fg = p - 90 + 8;
      else if (p >= 100 && p <= 107) bg = p - 100 + 8;
      i++;
    }
  }

  function styleToAnsi(cell: Cell): string {
    const parts: string[] = [];
    const c = cell.reverse ? cell : cell;
    const fgVal = c.reverse ? c.bg : c.fg;
    const bgVal = c.reverse ? c.fg : c.bg;

    if (c.bold) parts.push("1");
    if (c.dim) parts.push("2");
    if (c.italic) parts.push("3");
    if (c.underline) parts.push("4");

    if (fgVal >= 0 && fgVal < 8) parts.push(String(30 + fgVal));
    else if (fgVal >= 8 && fgVal < 16) parts.push(String(90 + fgVal - 8));
    else if (fgVal >= 16 && fgVal < 256) parts.push(`38;5;${fgVal}`);
    else if (fgVal >= 0x1000000) {
      const r = (fgVal >> 16) & 0xff, g = (fgVal >> 8) & 0xff, b = fgVal & 0xff;
      parts.push(`38;2;${r};${g};${b}`);
    }

    if (bgVal >= 0 && bgVal < 8) parts.push(String(40 + bgVal));
    else if (bgVal >= 8 && bgVal < 16) parts.push(String(100 + bgVal - 8));
    else if (bgVal >= 16 && bgVal < 256) parts.push(`48;5;${bgVal}`);
    else if (bgVal >= 0x1000000) {
      const r = (bgVal >> 16) & 0xff, g = (bgVal >> 8) & 0xff, b = bgVal & 0xff;
      parts.push(`48;2;${r};${g};${b}`);
    }

    return parts.length > 0 ? `\x1b[${parts.join(";")}m` : "";
  }

  function sameStyle(a: Cell, b: Cell): boolean {
    return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold &&
      a.dim === b.dim && a.italic === b.italic &&
      a.underline === b.underline && a.reverse === b.reverse;
  }

  function processChar(ch: string) {
    const code = ch.charCodeAt(0);

    if (state === "normal") {
      if (code === 0x1b) { state = "esc"; return; }
      if (code === 0x0a) { // LF
        cr++;
        if (cr > scrollBottom) { cr = scrollBottom; scrollUp(); }
        return;
      }
      if (code === 0x0d) { cc = 0; return; } // CR
      if (code === 0x08) { cc = Math.max(0, cc - 1); return; } // BS
      if (code === 0x09) { // TAB
        cc = Math.min(cols - 1, (Math.floor(cc / 8) + 1) * 8);
        return;
      }
      if (code === 0x07) return; // BEL
      if (code < 0x20) return; // Other control chars
      putChar(ch);
      return;
    }

    if (state === "esc") {
      if (ch === "[") { state = "csi"; csiParams = ""; return; }
      if (ch === "]") { state = "osc"; oscData = ""; return; }
      if (ch === "P") { state = "dcs"; return; } // DCS - skip until ST
      if (ch === "7") { savedCr = cr; savedCc = cc; state = "normal"; return; } // DECSC
      if (ch === "8") { cr = savedCr; cc = savedCc; state = "normal"; return; } // DECRC
      // Character set designation: ESC ( X, ESC ) X, ESC * X, ESC + X
      if (ch === "(" || ch === ")" || ch === "*" || ch === "+") { state = "scs"; return; }
      // Keypad modes, other single-char ESC sequences
      if (ch === "=" || ch === ">" || ch === "N" || ch === "O") { state = "normal"; return; }
      if (ch === "M") { // RI - reverse index
        cr--;
        if (cr < scrollTop) { cr = scrollTop; scrollDown(); }
        state = "normal";
        return;
      }
      if (ch === "D") { // IND - index (move down, scroll if needed)
        cr++;
        if (cr > scrollBottom) { cr = scrollBottom; scrollUp(); }
        state = "normal";
        return;
      }
      if (ch === "E") { // NEL - next line
        cr++;
        cc = 0;
        if (cr > scrollBottom) { cr = scrollBottom; scrollUp(); }
        state = "normal";
        return;
      }
      if (ch === "c") { // RIS - full reset
        fg = -1; bg = -1; bold = false; dim = false;
        italic = false; underline = false; reverse = false;
        cr = 0; cc = 0;
        scrollTop = 0; scrollBottom = rows - 1;
        buf = makeBuffer(cols, rows);
        state = "normal";
        return;
      }
      state = "normal"; // Unknown ESC sequence, ignore
      return;
    }

    if (state === "scs") {
      // Consume the charset designator character (B, 0, 1, 2, etc.)
      state = "normal";
      return;
    }

    if (state === "dcs") {
      // DCS string: skip until ST (ESC \) or BEL
      if (code === 0x07 || (ch === "\\" && oscData.endsWith("\x1b"))) {
        // Pass through DCS content (e.g. tmux-wrapped OSC 52 clipboard)
        if (oscData && vteObj.onOSC) {
          // DCS tmux passthrough: "tmux;..." contains wrapped OSC sequences
          if (oscData.startsWith("tmux;")) {
            // Forward the entire DCS passthrough to the real terminal
            const terminator = ch === "\\" ? "\x1b\\" : "\x07";
            process.stdout.write(`\x1bP${oscData}${terminator}`);
          }
        }
        state = "normal";
        oscData = "";
        return;
      }
      oscData += ch;
      return;
    }

    if (state === "csi") {
      // Collect params and intermediate bytes
      if ((code >= 0x30 && code <= 0x3f) || ch === ";" || ch === "?" || ch === ">" || ch === "!") {
        csiParams += ch;
        return;
      }
      // Final byte
      if (code >= 0x40 && code <= 0x7e) {
        execCSI(csiParams, ch);
        state = "normal";
        return;
      }
      // Unexpected, reset
      state = "normal";
      return;
    }

    if (state === "osc") {
      // OSC terminated by BEL or ST (\x1b\\)
      if (code === 0x07 || code === 0x1b) {
        // Fire callback with parsed OSC code and data
        if (oscData && vteObj.onOSC) {
          const semi = oscData.indexOf(";");
          if (semi >= 0) {
            const oscCode = parseInt(oscData.slice(0, semi), 10);
            if (!isNaN(oscCode)) {
              vteObj.onOSC(oscCode, oscData.slice(semi + 1));
            }
          }
        }
        state = "normal";
        oscData = "";
        return;
      }
      oscData += ch;
      return;
    }
  }

  function renderLine(line: Cell[]): string {
    let result = "";
    let lastStyle = "";
    for (let c = 0; c < line.length; c++) {
      const cell = line[c]!;
      if (cell.cont) continue;
      const style = styleToAnsi(cell);
      if (style !== lastStyle) {
        result += "\x1b[0m" + style;
        lastStyle = style;
      }
      result += cell.ch || " ";
    }
    result += "\x1b[0m";
    return result;
  }

  const vteObj: VTE = {
    get cols() { return cols; },
    get rows() { return rows; },
    get cursorRow() { return cr; },
    get cursorCol() { return cc; },

    write(data: Uint8Array | string) {
      viewOffset = 0; // auto-snap to bottom on new output
      const str = typeof data === "string" ? data : new TextDecoder().decode(data);
      for (const ch of str) {
        processChar(ch);
      }
    },

    getLine(row: number): string {
      if (viewOffset === 0) {
        if (row < 0 || row >= rows) return "";
        return renderLine(buf[row]!);
      }
      // Scrollback view
      const sbLen = scrollback.length;
      const idx = sbLen - viewOffset + row;
      if (idx < 0) return "";
      if (idx < sbLen) return renderLine(scrollback[idx]!);
      const bufRow = idx - sbLen;
      if (bufRow < 0 || bufRow >= rows) return "";
      return renderLine(buf[bufRow]!);
    },

    get scrollOffset() { return viewOffset; },
    set scrollOffset(v: number) { viewOffset = Math.max(0, Math.min(scrollback.length, v)); },
    get scrollbackSize() { return scrollback.length; },

    resize(newCols: number, newRows: number) {
      viewOffset = 0;
      const newBuf = makeBuffer(newCols, newRows);
      // Copy existing content
      for (let r = 0; r < Math.min(rows, newRows); r++) {
        for (let c = 0; c < Math.min(cols, newCols); c++) {
          newBuf[r]![c] = cloneCell(buf[r]![c]!);
        }
      }
      buf = newBuf;
      cols = newCols;
      rows = newRows;
      cr = Math.min(cr, rows - 1);
      cc = Math.min(cc, cols - 1);
      scrollTop = 0;
      scrollBottom = rows - 1;
    },
  };

  return vteObj;
}
