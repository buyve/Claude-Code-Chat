// Nicklist widget — grouped by presence, alphabetical within group
// Also shows CC session metadata when a CC buffer is active

import chalk from "chalk";
import type { Region } from "../layout.ts";
import type { User, PresenceStatus, CCSession } from "../../shared/types.ts";
import { nickColor, INACTIVE_DIM, SCROLL_INDICATOR } from "../theme.ts";

// Presence icons — emoji with ASCII fallback
const EMOJI_ICONS: Record<PresenceStatus, string> = {
  coding:    "⚡",
  online:    "●",
  reviewing: "💬",
  dnd:       "⊘",
  offline:   "○",
};

const ASCII_ICONS: Record<PresenceStatus, string> = {
  coding:    "C",
  online:    "O",
  reviewing: "R",
  dnd:       "D",
  offline:   "X",
};

const PRESENCE_ICONS = process.env["CCC_ASCII_ICONS"]
  ? ASCII_ICONS
  : EMOJI_ICONS;

// Group order: coding > reviewing > online > dnd > offline
const GROUP_ORDER: PresenceStatus[] = [
  "coding", "reviewing", "online", "dnd", "offline",
];

const GROUP_LABELS: Record<PresenceStatus, string> = {
  coding:    "coding",
  reviewing: "reviewing",
  online:    "online",
  dnd:       "dnd",
  offline:   "offline",
};

export interface NicklistState {
  users: User[];
  scrollOffset: number;
}

interface NicklistLine {
  type: "header" | "nick";
  text: string;
}

function buildLines(users: User[]): NicklistLine[] {
  const lines: NicklistLine[] = [];
  const grouped = new Map<PresenceStatus, User[]>();

  for (const status of GROUP_ORDER) {
    grouped.set(status, []);
  }
  for (const u of users) {
    grouped.get(u.presence)?.push(u);
  }

  for (const status of GROUP_ORDER) {
    const group = grouped.get(status) ?? [];
    if (group.length === 0) continue;

    group.sort((a, b) => a.nick.localeCompare(b.nick));
    const header = chalk.dim(`-- ${GROUP_LABELS[status]} (${group.length}) --`);
    lines.push({ type: "header", text: ` ${header}` });

    for (const u of group) {
      const icon = PRESENCE_ICONS[u.presence];
      const coloredNick =
        u.presence === "offline"
          ? INACTIVE_DIM(u.nick)
          : nickColor(u.nick)(u.nick);
      lines.push({ type: "nick", text: ` ${icon} ${coloredNick}` });
    }
  }

  return lines;
}

export function renderNicklist(region: Region, state: NicklistState) {
  region.clear();
  const lines = buildLines(state.users);
  const visibleRows = region.h;
  const { scrollOffset } = state;

  const hasUp = scrollOffset > 0;
  const hasDown = scrollOffset + visibleRows < lines.length;

  for (let row = 0; row < visibleRows; row++) {
    const idx = scrollOffset + row;
    if (idx >= lines.length) break;
    region.writeLine(row, lines[idx]!.text);
  }

  // Scroll indicators at right edge to preserve content
  if (hasUp) {
    const col = region.x + region.w - 2;
    process.stdout.write(`\x1b[${region.y + 1};${col + 1}H` + SCROLL_INDICATOR("▲"));
  }
  if (hasDown) {
    const col = region.x + region.w - 2;
    process.stdout.write(
      `\x1b[${region.y + visibleRows};${col + 1}H` + SCROLL_INDICATOR("▼"),
    );
  }
}

// Render CC session metadata in the nicklist area
export function renderCCSessionMeta(region: Region, session: CCSession) {
  region.clear();

  const lines: string[] = [];
  lines.push(chalk.dim("── Session Info ──"));
  lines.push("");
  lines.push(chalk.bold.cyan(`⚡ ${session.project}`));
  lines.push("");

  if (session.language) {
    lines.push(chalk.white(` Lang: ${session.language}`));
  }
  lines.push(chalk.white(` Dir:  ${shortenPath(session.cwd)}`));

  const elapsed = Date.now() - session.startedAt;
  const mins = Math.floor(elapsed / 60000);
  const hrs = Math.floor(mins / 60);
  const durStr = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
  lines.push(chalk.white(` Time: ${durStr}`));

  lines.push("");
  lines.push(
    session.active
      ? chalk.green(" ● Active")
      : chalk.red(" ○ Inactive"),
  );

  for (let row = 0; row < Math.min(lines.length, region.h); row++) {
    region.writeLine(row, ` ${lines[row]!}`);
  }
}

function shortenPath(cwd: string): string {
  const home = process.env["HOME"] ?? "";
  if (home && cwd.startsWith(home)) {
    return "~" + cwd.slice(home.length);
  }
  // Just last 2 segments if too long
  const parts = cwd.split("/");
  if (parts.length > 3) {
    return ".../" + parts.slice(-2).join("/");
  }
  return cwd;
}
