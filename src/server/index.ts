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
import { createPresenceManager, type PresenceManager } from "./presence.ts";
import { decodeMessage, encodeMessage } from "../shared/protocol.ts";
import type { ClientMessage } from "../shared/protocol.ts";
import type { Message, User } from "../shared/types.ts";

// Strip ANSI escape sequences from user-generated content (prevent terminal injection)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\x9b][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const PORT = parseInt(process.env["CCC_PORT"] ?? "3337", 10);
const HOST = process.env["CCC_HOST"] ?? "0.0.0.0";

const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 60_000;

// Simple per-user rate limiter (token bucket)
const RATE_LIMIT_TOKENS = 10; // max burst
const RATE_LIMIT_REFILL_MS = 1000; // refill 1 token per this interval
interface RateBucket { tokens: number; lastRefill: number; }

function checkRateLimit(buckets: Map<string, RateBucket>, userId: string): boolean {
  const now = Date.now();
  let bucket = buckets.get(userId);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_TOKENS, lastRefill: now };
    buckets.set(userId, bucket);
  }
  // Refill tokens
  const elapsed = now - bucket.lastRefill;
  const refill = Math.floor(elapsed / RATE_LIMIT_REFILL_MS);
  if (refill > 0) {
    bucket.tokens = Math.min(RATE_LIMIT_TOKENS, bucket.tokens + refill);
    bucket.lastRefill = now;
  }
  if (bucket.tokens > 0) {
    bucket.tokens--;
    return true;
  }
  return false;
}

interface ServerState {
  auth: AuthState;
  store: Store;
  channels: ChannelManager;
  presence: PresenceManager;
  lastPong: Map<string, number>;
  rateBuckets: Map<string, RateBucket>;
  userRegistry: Map<string, User>; // shared User per userId (multi-socket consistency)
}

