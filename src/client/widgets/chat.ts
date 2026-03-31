// Chat widget — WeeChat message formatting with prefix system,
// nick alignment, time elision, date change, read marker, scroll

import chalk from "chalk";
import stringWidth from "string-width";
import type { Region } from "../layout.ts";
import { fitToWidth } from "../layout.ts";
import type { Message, CCSession } from "../../shared/types.ts";
import {
  type SelectionState,
  selectionBounds,
  invertRange,
} from "../selection.ts";
import {
  getPrefix,
  nickColor,
  SELF_NICK_COLOR,
  TIMESTAMP_STYLE,
  HIGHLIGHT_STYLE,
  DATE_CHANGE_STYLE,
  READ_MARKER_CHAR,
  READ_MARKER_STYLE,
  SEPARATOR,
  SCROLL_INDICATOR,
  isSameMinute,
  formatTimestamp,
  formatDateChange,
} from "../theme.ts";

export interface ChatState {
  messages: Message[];
  selfNick: string;
  nickWidth: number; // max nick display width for alignment
  scrollOffset: number; // 0 = bottom (latest), positive = scrolled up
  readMarkerIndex: number; // message index where read marker sits (-1 = none)
  isActive: boolean; // is this the focused buffer?
  selection?: SelectionState; // drag-to-select state
}

// Formatted line ready for rendering
interface ChatLine {
  text: string;
  centered?: boolean;
  isReadMarker?: boolean;
}

// Code block keywords for basic syntax coloring
const CODE_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "import", "export", "from", "class", "new", "this", "async", "await",
  "true", "false", "null", "undefined", "type", "interface", "enum",
  "fn", "pub", "mut", "impl", "struct", "use", "mod", "self",
  "def", "print", "None", "True", "False", "lambda",
]);

const CODE_BG = chalk.bgGray;
const CODE_BORDER = chalk.dim;
const INLINE_CODE = chalk.bgGray.white;
const CODE_BLOCK_WIDTH = 50; // inner width of code block borders

/** Colorize a code line with basic keyword/string/comment highlighting. */
function colorizeCode(line: string): string {
  // Comments
  if (line.trimStart().startsWith("//") || line.trimStart().startsWith("#")) {
    return chalk.gray(line);
  }

  let result = "";
  let i = 0;
  while (i < line.length) {
    // String literals
    if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
      const quote = line[i]!;
      let end = line.indexOf(quote, i + 1);
      if (end === -1) end = line.length - 1;
      result += chalk.green(line.slice(i, end + 1));
      i = end + 1;
      continue;
    }

    // Word boundary — check for keywords
    if (/[a-zA-Z_]/.test(line[i]!)) {
      const match = line.slice(i).match(/^[a-zA-Z_]\w*/);
      if (match) {
        const word = match[0];
        if (CODE_KEYWORDS.has(word)) {
          result += chalk.cyan(word);
        } else {
          result += word;
        }
        i += word.length;
        continue;
      }
    }

    result += line[i];
    i++;
  }
  return result;
}

/** Wrap a single line to fit within maxWidth visible columns (ANSI-aware). */
function wrapLine(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || stringWidth(text) <= maxWidth) return [text];

  const result: string[] = [];
  let current = "";
  let currentW = 0;
  let i = 0;

  while (i < text.length) {
    // Pass through ANSI escape sequences (zero width)
    if (text[i] === "\x1b") {
      const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        current += match[0];
        i += match[0].length;
        continue;
      }
    }

    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = stringWidth(ch);

    if (currentW + cw > maxWidth && current) {
      result.push(current + "\x1b[0m");
      current = "";
      currentW = 0;
    }

    current += ch;
    currentW += cw;
    i += ch.length;
  }

  if (current) result.push(current);
  return result;
}

