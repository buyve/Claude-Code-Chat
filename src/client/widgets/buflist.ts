// Buflist widget — 3-section buffer list: Channels, DMs, CC Sessions

import chalk from "chalk";
import type { Region } from "../layout.ts";
import type { Channel, HotlistPriority, BufferType } from "../../shared/types.ts";
import { hotlistMax } from "../../shared/types.ts";
import {
  hotlistStyle,
  ACTIVE_BUFFER_STYLE,
  SCROLL_INDICATOR,
} from "../theme.ts";

export interface BuflistEntry {
  name: string;
  bufferType: BufferType;
  channel: Channel;
  globalIndex: number; // index in the flat buffers array
}

export interface BuflistState {
  entries: BuflistEntry[];
  activeIndex: number; // global index of active buffer
  scrollOffset: number;
}

// Section headers
const SECTION_HEADERS: Record<BufferType, string> = {
  channel: "📂 Channels",
  dm: "💬 DMs",
  cc_session: "⚡ CC Sessions",
};

const SECTION_ORDER: BufferType[] = ["channel", "dm", "cc_session"];

function formatHotlist(ch: Channel): string {
  const h = ch.hotlist;
  const parts: string[] = [];
  if (h.highlight > 0) parts.push(hotlistStyle(3)(String(h.highlight)));
  if (h.private > 0) parts.push(hotlistStyle(2)(String(h.private)));
  if (h.message > 0) parts.push(hotlistStyle(1)(String(h.message)));
  if (h.low > 0) parts.push(hotlistStyle(0)(String(h.low)));
  return parts.length > 0 ? ` (${parts.join(",")})` : "";
}

interface RenderedLine {
  text: string;
  isHeader: boolean;
}

function buildLines(entries: BuflistEntry[], activeIndex: number): RenderedLine[] {
  const lines: RenderedLine[] = [];

  for (const section of SECTION_ORDER) {
    const sectionEntries = entries.filter((e) => e.bufferType === section);
    if (sectionEntries.length === 0) continue;

    // Section header
    lines.push({
      text: ` ${chalk.dim(SECTION_HEADERS[section])}`,
      isHeader: true,
    });

    for (const entry of sectionEntries) {
      const num = `${entry.globalIndex + 1}.`;
      const hotlist = formatHotlist(entry.channel);
      const priority = hotlistMax(entry.channel.hotlist);

      let line = ` ${num} ${entry.name}${hotlist}`;

      if (entry.globalIndex === activeIndex) {
        line = ACTIVE_BUFFER_STYLE(line);
      } else if (priority > 0) {
        line = hotlistStyle(priority as HotlistPriority)(line);
      }

      lines.push({ text: line, isHeader: false });
    }
  }

  return lines;
}

export function renderBuflist(region: Region, state: BuflistState) {
  region.clear();
  const lines = buildLines(state.entries, state.activeIndex);
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
    const tag = SCROLL_INDICATOR("▲");
    const col = region.x + region.w - 2;
    process.stdout.write(`\x1b[${region.y + 1};${col + 1}H` + tag);
  }
  if (hasDown) {
    const tag = SCROLL_INDICATOR("▼");
    const col = region.x + region.w - 2;
    process.stdout.write(
      `\x1b[${region.y + visibleRows};${col + 1}H` + tag,
    );
  }
}

// Ensure active buffer is visible — returns adjusted scroll offset
export function adjustBuflistScroll(
  entries: BuflistEntry[],
  activeIndex: number,
  scrollOffset: number,
  visibleRows: number,
): number {
  const lines = buildLines(entries, activeIndex);
  // Find the line index for the active buffer by matching the prefix marker
  const marker = ` ${activeIndex + 1}. `;
  let activeLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.isHeader && lines[i]!.text.includes(marker)) {
      activeLine = i;
      break;
    }
  }

  if (activeLine < scrollOffset) {
    scrollOffset = activeLine;
  } else if (activeLine >= scrollOffset + visibleRows) {
    scrollOffset = activeLine - visibleRows + 1;
  }
  return scrollOffset;
}
