// WeeChat theme: prefix system, nick colors, style constants

import chalk, { type ChalkInstance } from "chalk";
import type { HotlistPriority, MessageType } from "../shared/types.ts";

// --- Prefix system (ref: gui-chat.c) ---

export interface Prefix {
  text: string;
  style: ChalkInstance;
}

const prefixMap: Record<string, Prefix> = {
  error:   { text: "=!=", style: chalk.red },
  network: { text: " --", style: chalk.magenta },
  action:  { text: "  *", style: chalk.white },
  join:    { text: "-->", style: chalk.green },
  part:    { text: "<--", style: chalk.red },
};

export function getPrefix(type: MessageType): Prefix | null {
  switch (type) {
    case "error":       return prefixMap.error!;
    case "network":
    case "system":
    case "date_change": return prefixMap.network!;
    case "action":      return prefixMap.action!;
    case "join":        return prefixMap.join!;
    case "part":        return prefixMap.part!;
    default:            return null; // chat — uses nick instead
  }
}

// --- Nick colors (16 from 256-palette, djb2 hash) ---

const NICK_COLORS = [
  196, 208, 220, 226, 118, 46, 48, 51,
  45, 39, 33, 129, 165, 201, 213, 219,
];

function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function nickColor(nick: string): ChalkInstance {
  const idx = djb2(nick) % NICK_COLORS.length;
  return chalk.ansi256(NICK_COLORS[idx]!);
}

export const SELF_NICK_COLOR = chalk.white.bold;

// --- Timestamp ---

export const TIMESTAMP_STYLE = chalk.gray;

export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function isSameMinute(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate() &&
    da.getHours() === db.getHours() &&
    da.getMinutes() === db.getMinutes()
  );
}

// --- Date change line ---

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatDateChange(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const wd = DAYS[d.getDay()]!;
  return `${y}-${m}-${day} (${wd})`;
}

export const DATE_CHANGE_STYLE = chalk.dim;

// --- Read marker ---

export const READ_MARKER_CHAR = "─";
export const READ_MARKER_STYLE = chalk.dim;

// --- Hotlist priority colors (ref: gui-hotlist.c) ---

const HOTLIST_STYLES: Record<HotlistPriority, ChalkInstance> = {
  0: chalk.dim,
  1: chalk.yellow,
  2: chalk.green,
  3: chalk.magenta.bold,
};

export function hotlistStyle(priority: HotlistPriority): ChalkInstance {
  return HOTLIST_STYLES[priority];
}

// --- Misc styles ---

export const HIGHLIGHT_STYLE = chalk.yellow.bold;
export const INACTIVE_DIM = chalk.dim;
export const SEPARATOR = chalk.dim("│");
export const STATUSBAR_BG = chalk.bgGray.white;
export const TITLEBAR_BG = chalk.bgGray.white;
export const ACTIVE_BUFFER_STYLE = chalk.inverse;
export const SCROLL_INDICATOR = chalk.dim;
