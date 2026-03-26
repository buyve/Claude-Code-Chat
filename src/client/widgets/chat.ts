// Chat widget — WeeChat message formatting with prefix system,
// nick alignment, time elision, date change, read marker, scroll

import chalk from "chalk";
import stringWidth from "string-width";
import type { Region } from "../layout.ts";
import { fitToWidth } from "../layout.ts";
import type { Message, CCSession } from "../../shared/types.ts";
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
}

// Formatted line ready for rendering
interface ChatLine {
  text: string;
  centered?: boolean;
  isReadMarker?: boolean;
}

// Compute the nick alignment width (max nick length in current messages)
export function computeNickWidth(messages: Message[]): number {
  let max = 4; // minimum width
  for (const m of messages) {
    if (m.type === "chat" || m.type === "action") {
      const w = stringWidth(m.fromNick);
      if (w > max) max = w;
    }
  }
  return Math.min(max, 16); // cap at 16
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

/** Format content, detecting fenced code blocks and inline code. */
function formatContentWithCodeBlocks(content: string): string[] {
  // Single-line content without code markers — return as-is
  if (!content.includes("`")) {
    return [content];
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
        result.push(CODE_BORDER("└─────────────────────────────────┘"));
        inCodeBlock = false;
      } else {
        // Start of code block
        const lang = line.trim().slice(3).trim();
        const header = lang ? ` ${lang} ` : "";
        result.push(CODE_BORDER(`┌─${header}${"─".repeat(Math.max(0, 33 - header.length))}┐`));
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      result.push(CODE_BORDER("│ ") + CODE_BG(colorizeCode(line)));
    } else {
      // Handle inline code in non-block lines
      const formatted = line.replace(/`([^`]+)`/g, (_, code) => INLINE_CODE(` ${code} `));
      result.push(formatted);
    }
  }

  // Unclosed code block
  if (inCodeBlock) {
    result.push(CODE_BORDER("└─────────────────────────────────┘"));
  }

  return result;
}

function formatMessage(
  msg: Message,
  prevMsg: Message | null,
  nickW: number,
  selfNick: string,
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

    // Multi-line content (code blocks)
    const contentLines = formatContentWithCodeBlocks(content);
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
function buildAllLines(state: ChatState): ChatLine[] {
  const lines: ChatLine[] = [];
  const { messages, nickWidth, selfNick, readMarkerIndex } = state;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const prev = i > 0 ? messages[i - 1]! : null;
    const formatted = formatMessage(msg, prev, nickWidth, selfNick);
    lines.push(...formatted);

    // Read marker after this message (width placeholder, replaced at render time)
    if (i === readMarkerIndex && i < messages.length - 1) {
      lines.push({ text: "__READ_MARKER__", isReadMarker: true });
    }
  }

  return lines;
}

export function renderChat(region: Region, state: ChatState) {
  region.clear();
  const allLines = buildAllLines(state);
  const visibleRows = region.h;
  const totalLines = allLines.length;

  // scrollOffset 0 = show bottom, positive = scrolled up
  const bottomIndex = totalLines;
  const topIndex = Math.max(0, bottomIndex - visibleRows - state.scrollOffset);
  const endIndex = Math.min(totalLines, topIndex + visibleRows);

  const hasUp = topIndex > 0;
  const hasDown = endIndex < totalLines;

  for (let row = 0; row < visibleRows; row++) {
    const lineIdx = topIndex + row;
    if (lineIdx >= endIndex) break;
    const line = allLines[lineIdx]!;
    if (line.isReadMarker) {
      region.writeLine(row, READ_MARKER_STYLE(READ_MARKER_CHAR.repeat(region.w)));
    } else if (line.centered) {
      const rawLen = stringWidth(line.text);
      const pad = Math.max(0, Math.floor((region.w - rawLen) / 2));
      region.writeLine(row, " ".repeat(pad) + line.text);
    } else {
      region.writeLine(row, line.text);
    }
  }

  // Scroll indicators — render at right edge so they don't destroy content
  if (hasUp) {
    const tag = SCROLL_INDICATOR(` ▲${topIndex} `);
    const tagW = stringWidth(` ▲${topIndex} `);
    // Overwrite only the right portion of the first row
    const col = region.x + region.w - tagW;
    process.stdout.write(
      `\x1b[${region.y + 1};${col + 1}H` + tag,
    );
  }
  if (hasDown) {
    const remaining = totalLines - endIndex;
    const tag = SCROLL_INDICATOR(` ▼${remaining} `);
    const tagW = stringWidth(` ▼${remaining} `);
    const col = region.x + region.w - tagW;
    process.stdout.write(
      `\x1b[${region.y + visibleRows};${col + 1}H` + tag,
    );
  }
}

// Is chat scrolled to bottom?
export function isAtBottom(state: ChatState): boolean {
  return state.scrollOffset === 0;
}

// Render CC session placeholder when a CC buffer is active
export function renderCCSessionPlaceholder(region: Region, session: CCSession) {
  region.clear();
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
  const note = chalk.dim("CC SDK integration coming in Phase 3");

  const lines = [border, "", title, status, "", cwd, lang, elapsed, "", border, "", note].filter(
    (l) => l !== undefined,
  );
  const startRow = Math.max(0, midRow - Math.floor(lines.length / 2));

  for (let i = 0; i < lines.length; i++) {
    const row = startRow + i;
    if (row >= region.h) break;
    // Center each line
    const lineW = stringWidth(lines[i]!);
    const pad = Math.max(0, Math.floor((region.w - lineW) / 2));
    region.writeLine(row, " ".repeat(pad) + lines[i]!);
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return `${hours}h ${remainMins}m ago`;
}
