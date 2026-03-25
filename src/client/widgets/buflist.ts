// Buflist widget — channel/DM list with hotlist counters

import chalk from "chalk";
import type { Region } from "../layout.ts";
import type { Channel, HotlistPriority } from "../../shared/types.ts";
import { hotlistMax } from "../../shared/types.ts";
import {
  hotlistStyle,
  ACTIVE_BUFFER_STYLE,
  SCROLL_INDICATOR,
} from "../theme.ts";

export interface BuflistState {
  channels: Channel[];
  activeIndex: number;
  scrollOffset: number;
}

function formatHotlist(ch: Channel): string {
  const h = ch.hotlist;
  const parts: string[] = [];
  if (h.highlight > 0) parts.push(hotlistStyle(3)(String(h.highlight)));
  if (h.message > 0) parts.push(hotlistStyle(1)(String(h.message)));
  if (h.low > 0) parts.push(hotlistStyle(0)(String(h.low)));
  return parts.length > 0 ? ` (${parts.join(",")})` : "";
}

export function renderBuflist(region: Region, state: BuflistState) {
  region.clear();
  const { channels, activeIndex, scrollOffset } = state;
  const visibleRows = region.h;

  // Scroll indicators
  const hasUp = scrollOffset > 0;
  const hasDown = scrollOffset + visibleRows < channels.length;

  for (let row = 0; row < visibleRows; row++) {
    const idx = scrollOffset + row;
    if (idx >= channels.length) break;

    const ch = channels[idx]!;
    const num = `${idx + 1}.`;
    const hotlist = formatHotlist(ch);
    const name = ch.name;
    const priority = hotlistMax(ch.hotlist);

    let line = ` ${num} ${name}${hotlist}`;

    if (idx === activeIndex) {
      line = ACTIVE_BUFFER_STYLE(line);
    } else if (priority > 0) {
      line = hotlistStyle(priority as HotlistPriority)(line);
    }

    region.writeLine(row, line);
  }

  // Overflow indicators
  if (hasUp) {
    const indicator = SCROLL_INDICATOR("▲ more");
    region.writeLine(0, ` ${indicator}`);
  }
  if (hasDown) {
    const indicator = SCROLL_INDICATOR("▼ more");
    region.writeLine(visibleRows - 1, ` ${indicator}`);
  }
}

// Ensure active buffer is visible
export function adjustScroll(state: BuflistState, visibleRows: number): number {
  let { activeIndex, scrollOffset } = state;
  if (activeIndex < scrollOffset) {
    scrollOffset = activeIndex;
  } else if (activeIndex >= scrollOffset + visibleRows) {
    scrollOffset = activeIndex - visibleRows + 1;
  }
  return scrollOffset;
}