function createServerState(dbPath?: string): ServerState {
  const store = createStore(dbPath);
  return {
    auth: createAuthState(),
    store,
    channels: createChannelManager(store),
    presence: createPresenceManager(),
    lastPong: new Map(),
    rateBuckets: new Map(),
    userRegistry: new Map(),
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
          // If user still has other active sockets, no action needed
          if (findSockets(user.id, state.auth).length > 0) return;

          // Last socket closed — preserve channel membership, start grace period
          // Channels are kept intact so reconnect within 30s restores everything
          state.presence.disconnect(user.id, (userId) => {
            // Grace period expired — user didn't reconnect in time
            const currentUser = state.userRegistry.get(userId);
            const nick = currentUser?.nick ?? user.nick;
            const userChannels = state.channels.getUserChannels(userId);

            // Broadcast part to all channels before removing membership
            for (const ch of userChannels) {
              broadcast(state, ch, encodeMessage({
                type: "part",
                channel: ch,
                userId,
                nick,
                message: "Connection lost",
              }));
            }
            // Remove from channels after broadcast (so members list is intact)
            for (const ch of userChannels) {
              if (currentUser) state.channels.part(currentUser, ch);
            }
            // Clean up user registry
            state.userRegistry.delete(userId);
          });
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
    let user = handleAuth(
      ws,
      msg.publicKey,
      msg.signature,
      state.auth,
      (fp) => state.store.getNick(fp) ?? `user_${fp.slice(0, 8)}`,
    );
    if (user) {
      // Ensure shared User object per userId (multi-socket consistency)
      const existing = state.userRegistry.get(user.id);
      if (existing) {
        // Reuse existing — all sockets share one User object
        state.auth.authenticated.set(ws, existing);
        user = existing;
      } else {
        state.userRegistry.set(user.id, user);
      }

      state.store.setNick(user.id, user.nick);
      state.presence.reconnect(user.id);
      state.presence.update(user.id, "online");
      user.presence = "online";

      ws.send(encodeMessage({ type: "auth_ok", user }));

      // Check if user already has channels (reconnect within grace period)
      const existingChannels = state.channels.getUserChannels(user.id);
      if (existingChannels.length > 0) {
        // Restore all channels — send history + members for each
        for (const ch of existingChannels) {
          const chMembers = state.channels.getMembers(ch);
          const chMemberUsers = getMemberUsers(chMembers, state);
          ws.send(encodeMessage({ type: "members", channel: ch, members: chMemberUsers }));
          const chHistory = state.store.getHistory(ch);
          ws.send(encodeMessage({ type: "history", channel: ch, messages: chHistory }));
        }
        // Notify others that user is back online
        for (const ch of existingChannels) {
          broadcast(state, ch, encodeMessage({
            type: "presence_update",
            userId: user.id,
            status: "online",
          }), user.id);
        }
      } else {
        // First connect or after grace period expired — auto-join #general
        state.channels.join(user, "#general");
        const members = state.channels.getMembers("#general");
        const memberUsers = getMemberUsers(members, state);
        ws.send(encodeMessage({ type: "members", channel: "#general", members: memberUsers }));
        const history = state.store.getHistory("#general");
        ws.send(encodeMessage({ type: "history", channel: "#general", messages: history }));
        broadcast(state, "#general", encodeMessage({
          type: "join", channel: "#general", user,
        }), user.id);
      }
    }
    return;
  }

  // All other messages require auth
  const user = getUser(ws, state.auth);
  if (!user) {
    ws.send(encodeMessage({ type: "error", code: "NOT_AUTH", message: "Not authenticated" }));
    return;
  }

  // Rate limit chat/action messages
  if ((msg.type === "chat" || msg.type === "action") && !checkRateLimit(state.rateBuckets, user.id)) {
    ws.send(encodeMessage({ type: "error", code: "RATE_LIMITED", message: `Slow down — retry in ~${Math.ceil(RATE_LIMIT_REFILL_MS / 1000)}s` }));
    return;
  }

  switch (msg.type) {
    case "chat": {
      if (msg.content.length > 4096) {
        ws.send(encodeMessage({ type: "error", code: "MSG_TOO_LONG", message: "Message exceeds 4096 characters" }));
        break;
      }
      // Verify sender is a member of the target channel
      if (!state.channels.getMembers(msg.channel).includes(user.id)) {
        ws.send(encodeMessage({ type: "error", code: "NOT_IN_CHANNEL", message: "You are not in that channel" }));
        break;
      }
      const chatMsg: Message = {
        id: crypto.randomUUID(),
        from: user.id,
        fromNick: user.nick,
        channel: msg.channel,
        content: stripAnsi(msg.content),
        timestamp: Date.now(),
        type: "chat",
      };
      state.store.addMessage(chatMsg);
      broadcast(state, msg.channel, encodeMessage({ type: "chat", message: chatMsg }));
      break;
    }

    case "action": {
      if (msg.content.length > 4096) {
        ws.send(encodeMessage({ type: "error", code: "MSG_TOO_LONG", message: "Action exceeds 4096 characters" }));
        break;
      }
      // Verify sender is a member of the target channel
      if (!state.channels.getMembers(msg.channel).includes(user.id)) {
        ws.send(encodeMessage({ type: "error", code: "NOT_IN_CHANNEL", message: "You are not in that channel" }));
        break;
      }
      const actionMsg: Message = {
        id: crypto.randomUUID(),
        from: user.id,
        fromNick: user.nick,
        channel: msg.channel,
        content: stripAnsi(msg.content),
        timestamp: Date.now(),
        type: "action",
      };
      state.store.addMessage(actionMsg);
      broadcast(state, msg.channel, encodeMessage({ type: "chat", message: actionMsg }));
      break;
    }

    case "join": {
      // Channel: # + 1-49 non-whitespace, non-control chars
      // eslint-disable-next-line no-control-regex
      if (!/^#[^\s\x00-\x1f\x7f]{1,49}$/.test(msg.channel)) {
        ws.send(encodeMessage({ type: "error", code: "INVALID_CHANNEL", message: "Channel must be #name (1-49 non-whitespace chars)" }));
        break;
      }
      if (!state.channels.join(user, msg.channel)) {
        ws.send(encodeMessage({ type: "error", code: "TOO_MANY_CHANNELS", message: "Server channel limit reached" }));
        break;
      }
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
      const recipientSockets = findSockets(msg.to, state.auth);
      if (recipientSockets.length === 0) {
        ws.send(encodeMessage({ type: "error", code: "USER_NOT_FOUND", message: "User not online" }));
        break;
      }

      // Warn sender if recipient is in DND mode
      if (state.presence.isDnd(msg.to)) {
        ws.send(encodeMessage({ type: "error", code: "USER_DND", message: "User is in Do Not Disturb mode — message delivered silently" }));
      }

      const dmChannel = dmChannelName(user.id, msg.to);
      // Track DM channel membership so history is accessible
      state.channels.join(user, dmChannel);
      // Find recipient user object for join
      for (const [, u] of state.auth.authenticated) {
        if (u.id === msg.to) { state.channels.join(u, dmChannel); break; }
      }
      const dmMsg: Message = {
        id: crypto.randomUUID(),
        from: user.id,
        fromNick: user.nick,
        channel: dmChannel,
        content: stripAnsi(msg.content),
        timestamp: Date.now(),
        type: "chat",
      };
      state.store.addMessage(dmMsg);

      for (const s of recipientSockets) {
        s.send(encodeMessage({ type: "chat", message: dmMsg }));
      }
      // Echo back to sender
      ws.send(encodeMessage({ type: "chat", message: dmMsg }));
      break;
    }

    case "nick": {
      const oldNick = user.nick;
      const newNick = stripAnsi(msg.nick.trim());

      // eslint-disable-next-line no-control-regex
      if (!newNick || newNick.length > 20 || /[\x00-\x1f\x7f]/.test(newNick)) {
        ws.send(encodeMessage({ type: "error", code: "INVALID_NICK", message: "Nick must be 1-20 printable chars" }));
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
      const VALID_STATUSES = ["online", "coding", "reviewing", "dnd", "offline"];
      if (!VALID_STATUSES.includes(msg.status)) {
        ws.send(encodeMessage({ type: "error", code: "INVALID_STATUS", message: `Invalid presence: ${msg.status}` }));
        break;
      }
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