// URL detection pattern
const URL_RE = /https?:\/\/[^\s<>'")\]]+/g;

/** Underline URLs in text for visibility */
function highlightURLs(text: string): string {
  return text.replace(URL_RE, (url) => chalk.underline.blue(url));
}

/** Extract URLs from a plain text string */
export function extractURLs(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => m[0]);
}

/** Format content, detecting fenced code blocks and inline code. */
function formatContentWithCodeBlocks(content: string): string[] {
  // No code markers — split on newlines, highlight URLs
  if (!content.includes("`")) {
    return content.split("\n").map(highlightURLs);
  }

  // Handle inline code (single backticks, no newlines)
  if (!content.includes("\n") && !content.includes("```")) {
    const formatted = content.replace(/`([^`]+)`/g, (_, code) => INLINE_CODE(` ${code} `));
    return [formatted];
  }

  // Multi-line: split and process fenced blocks
  const lines = content.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        // End of code block
        result.push(CODE_BORDER("└" + "─".repeat(CODE_BLOCK_WIDTH) + "┘"));
        inCodeBlock = false;
      } else {
        // Start of code block
        const lang = line.trim().slice(3).trim();
        const header = lang ? ` ${lang} ` : "";
        const fill = Math.max(0, CODE_BLOCK_WIDTH - 1 - header.length);
        result.push(CODE_BORDER(`┌─${header}${"─".repeat(fill)}┐`));
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      result.push(CODE_BORDER("│ ") + CODE_BG(colorizeCode(line)));
    } else {
      // Handle inline code in non-block lines, highlight URLs
      const formatted = highlightURLs(
        line.replace(/`([^`]+)`/g, (_, code) => INLINE_CODE(` ${code} `)),
      );
      result.push(formatted);
    }
  }

  // Unclosed code block
  if (inCodeBlock) {
    result.push(CODE_BORDER("└" + "─".repeat(CODE_BLOCK_WIDTH) + "┘"));
  }

  return result;
}

function formatMessage(
  msg: Message,
  prevMsg: Message | null,
  nickW: number,
  selfNick: string,
  regionW: number,
): ChatLine[] {
  const lines: ChatLine[] = [];

  // Handle date_change type specially — before auto date detection to avoid duplication
  if (msg.type === "date_change") {
    const dateStr = formatDateChange(msg.timestamp);
    lines.push({ text: DATE_CHANGE_STYLE(`── ${dateStr} ──`), centered: true });
    return lines;
  }

  // Date change detection
  if (prevMsg && !isSameDay(prevMsg.timestamp, msg.timestamp)) {
    const dateStr = formatDateChange(msg.timestamp);
    lines.push({ text: DATE_CHANGE_STYLE(`── ${dateStr} ──`), centered: true });
  }

  // Timestamp (elide if same minute as previous)
  const showTime = !prevMsg || !isSameMinute(prevMsg.timestamp, msg.timestamp);
  const timeStr = showTime
    ? TIMESTAMP_STYLE(formatTimestamp(msg.timestamp))
    : "     "; // 5 chars blank (HH:MM)

  const prefix = getPrefix(msg.type);

  if (prefix) {
    // System-style message (join, part, error, network, etc.)
    const pfx = prefix.style(prefix.text);
    const paddedPfx = padLeft(pfx, prefix.text, nickW);
    const sep = SEPARATOR;
    lines.push({ text: `${timeStr} ${paddedPfx} ${sep} ${prefix.style(msg.content)}` });
  } else {
    // Chat message — nick in <brackets>, right-aligned
    const isSelf = msg.fromNick === selfNick;
    const colorFn = isSelf ? SELF_NICK_COLOR : nickColor(msg.fromNick);

    let content = msg.content;
    // Highlight @mentions of self
    if (content.includes(`@${selfNick}`)) {
      content = content.replace(
        new RegExp(`@${escapeRegex(selfNick)}`, "g"),
        HIGHLIGHT_STYLE(`@${selfNick}`),
      );
    }

    // Truncate long nicks to fit alignment column
    let displayNick = msg.fromNick;
    if (stringWidth(displayNick) > nickW) {
      // Truncate to nickW - 1 and add ellipsis
      let acc = 0;
      let cutIdx = 0;
      for (cutIdx = 0; cutIdx < displayNick.length; cutIdx++) {
        const cw = stringWidth(displayNick[cutIdx]!);
        if (acc + cw > nickW - 1) break;
        acc += cw;
      }
      displayNick = displayNick.slice(0, cutIdx) + "…";
    }
    const nickDisplay = `<${displayNick}>`;
    const coloredNick = colorFn(nickDisplay);
    const paddedNick = padLeft(coloredNick, nickDisplay, nickW + 2); // +2 for < >
    const sep = SEPARATOR;

    // Multi-line content (code blocks, newlines) + word wrapping
    const rawContentLines = formatContentWithCodeBlocks(content);
    // Available width for content text (after time + nick + separator)
    const prefixW = 5 + 1 + (nickW + 2) + 3; // "HH:MM" + " " + "<nick>" + " │ "
    const contentW = Math.max(10, regionW - prefixW);
    // Wrap each content line to fit
    const contentLines: string[] = [];
    for (const cl of rawContentLines) {
      contentLines.push(...wrapLine(cl, contentW));
    }
    const blankTime = "     ";
    const blankNick = " ".repeat(nickW + 2);
    for (let i = 0; i < contentLines.length; i++) {
      if (i === 0) {
        lines.push({ text: `${timeStr} ${paddedNick} ${sep} ${contentLines[i]}` });
      } else {
        lines.push({ text: `${blankTime} ${blankNick} ${sep} ${contentLines[i]}` });
      }
    }
  }

  return lines;
}

