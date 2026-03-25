// CCC WebSocket server — Bun.serve with auth, heartbeat, health check

import {
  createAuthState,
  sendChallenge,
  handleAuth,
  getUser,
  removeConnection,
  findSockets,
  type AuthState,
  type WSData,
} from "./auth.ts";
import { createStore, type Store } from "./store.ts";
import { createChannelManager, type ChannelManager } from "./channels.ts";
import { decodeMessage, encodeMessage } from "../shared/protocol.ts";
import type { ClientMessage } from "../shared/protocol.ts";
import type { Message, User } from "../shared/types.ts";

const PORT = parseInt(process.env["CCC_PORT"] ?? "3337", 10);
const HOST = process.env["CCC_HOST"] ?? "0.0.0.0";

const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 60_000;

interface ServerState {
  auth: AuthState;
  store: Store;
  channels: ChannelManager;
  lastPong: Map<string, number>; // ws id -> timestamp
}

function createServerState(dbPath?: string): ServerState {
  const store = createStore(dbPath);
  return {
    auth: createAuthState(),
    store,
    channels: createChannelManager(store),
    lastPong: new Map(),
  };
}

export function startServer(dbPath?: string) {
  const state = createServerState(dbPath);
  let wsIdCounter = 0;

  const server = Bun.serve<WSData>({
    hostname: HOST,
    port: PORT,

    fetch(req, server) {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === "/health") {
        return new Response("OK", { status: 200 });
      }

      // WebSocket upgrade
      const upgraded = server.upgrade(req, {
        data: { id: String(++wsIdCounter) },
      });
      if (upgraded) return undefined;

      return new Response("CCC WebSocket Server", { status: 200 });
    },

    websocket: {
      open(ws: import("bun").ServerWebSocket<WSData>) {
        state.lastPong.set(ws.data.id, Date.now());
        sendChallenge(ws, state.auth);
      },

      message(ws: import("bun").ServerWebSocket<WSData>, raw: string | Buffer) {
        const data = typeof raw === "string" ? raw : raw.toString("utf-8");
        const msg = decodeMessage(data);
        if (!msg) {
          ws.send(encodeMessage({ type: "error", code: "INVALID_JSON", message: "Malformed message" }));
          return;
        }

        try {
          handleMessage(ws, msg as ClientMessage, state);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : "Unknown error";
          ws.send(encodeMessage({ type: "error", code: "INTERNAL", message: errMsg }));
        }
      },

      close(ws: import("bun").ServerWebSocket<WSData>) {
        const user = removeConnection(ws, state.auth);
        state.lastPong.delete(ws.data.id);
        if (user) {
          // Broadcast part messages for all channels the user was in
          const userChannels = state.channels.getUserChannels(user.id);
          for (const ch of userChannels) {
            state.channels.part(user, ch);
            broadcast(state, ch, encodeMessage({
              type: "part",
              channel: ch,
              userId: user.id,
              nick: user.nick,
              message: "Connection lost",
            }));
          }
        }
      },

      // Bun WebSocket pong handler for heartbeat
      pong(ws: import("bun").ServerWebSocket<WSData>) {
        state.lastPong.set(ws.data.id, Date.now());
      },
    },
  });

  // Heartbeat interval
  setInterval(() => {
    const now = Date.now();
    for (const [ws, user] of state.auth.authenticated) {
      const lastPong = state.lastPong.get(ws.data.id) ?? 0;
      if (now - lastPong > HEARTBEAT_TIMEOUT) {
        ws.close(4003, "Heartbeat timeout");
      } else {
        ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL);

  console.log(`CCC server listening on ${HOST}:${PORT}`);
  return server;
}

function handleMessage(
  ws: import("bun").ServerWebSocket<WSData>,
  msg: ClientMessage,
  state: ServerState,
) {
  // Auth message (before authenticated)
  if (msg.type === "auth") {
    const user = handleAuth(
      ws,
      msg.publicKey,
      msg.signature,
      state.auth,
      (fp) => state.store.getNick(fp) ?? `user_${fp.slice(0, 8)}`,
    );
    if (user) {
      // Persist nick
      state.store.setNick(user.id, user.nick);

      ws.send(encodeMessage({ type: "auth_ok", user }));

      // Auto-join #general
      state.channels.join(user, "#general");

      // Send channel members
      const members = state.channels.getMembers("#general");
      const memberUsers = getMemberUsers(members, state);
      ws.send(encodeMessage({ type: "members", channel: "#general", members: memberUsers }));

      // Send history
      const history = state.store.getHistory("#general");
      ws.send(encodeMessage({ type: "history", channel: "#general", messages: history }));

      // Broadcast join to others
      broadcast(state, "#general", encodeMessage({
        type: "join",
        channel: "#general",
        user,
      }), user.id);
    }
    return;
  }

  // All other messages require auth
  const user = getUser(ws, state.auth);
  if (!user) {
    ws.send(encodeMessage({ type: "error", code: "NOT_AUTH", message: "Not authenticated" }));
    return;
  }

  switch (msg.type) {
    case "chat": {
      const chatMsg: Message = {
        id: crypto.randomUUID(),
        from: user.id,
        fromNick: user.nick,
        channel: msg.channel,
        content: msg.content,
        timestamp: Date.now(),
        type: "chat",
      };
      state.store.addMessage(chatMsg);
      broadcast(state, msg.channel, encodeMessage({ type: "chat", message: chatMsg }));
      break;
    }

    case "action": {
      const actionMsg: Message = {
        id: crypto.randomUUID(),
        from: user.id,
        fromNick: user.nick,
        channel: msg.channel,
        content: msg.content,
        timestamp: Date.now(),
        type: "action",
      };
      state.store.addMessage(actionMsg);
      broadcast(state, msg.channel, encodeMessage({ type: "chat", message: actionMsg }));
      break;
    }

    case "join": {
      state.channels.join(user, msg.channel);
      broadcast(state, msg.channel, encodeMessage({
        type: "join",
        channel: msg.channel,
        user,
      }));

      // Send history + members to the joining user
      const members = state.channels.getMembers(msg.channel);
      const memberUsers = getMemberUsers(members, state);
      ws.send(encodeMessage({ type: "members", channel: msg.channel, members: memberUsers }));
      const history = state.store.getHistory(msg.channel);
      ws.send(encodeMessage({ type: "history", channel: msg.channel, messages: history }));
      break;
    }

    case "part": {
      state.channels.part(user, msg.channel);
      broadcast(state, msg.channel, encodeMessage({
        type: "part",
        channel: msg.channel,
        userId: user.id,
        nick: user.nick,
        message: msg.message,
      }));
      break;
    }

    case "dm": {
      const dmChannel = dmChannelName(user.id, msg.to);
      const dmMsg: Message = {
        id: crypto.randomUUID(),
        from: user.id,
        fromNick: user.nick,
        channel: dmChannel,
        content: msg.content,
        timestamp: Date.now(),
        type: "chat",
      };
      state.store.addMessage(dmMsg);

      // Send to recipient
      const recipientSockets = findSockets(msg.to, state.auth);
      for (const s of recipientSockets) {
        s.send(encodeMessage({ type: "chat", message: dmMsg }));
      }
      // Echo back to sender
      ws.send(encodeMessage({ type: "chat", message: dmMsg }));
      break;
    }

    case "nick": {
      const oldNick = user.nick;
      const newNick = msg.nick.trim();

      if (!newNick || newNick.length > 20) {
        ws.send(encodeMessage({ type: "error", code: "INVALID_NICK", message: "Nick must be 1-20 chars" }));
        break;
      }

      // Check uniqueness
      if (state.store.nickExists(newNick, user.id)) {
        ws.send(encodeMessage({ type: "error", code: "NICK_TAKEN", message: `Nick '${newNick}' is already taken` }));
        break;
      }

      user.nick = newNick;
      state.store.setNick(user.id, newNick);

      // Broadcast nick change to all channels the user is in
      const userChannels = state.channels.getUserChannels(user.id);
      for (const ch of userChannels) {
        broadcast(state, ch, encodeMessage({
          type: "nick_change",
          userId: user.id,
          oldNick,
          newNick,
        }));
      }
      break;
    }

    case "presence": {
      user.presence = msg.status;
      if (msg.rich) user.richPresence = msg.rich;

      const userChannels = state.channels.getUserChannels(user.id);
      for (const ch of userChannels) {
        broadcast(state, ch, encodeMessage({
          type: "presence_update",
          userId: user.id,
          status: msg.status,
          rich: msg.rich,
        }));
      }
      break;
    }
  }
}

/** Broadcast a message to all members of a channel, optionally excluding a user. */
function broadcast(state: ServerState, channel: string, data: string, excludeUserId?: string) {
  const members = state.channels.getMembers(channel);
  for (const memberId of members) {
    if (memberId === excludeUserId) continue;
    const sockets = findSockets(memberId, state.auth);
    for (const s of sockets) {
      s.send(data);
    }
  }
}

/** Get User objects for a list of member IDs. */
function getMemberUsers(memberIds: string[], state: ServerState): User[] {
  const users: User[] = [];
  for (const id of memberIds) {
    // Find from authenticated connections
    for (const [, user] of state.auth.authenticated) {
      if (user.id === id) {
        users.push(user);
        break;
      }
    }
  }
  return users;
}

/** Generate a deterministic DM channel name. */
function dmChannelName(a: string, b: string): string {
  const sorted = [a, b].sort();
  return `dm:${sorted[0]}:${sorted[1]}`;
}
