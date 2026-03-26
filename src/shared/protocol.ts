// WebSocket message protocol — discriminated union

import type { Message, PresenceStatus, RichPresence, User } from "./types.ts";

// Client -> Server messages
export type ClientMessage =
  | { type: "auth"; publicKey: string; signature: string }
  | { type: "chat"; channel: string; content: string }
  | { type: "action"; channel: string; content: string }
  | { type: "join"; channel: string }
  | { type: "part"; channel: string; message?: string }
  | { type: "dm"; to: string; content: string }
  | { type: "nick"; nick: string }
  | { type: "presence"; status: PresenceStatus; rich?: RichPresence };

// Server -> Client messages
export type ServerMessage =
  | { type: "challenge"; challenge: string }
  | { type: "auth_ok"; user: User }
  | { type: "auth_fail"; reason: string }
  | { type: "chat"; message: Message }
  | { type: "join"; channel: string; user: User }
  | { type: "part"; channel: string; userId: string; nick: string; message?: string }
  | { type: "members"; channel: string; members: User[] }
  | { type: "history"; channel: string; messages: Message[] }
  | { type: "nick_change"; userId: string; oldNick: string; newNick: string }
  | { type: "presence_update"; userId: string; status: PresenceStatus; rich?: RichPresence }
  | { type: "error"; code: string; message: string };

export type WSMessage = ClientMessage | ServerMessage;

export function encodeMessage(msg: WSMessage): string {
  return JSON.stringify(msg);
}

const VALID_TYPES = new Set([
  "auth", "chat", "action", "join", "part", "dm", "nick", "presence",
  "challenge", "auth_ok", "auth_fail", "members", "history",
  "nick_change", "presence_update", "error",
]);

export function decodeMessage(raw: string): WSMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return null;
    if (!VALID_TYPES.has(parsed.type)) return null;
    return parsed as WSMessage;
  } catch {
    return null;
  }
}
