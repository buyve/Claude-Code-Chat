// Titlebar widget — channel name + topic (inverted bg)

import type { Region } from "../layout.ts";
import { TITLEBAR_BG } from "../theme.ts";

export interface TitlebarState {
  channel: string;
  topic: string;
}

export function renderTitlebar(region: Region, state: TitlebarState) {
  const text = state.topic
    ? ` ${state.channel} — ${state.topic}`
    : ` ${state.channel}`;
  region.fillLine(0, TITLEBAR_BG);
  region.writeLine(0, TITLEBAR_BG(text));
}
