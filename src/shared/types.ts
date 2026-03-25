// Core domain types for CCC

export type MessageType =
  | "chat"
  | "action"
  | "join"
  | "part"
  | "network"
  | "error"
  | "system"
  | "date_change";

export type PresenceStatus =
  | "online"
  | "coding"
  | "reviewing"
  | "dnd"
  | "offline";

export type HotlistPriority = 0 | 1 | 2 | 3;
// 0 = low (system), 1 = message, 2 = private (DM), 3 = highlight (@mention)

export interface HotlistEntry {
  low: number;
  message: number;
  private: number;
  highlight: number;
}

export interface RichPresence {
  project: string;
  language?: string;
  file?: string;
  duration?: number; // minutes
}

export interface User {
  id: string; // SSH public key fingerprint
  nick: string;
  publicKey: string;
  presence: PresenceStatus;
  richPresence?: RichPresence;
}

export interface Message {
  id: string;
  from: string; // user id
  fromNick: string;
  channel: string;
  content: string;
  timestamp: number; // unix ms
  type: MessageType;
}

export interface Channel {
  name: string;
  topic: string;
  members: string[]; // user ids
  hotlist: HotlistEntry;
}

export function emptyHotlist(): HotlistEntry {
  return { low: 0, message: 0, private: 0, highlight: 0 };
}

export function hotlistMax(h: HotlistEntry): HotlistPriority {
  if (h.highlight > 0) return 3;
  if (h.private > 0) return 2;
  if (h.message > 0) return 1;
  return 0;
}
