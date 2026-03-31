// Double-buffered screen with slot-based line diffing
// Adapted from Ink's screen.ts + log-update.ts patterns

import { fitToWidth, moveTo } from "./ansi-utils.ts";
import { BSU, ESU, SYNC_SUPPORTED } from "./sync-output.ts";

// A slot represents one region-row write: (absRow, absCol) → rendered content
type SlotKey = string;

function slotKey(row: number, col: number): SlotKey {
  return `${row}:${col}`;
}

function parseSlotKey(key: SlotKey): [number, number] {
  const sep = key.indexOf(":");
  return [parseInt(key.slice(0, sep), 10), parseInt(key.slice(sep + 1), 10)];
}

export interface ScreenBuffer {
  /** Write a fitted line into the buffer at absolute screen position */
  writeLine(absX: number, absY: number, width: number, text: string): void;
  /** Write at a column offset within a region row */
  writeAt(
    absX: number,
    absY: number,
    colOffset: number,
    maxWidth: number,
    text: string,
  ): void;
  /** Fill a line with a styled pattern */
  fillLine(absX: number, absY: number, width: number, styled: string): void;
  /** Append raw ANSI string to flush output (borders, cursor positioning) */
  writeRaw(str: string): void;
  /** Diff back vs front, write only changed slots to stdout */
  flush(): void;
  /** Clear front buffer so next flush redraws everything */
  invalidateAll(): void;
  /** Resize the buffer (clears both buffers) */
  resize(width: number, height: number): void;
}

export function createScreenBuffer(
  width: number,
  height: number,
): ScreenBuffer {
  let front = new Map<SlotKey, string>();
  let back = new Map<SlotKey, string>();
  let rawQueue: string[] = [];
  let bufWidth = width;
  let bufHeight = height;

  function writeLine(
    absX: number,
    absY: number,
    w: number,
    text: string,
  ): void {
    if (absY < 0 || absY >= bufHeight) return;
    const fitted = fitToWidth(text, w);
    back.set(slotKey(absY, absX), fitted);
  }

  function writeAt(
    absX: number,
    absY: number,
    colOffset: number,
    maxWidth: number,
    text: string,
  ): void {
    if (absY < 0 || absY >= bufHeight) return;
    if (colOffset < 0 || colOffset >= maxWidth) return;
    const fitted = fitToWidth(text, maxWidth);
    // writeAt uses its own slot key with the offset
    back.set(slotKey(absY, absX + colOffset), fitted);
  }

  function fillLine(
    absX: number,
    absY: number,
    w: number,
    styled: string,
  ): void {
    if (absY < 0 || absY >= bufHeight) return;
    back.set(slotKey(absY, absX), styled);
  }

  function writeRaw(str: string): void {
    rawQueue.push(str);
  }

  function flush(): void {
    // Anchor cursor at (0,0) before each frame — prevents terminal scroll
    // in alt-screen mode (adapted from Ink's ink.tsx onRender: CSI H)
    let output = (SYNC_SUPPORTED ? BSU : "") + "\x1b[H";
    let hasChanges = false;

    // Emit changed slots
    for (const [key, content] of back) {
      if (front.get(key) === content) continue;
      hasChanges = true;
      const [row, col] = parseSlotKey(key);
      output += moveTo(col, row) + content + "\x1b[0m";
    }

    // Emit cleared slots (were in front but not in back)
    for (const [key] of front) {
      if (!back.has(key)) {
        hasChanges = true;
        const [row, col] = parseSlotKey(key);
        // Write a blank space to clear — we don't know the width,
        // but cleared slots are rare (only on region removal)
        output += moveTo(col, row) + " ";
      }
    }

    // Append raw writes (cursor positioning, border chars, etc.)
    if (rawQueue.length > 0) {
      hasChanges = true;
      output += rawQueue.join("");
      rawQueue = [];
    }

    if (SYNC_SUPPORTED) output += ESU;
    // Always write: cursor home is needed every frame to prevent scroll drift
    process.stdout.write(output);

    // Swap: front becomes what we just rendered
    const tmp = front;
    front = back;
    back = tmp;
    back.clear();
  }

  function invalidateAll(): void {
    front.clear();
  }

  function resize(w: number, h: number): void {
    bufWidth = w;
    bufHeight = h;
    front.clear();
    back.clear();
    rawQueue = [];
  }

  return {
    writeLine,
    writeAt,
    fillLine,
    writeRaw,
    flush,
    invalidateAll,
    resize,
  };
}