// Right-align text within a field of `width` visible columns
function padLeft(styled: string, raw: string, width: number): string {
  const rawW = stringWidth(raw);
  if (rawW >= width) return styled;
  return " ".repeat(width - rawW) + styled;
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build all formatted lines from messages
function buildAllLines(state: ChatState, regionW: number): ChatLine[] {
  const lines: ChatLine[] = [];
  const { messages, nickWidth, selfNick, readMarkerIndex } = state;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const prev = i > 0 ? messages[i - 1]! : null;
    const formatted = formatMessage(msg, prev, nickWidth, selfNick, regionW);
    lines.push(...formatted);

    // Read marker after this message (width placeholder, replaced at render time)
    if (i === readMarkerIndex && i < messages.length - 1) {
      lines.push({ text: "__READ_MARKER__", isReadMarker: true });
    }
  }

  return lines;
}

export function renderChat(region: Region, state: ChatState) {
  const allLines = buildAllLines(state, region.w);
  const visibleRows = region.h;
  const totalLines = allLines.length;

  // Clamp scroll to valid range
  const maxScroll = Math.max(0, totalLines - visibleRows);
  state.scrollOffset = Math.min(state.scrollOffset, maxScroll);

  // scrollOffset 0 = show bottom, positive = scrolled up
  const bottomIndex = totalLines;
  const topIndex = Math.max(0, bottomIndex - visibleRows - state.scrollOffset);
  const endIndex = Math.min(totalLines, topIndex + visibleRows);

  const hasUp = topIndex > 0;
  const hasDown = endIndex < totalLines;

  // Compute selection bounds relative to chat region (if active)
  const sel = state.selection;
  const bounds = sel ? selectionBounds(sel) : null;

  for (let row = 0; row < visibleRows; row++) {
    const lineIdx = topIndex + row;
    if (lineIdx >= endIndex) {
      region.writeLine(row, "");
      continue;
    }
    const line = allLines[lineIdx]!;
    let rendered: string;
    if (line.isReadMarker) {
      rendered = READ_MARKER_STYLE(READ_MARKER_CHAR.repeat(region.w));
    } else if (line.centered) {
      const rawLen = stringWidth(line.text);
      const pad = Math.max(0, Math.floor((region.w - rawLen) / 2));
      rendered = " ".repeat(pad) + line.text;
    } else {
      rendered = line.text;
    }

    // Apply selection overlay (SGR 7 inverse) if this row is selected
    if (bounds) {
      const absRow = region.y + row;
      if (absRow >= bounds.startRow && absRow <= bounds.endRow) {
        const colStart =
          absRow === bounds.startRow ? Math.max(0, bounds.startCol - region.x) : 0;
        const colEnd =
          absRow === bounds.endRow ? Math.max(0, bounds.endCol - region.x + 1) : region.w;
        rendered = invertRange(rendered, colStart, colEnd, region.w);
      }
    }

    region.writeLine(row, rendered);
  }

  // Scroll indicators — overlay at right edge of first/last row
  if (hasUp) {
    const tag = SCROLL_INDICATOR(` ▲${topIndex} `);
    const tagW = stringWidth(` ▲${topIndex} `);
    region.writeAt(0, region.w - tagW, tag);
  }
  if (hasDown) {
    const remaining = totalLines - endIndex;
    const tag = SCROLL_INDICATOR(` ▼${remaining} `);
    const tagW = stringWidth(` ▼${remaining} `);
    region.writeAt(visibleRows - 1, region.w - tagW, tag);
  }
}

