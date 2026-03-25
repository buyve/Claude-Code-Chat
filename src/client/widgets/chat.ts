// Chat widget — WeeChat message formatting with prefix system,
// nick alignment, time elision, date change, read marker, scroll

import chalk from "chalk";
import stringWidth from "string-width";
import type { Region } from "../layout.ts";
import { fitToWidth } from "../layout.ts";
import type { Message } from "../../shared/types.ts";
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

function formatMessage(
  msg: Message,
  prevMsg: Message | null,
  nickW: number,
  selfNick: string,
): ChatLine[] {
  const lines: ChatLine[] = [];

  // Date change detection
  if (prevMsg && !isSameDay(prevMsg.timestamp, msg.timestamp)) {
    const dateStr = formatDateChange(msg.timestamp);
    lines.push({ text: DATE_CHANGE_STYLE(`── ${dateStr} ──`) });
  }

  // Timestamp (elide if same minute as previous)
  const showTime = !prevMsg || !isSameMinute(prevMsg.timestamp, msg.timestamp);
  const timeStr = showTime
    ? TIMESTAMP_STYLE(formatTimestamp(msg.timestamp))
    : "     "; // 5 chars blank (HH:MM)

  // Handle date_change type specially
  if (msg.type === "date_change") {
    const dateStr = formatDateChange(msg.timestamp);
    lines.push({ text: DATE_CHANGE_STYLE(`── ${dateStr} ──`) });
    return lines;
  }

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

    const nickDisplay = `<${msg.fromNick}>`;
    const coloredNick = colorFn(nickDisplay);
    const paddedNick = padLeft(coloredNick, nickDisplay, nickW + 2); // +2 for < >
    const sep = SEPARATOR;
    lines.push({ text: `${timeStr} ${paddedNick} ${sep} ${content}` });
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

    // Read marker after this message
    if (i === readMarkerIndex && i < messages.length - 1) {
      lines.push({ text: READ_MARKER_STYLE(READ_MARKER_CHAR.repeat(60)) });
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
    region.writeLine(row, allLines[lineIdx]!.text);
  }

  // Scroll indicators
  if (hasUp) {
    region.writeLine(0, SCROLL_INDICATOR(` ▲ more (${topIndex} lines)`));
  }
  if (hasDown) {
    const remaining = totalLines - endIndex;
    region.writeLine(
      visibleRows - 1,
      SCROLL_INDICATOR(` ▼ more (${remaining} lines)`),
    );
  }
}

// Is chat scrolled to bottom?
export function isAtBottom(state: ChatState): boolean {
  return state.scrollOffset === 0;
}
