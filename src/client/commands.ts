// Slash command handler — parse and dispatch /commands

import type { Message, MessageType } from "../shared/types.ts";

export interface CommandResult {
  // What the command produced
  type: "message" | "action" | "system" | "none";
  // For local display
  messages?: Message[];
  // For server (Phase 2)
  serverAction?: ServerAction;
}

export type ServerAction =
  | { type: "join"; channel: string }
  | { type: "part"; channel: string; message?: string }
  | { type: "dm"; to: string; content: string }
  | { type: "nick"; nick: string }
  | { type: "dnd" }
  | { type: "action"; channel: string; content: string };

function sysMsg(content: string, msgType: MessageType = "network"): Message {
  return {
    id: crypto.randomUUID(),
    from: "",
    fromNick: "",
    channel: "",
    content,
    timestamp: Date.now(),
    type: msgType,
  };
}

function errMsg(content: string): Message {
  return sysMsg(content, "error");
}

// All known commands
export const COMMANDS = [
  "join", "part", "msg", "nick", "dnd", "me", "help", "clear", "quit",
];

const HELP_TEXT = [
  "/join #channel   — Join a channel",
  "/part [message]  — Leave current channel",
  "/msg nick text   — Send a direct message",
  "/nick newnick    — Change your nickname",
  "/dnd             — Toggle Do Not Disturb",
  "/me action       — Send an action message",
  "/clear           — Clear chat buffer",
  "/quit            — Quit CCC",
  "/help            — Show this help",
];

export function handleCommand(
  input: string,
  currentChannel: string,
): CommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { type: "none" };
  }

  const parts = trimmed.slice(1).split(" ");
  const cmd = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1).join(" ");

  switch (cmd) {
    case "help":
      return {
        type: "system",
        messages: HELP_TEXT.map((t) => sysMsg(t)),
      };

    case "join": {
      const channel = args.trim();
      if (!channel) return { type: "system", messages: [errMsg("Usage: /join #channel")] };
      const name = channel.startsWith("#") ? channel : `#${channel}`;
      return {
        type: "system",
        serverAction: { type: "join", channel: name },
        messages: [sysMsg(`Joining ${name}...`)],
      };
    }

    case "part": {
      return {
        type: "system",
        serverAction: { type: "part", channel: currentChannel, message: args || undefined },
        messages: [sysMsg(`Leaving ${currentChannel}...`)],
      };
    }

    case "msg": {
      const spaceIdx = args.indexOf(" ");
      if (spaceIdx === -1 || !args.trim()) {
        return { type: "system", messages: [errMsg("Usage: /msg nick message")] };
      }
      const to = args.slice(0, spaceIdx);
      const content = args.slice(spaceIdx + 1);
      return {
        type: "system",
        serverAction: { type: "dm", to, content },
        messages: [sysMsg(`DM to ${to}: ${content}`)],
      };
    }

    case "nick": {
      const nick = args.trim();
      if (!nick) return { type: "system", messages: [errMsg("Usage: /nick newnick")] };
      return {
        type: "system",
        serverAction: { type: "nick", nick },
        messages: [sysMsg(`Changing nick to ${nick}...`)],
      };
    }

    case "dnd":
      return {
        type: "system",
        serverAction: { type: "dnd" },
        messages: [sysMsg("Toggling DND mode...")],
      };

    case "me": {
      if (!args.trim()) return { type: "system", messages: [errMsg("Usage: /me action")] };
      return {
        type: "action",
        serverAction: { type: "action", channel: currentChannel, content: args },
      };
    }

    case "clear":
      return { type: "system", messages: [] }; // app.ts handles clearing

    case "quit":
      return { type: "system" }; // app.ts handles quit confirmation

    default:
      return {
        type: "system",
        messages: [errMsg(`Unknown command: /${cmd}. Type /help for available commands.`)],
      };
  }
}