// Is chat scrolled to bottom?
export function isAtBottom(state: ChatState): boolean {
  return state.scrollOffset === 0;
}

// Render CC session placeholder when a CC buffer is active
export function renderCCSessionPlaceholder(region: Region, session: CCSession) {
  const midRow = Math.floor(region.h / 2);

  const title = chalk.bold.cyan(`[CC Session: ${session.project}]`);
  const cwd = chalk.dim(`cwd: ${session.cwd}`);
  const lang = session.language ? chalk.dim(`language: ${session.language}`) : "";
  const elapsed = session.startedAt
    ? chalk.dim(`started: ${formatDuration(Date.now() - session.startedAt)}`)
    : "";
  const status = session.active
    ? chalk.green("● Active")
    : chalk.red("○ Inactive");

  const border = chalk.dim("─".repeat(Math.min(40, region.w - 4)));
  const note = chalk.dim("Type a message to chat with Claude");

  const contentLines = [border, "", title, status, "", cwd, lang, elapsed, "", border, "", note].filter(
    (l) => l !== undefined,
  );
  const startRow = Math.max(0, midRow - Math.floor(contentLines.length / 2));

  for (let row = 0; row < region.h; row++) {
    const ci = row - startRow;
    if (ci >= 0 && ci < contentLines.length) {
      const lineW = stringWidth(contentLines[ci]!);
      const pad = Math.max(0, Math.floor((region.w - lineW) / 2));
      region.writeLine(row, " ".repeat(pad) + contentLines[ci]!);
    } else {
      region.writeLine(row, "");
    }
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return `${hours}h ${remainMins}m ago`;
}

// Strip ANSI escape codes from a string
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Get visible plain-text lines for a given chat state (for text extraction). */
export function getVisibleLines(
  state: ChatState,
  regionW: number,
  regionH: number,
): string[] {
  const allLines = buildAllLines(state, regionW);
  const totalLines = allLines.length;
  const maxScroll = Math.max(0, totalLines - regionH);
  const scroll = Math.min(state.scrollOffset, maxScroll);
  const bottomIndex = totalLines;
  const topIndex = Math.max(0, bottomIndex - regionH - scroll);
  const endIndex = Math.min(totalLines, topIndex + regionH);

  const result: string[] = [];
  for (let i = topIndex; i < endIndex; i++) {
    const line = allLines[i]!;
    result.push(line.isReadMarker ? "" : stripAnsi(line.text));
  }
  // Pad remaining rows
  while (result.length < regionH) result.push("");
  return result;
}
