// Nicklist widget — grouped by presence, alphabetical within group

import chalk from "chalk";
import type { Region } from "../layout.ts";
import type { User, PresenceStatus } from "../../shared/types.ts";
import { nickColor, INACTIVE_DIM, SCROLL_INDICATOR } from "../theme.ts";

// Presence icons — emoji with ASCII fallback
const PRESENCE_ICONS: Record<PresenceStatus, string> = {
  coding:    "⚡",
  online:    "●",
  reviewing: "💬",
  dnd:       "⊘",
  offline:   "○",
};

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

  if (hasUp) region.writeLine(0, ` ${SCROLL_INDICATOR("▲")}`);
  if (hasDown) region.writeLine(visibleRows - 1, ` ${SCROLL_INDICATOR("▼")}`);
}
