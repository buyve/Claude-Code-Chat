// ANSI-aware string utilities — shared by layout, screen-buffer, and widgets

import ansiEscapes from "ansi-escapes";
import stringWidth from "string-width";

// ANSI SGR escape sequence pattern (covers chalk output)
const ANSI_RE = /\x1b\[[0-9;]*m/;

/**
 * Truncate/pad a string to exactly `width` visible columns.
 * ANSI-aware: preserves escape sequences, appends reset on truncation.
 */
export function fitToWidth(text: string, width: number): string {
  const w = stringWidth(text);
  if (w === width) return text;
  if (w < width) return text + "\x1b[0m" + " ".repeat(width - w);

  // Truncate: walk the string, skip ANSI sequences, count visible chars
  let visibleW = 0;
  let i = 0;
  while (i < text.length && visibleW < width) {
    if (text[i] === "\x1b") {
      const match = text.slice(i).match(ANSI_RE);
      if (match && text.slice(i).indexOf(match[0]) === 0) {
        i += match[0].length;
        continue;
      }
    }
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

  return text.slice(0, i - (tail ? tail.length : 0)) + "\x1b[0m" + " ".repeat(width - visibleW);
}

/** Generate ANSI cursor-to escape sequence */
export function moveTo(col: number, row: number): string {
  return ansiEscapes.cursorTo(col, row);
}

export { stringWidth };
