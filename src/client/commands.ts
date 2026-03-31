// Slash command handler — parse and dispatch /commands

import type { Message, MessageType, User } from "../shared/types.ts";

export interface CommandResult {
  type: "message" | "action" | "system" | "none";
  messages?: Message[];
  serverAction?: ServerAction;
  clientAction?: ClientAction;
}

export type ServerAction =
  | { type: "join"; channel: string }
  | { type: "part"; channel: string; message?: string }
  | { type: "dm"; nick: string; content: string }
  | { type: "nick"; nick: string }
  | { type: "dnd" }
  | { type: "action"; channel: string; content: string }
  | { type: "topic"; channel: string; topic: string };

export type ClientAction =
  | { type: "ignore"; nick: string }
  | { type: "unignore"; nick: string }
  | { type: "buffer_close" }
  | { type: "search"; query: string };

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

export const COMMANDS = [
  "join", "part", "msg", "nick", "dnd", "me", "help", "clear", "quit",
  "topic", "whois", "list", "ignore", "unignore", "search", "close",
];

const HELP_TEXT = [
  "/join #channel   — Join a channel",
  "/part [message]  — Leave current channel",
  "/msg nick text   — Send a direct message",
  "/nick newnick    — Change your nickname",
  "/topic [text]    — View or set channel topic",
  "/dnd             — Toggle Do Not Disturb",
  "/me action       — Send an action message",
  "/whois nick      — Show user info",
  "/list            — List all channels",
  "/ignore nick     — Ignore a user",
  "/unignore nick   — Unignore a user",
  "/search text     — Search messages in current buffer",
  "/close           — Close current buffer",
  "/clear           — Clear chat buffer",
  "/quit            — Quit CCC",
  "/help            — Show this help",
];

/** Format user info for /whois display */
export function formatWhois(user: User): Message[] {
  const lines = [
    `${user.nick} [${user.id.slice(0, 16)}...]`,
    `  presence: ${user.presence}`,
  ];
  if (user.richPresence) {
    const rp = user.richPresence;
    lines.push(`  project: ${rp.project}`);
    if (rp.language) lines.push(`  language: ${rp.language}`);
    if (rp.duration) lines.push(`  active: ${rp.duration}m`);
  }
  return lines.map((l) => sysMsg(l));
}

export function handleCommand(
  input: string,
  currentChannel: string,
): CommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { type: "none" };

  const parts = trimmed.slice(1).split(" ");
  const cmd = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1).join(" ");

  switch (cmd) {
    case "help":
      return { type: "system", messages: HELP_TEXT.map((t) => sysMsg(t)) };

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

    case "part":
      return {
        type: "system",
        serverAction: { type: "part", channel: currentChannel, message: args || undefined },
        messages: [sysMsg(`Leaving ${currentChannel}...`)],
      };

    case "msg": {
      const spaceIdx = args.indexOf(" ");
      if (spaceIdx === -1 || !args.trim()) {
        return { type: "system", messages: [errMsg("Usage: /msg nick message")] };
      }
      const to = args.slice(0, spaceIdx);
      const content = args.slice(spaceIdx + 1);
      return {
        type: "system",
        serverAction: { type: "dm", nick: to, content },
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

    case "topic": {
      const topic = args.trim();
      if (!topic) {
        return { type: "system", messages: [sysMsg(`Topic: (view in titlebar)`)] };
      }
      return {
        type: "system",
        serverAction: { type: "topic", channel: currentChannel, topic },
        messages: [sysMsg(`Setting topic to: ${topic}`)],
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

    case "whois":
      // Handled in app.ts with user lookup — return marker
      if (!args.trim()) return { type: "system", messages: [errMsg("Usage: /whois nick")] };
      return { type: "system", clientAction: { type: "search", query: `__whois__${args.trim()}` } };

    case "list":
      // Handled in app.ts — return marker
      return { type: "system", clientAction: { type: "search", query: "__list__" } };

    case "ignore": {
      const nick = args.trim();
      if (!nick) return { type: "system", messages: [errMsg("Usage: /ignore nick")] };
      return {
        type: "system",
        clientAction: { type: "ignore", nick },
        messages: [sysMsg(`Ignoring ${nick}`)],
      };
    }

    case "unignore": {
      const nick = args.trim();
      if (!nick) return { type: "system", messages: [errMsg("Usage: /unignore nick")] };
      return {
        type: "system",
        clientAction: { type: "unignore", nick },
        messages: [sysMsg(`Unignoring ${nick}`)],
      };
    }

    case "search": {
      const query = args.trim();
      if (!query) return { type: "system", messages: [errMsg("Usage: /search text")] };
      return { type: "system", clientAction: { type: "search", query } };
    }

    case "close":
      return {
        type: "system",
        clientAction: { type: "buffer_close" },
      };

    case "clear":
      return { type: "system", messages: [] };

    case "quit":
      return { type: "system" };

    default:
      return {
        type: "system",
        messages: [errMsg(`Unknown command: /${cmd}. Type /help for available commands.`)],
      };
  }
}
