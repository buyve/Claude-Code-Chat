// Keyboard & mouse input handler — raw stdin parsing
// Parses ANSI escape sequences into semantic actions

export type Action =
  | { type: "char"; ch: string }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "tab" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "page_up" }
  | { type: "page_down" }
  | { type: "ctrl_a" }
  | { type: "ctrl_c" }
  | { type: "ctrl_d" }
  | { type: "ctrl_e" }
  | { type: "ctrl_k" }
  | { type: "ctrl_r" }
  | { type: "ctrl_u" }
  | { type: "ctrl_w" }
  | { type: "alt_num"; num: number } // Alt+1-9
  | { type: "alt_left" }
  | { type: "alt_right" }
  | { type: "ctrl_up" }
  | { type: "ctrl_down" }
  | { type: "alt_m" }
  | { type: "alt_l" }
  | { type: "alt_j" }
  | { type: "mouse_click"; col: number; row: number; button: number }
  | { type: "mouse_scroll_up"; col: number; row: number }
  | { type: "mouse_scroll_down"; col: number; row: number }
  | { type: "unknown" };

// Enable mouse reporting (SGR extended mode)
export function enableMouse() {
  process.stdout.write("\x1b[?1000h\x1b[?1006h");
}

export function disableMouse() {
  process.stdout.write("\x1b[?1000l\x1b[?1006l");
}

// Parse raw stdin data into actions
export function parseInput(data: Buffer): Action[] {
  const s = data.toString("utf-8");
  const actions: Action[] = [];
  let i = 0;

  while (i < s.length) {
    // ESC sequence
    if (s[i] === "\x1b") {
      // SGR mouse: \x1b[<btn;col;row;M or m
      const mouseMatch = s.slice(i).match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (mouseMatch) {
        const btn = parseInt(mouseMatch[1]!, 10);
        const col = parseInt(mouseMatch[2]!, 10) - 1; // 1-indexed -> 0-indexed
        const row = parseInt(mouseMatch[3]!, 10) - 1;
        const released = mouseMatch[4] === "m";

        if (btn === 64) {
          actions.push({ type: "mouse_scroll_up", col, row });
        } else if (btn === 65) {
          actions.push({ type: "mouse_scroll_down", col, row });
        } else if (btn === 0 && released) {
          actions.push({ type: "mouse_click", col, row, button: 0 });
        }
        i += mouseMatch[0].length;
        continue;
      }

      // CSI sequences: \x1b[ ...
      if (s[i + 1] === "[") {
        const rest = s.slice(i + 2);

        // Arrow keys
        if (rest.startsWith("A")) { actions.push({ type: "up" }); i += 3; continue; }
        if (rest.startsWith("B")) { actions.push({ type: "down" }); i += 3; continue; }
        if (rest.startsWith("C")) { actions.push({ type: "right" }); i += 3; continue; }
        if (rest.startsWith("D")) { actions.push({ type: "left" }); i += 3; continue; }
        if (rest.startsWith("H")) { actions.push({ type: "home" }); i += 3; continue; }
        if (rest.startsWith("F")) { actions.push({ type: "end" }); i += 3; continue; }

        // Page up/down
        if (rest.startsWith("5~")) { actions.push({ type: "page_up" }); i += 4; continue; }
        if (rest.startsWith("6~")) { actions.push({ type: "page_down" }); i += 4; continue; }
        if (rest.startsWith("3~")) { actions.push({ type: "delete" }); i += 4; continue; }

        // Alt+Arrow: \x1b[1;3C (alt+right), \x1b[1;3D (alt+left)
        if (rest.startsWith("1;3C")) { actions.push({ type: "alt_right" }); i += 6; continue; }
        if (rest.startsWith("1;3D")) { actions.push({ type: "alt_left" }); i += 6; continue; }

        // Ctrl+Arrow: \x1b[1;5A (ctrl+up), \x1b[1;5B (ctrl+down)
        if (rest.startsWith("1;5A")) { actions.push({ type: "ctrl_up" }); i += 6; continue; }
        if (rest.startsWith("1;5B")) { actions.push({ type: "ctrl_down" }); i += 6; continue; }

        // Skip unknown CSI
        const csiEnd = rest.search(/[A-Za-z~]/);
        i += 2 + (csiEnd >= 0 ? csiEnd + 1 : rest.length);
        continue;
      }

      // Alt+key: \x1b + char
      if (i + 1 < s.length) {
        const ch = s[i + 1]!;

        // Alt+1-9
        if (ch >= "1" && ch <= "9") {
          actions.push({ type: "alt_num", num: parseInt(ch, 10) });
          i += 2; continue;
        }
        if (ch === "m" || ch === "M") { actions.push({ type: "alt_m" }); i += 2; continue; }
        if (ch === "l" || ch === "L") { actions.push({ type: "alt_l" }); i += 2; continue; }
        if (ch === "j" || ch === "J") { actions.push({ type: "alt_j" }); i += 2; continue; }

        // Unknown alt combo
        i += 2; continue;
      }

      // Bare ESC
      i++; continue;
    }

    // Control characters
    const code = s.charCodeAt(i);
    if (code === 13 || code === 10) { actions.push({ type: "enter" }); i++; continue; }
    if (code === 127 || code === 8) { actions.push({ type: "backspace" }); i++; continue; }
    if (code === 9) { actions.push({ type: "tab" }); i++; continue; }
    if (code === 1) { actions.push({ type: "ctrl_a" }); i++; continue; }
    if (code === 3) { actions.push({ type: "ctrl_c" }); i++; continue; }
    if (code === 4) { actions.push({ type: "ctrl_d" }); i++; continue; }
    if (code === 5) { actions.push({ type: "ctrl_e" }); i++; continue; }
    if (code === 11) { actions.push({ type: "ctrl_k" }); i++; continue; }
    if (code === 18) { actions.push({ type: "ctrl_r" }); i++; continue; }
    if (code === 21) { actions.push({ type: "ctrl_u" }); i++; continue; }
    if (code === 23) { actions.push({ type: "ctrl_w" }); i++; continue; }

    // Printable character (possibly multi-byte UTF-8)
    if (code >= 32) {
      // Get the full character (handles surrogate pairs, CJK, emoji)
      const ch = String.fromCodePoint(s.codePointAt(i)!);
      actions.push({ type: "char", ch });
      i += ch.length;
      continue;
    }

    // Unknown control
    i++;
  }

  return actions;
}

// Identify which region a click lands in
export type RegionId = "buflist" | "titlebar" | "chat" | "nicklist" | "statusbar" | "input";

export interface RegionBounds {
  buflistW: number;
  nicklistX: number;
  statusbarY: number;
  inputY: number;
}

export function identifyRegion(
  col: number,
  row: number,
  bounds: RegionBounds,
): RegionId {
  if (row === 0) return "titlebar";
  if (row === bounds.inputY) return "input";
  if (row === bounds.statusbarY) return "statusbar";
  if (col < bounds.buflistW) return "buflist";
  if (col >= bounds.nicklistX) return "nicklist";
  return "chat";
}
