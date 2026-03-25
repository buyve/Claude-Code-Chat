// Statusbar widget — nick, connection status, channel, lag

import type { Region } from "../layout.ts";
import { STATUSBAR_BG, SEPARATOR } from "../theme.ts";

export interface StatusbarState {
  nick: string;
  status: string; // "Connected", "Disconnected", etc.
  channel: string;
  lag?: number; // ms
}

export function renderStatusbar(region: Region, state: StatusbarState) {
  const lagText = state.lag !== undefined ? ` ${SEPARATOR} lag: ${state.lag}ms` : "";
  const text = ` ${state.nick} ${SEPARATOR} ${state.status} ${SEPARATOR} ${state.channel}${lagText}`;
  region.fillLine(0, STATUSBAR_BG);
  region.writeLine(0, STATUSBAR_BG(text));
}
