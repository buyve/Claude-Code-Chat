// WebSocket client connection with auto-auth and reconnect

import WebSocket from "ws";
import { loadOrGenerateKey, signChallenge } from "../shared/crypto.ts";
import { encodeMessage, decodeMessage } from "../shared/protocol.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

const DEFAULT_URL = "ws://localhost:3337";
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 16000;

// Strip ANSI escape sequences from server-provided user content (prevent terminal injection)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\x9b][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Sanitize user-generated fields in server messages to prevent terminal injection. */
function sanitizeServerMessage(msg: ServerMessage): ServerMessage {
  switch (msg.type) {
    case "chat":
      msg.message.content = stripAnsi(msg.message.content);
      msg.message.fromNick = stripAnsi(msg.message.fromNick);
      return msg;
    case "history":
      for (const m of msg.messages) {
        m.content = stripAnsi(m.content);
        m.fromNick = stripAnsi(m.fromNick);
      }
      return msg;
    case "join":
      msg.user.nick = stripAnsi(msg.user.nick);
      return msg;
    case "part":
      msg.nick = stripAnsi(msg.nick);
      if (msg.message) msg.message = stripAnsi(msg.message);
      return msg;
    case "nick_change":
      msg.oldNick = stripAnsi(msg.oldNick);
      msg.newNick = stripAnsi(msg.newNick);
      return msg;
    case "members":
      for (const u of msg.members) {
        u.nick = stripAnsi(u.nick);
      }
      return msg;
    case "error":
      msg.message = stripAnsi(msg.message);
      return msg;
    default:
      return msg;
  }
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface ConnectionHandler {
  onMessage: (msg: ServerMessage) => void;
  onStatusChange: (status: ConnectionStatus, detail?: string) => void;
  onLagUpdate?: (lagMs: number) => void;
}

export interface Connection {
  send(msg: ClientMessage): void;
  close(): void;
  getStatus(): ConnectionStatus;
}

export function createConnection(handler: ConnectionHandler): Connection {
  const url = process.env["CCC_SERVER"] ?? DEFAULT_URL;
  let key: ReturnType<typeof loadOrGenerateKey>;
  try {
    key = loadOrGenerateKey();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    handler.onStatusChange("disconnected", `SSH key error: ${msg}`);
    return { send() {}, close() {}, getStatus: () => "disconnected" as ConnectionStatus };
  }
  let ws: WebSocket | null = null;
  let status: ConnectionStatus = "disconnected";
  let reconnectDelay = RECONNECT_BASE;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pingStart = 0;
  let closed = false;

  function setStatus(s: ConnectionStatus, detail?: string) {
    status = s;
    handler.onStatusChange(s, detail);
  }

  function connect() {
    if (closed) return;

    setStatus("connecting");
    ws = new WebSocket(url);

    ws.on("open", () => {
      reconnectDelay = RECONNECT_BASE; // reset on successful connect
      // Start periodic ping for lag measurement
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          pingStart = Date.now();
          ws.ping();
        }
      }, 15_000);
    });

    ws.on("pong", () => {
      if (pingStart > 0) {
        handler.onLagUpdate?.(Date.now() - pingStart);
        pingStart = 0;
      }
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const raw = typeof data === "string" ? data : data.toString("utf-8");
        const msg = decodeMessage(raw);
        if (!msg) return;

        const serverMsg = msg as ServerMessage;

        // Handle auth flow internally
        if (serverMsg.type === "challenge") {
          const signature = signChallenge(serverMsg.challenge, key.privatePath);
          ws?.send(encodeMessage({
            type: "auth",
            publicKey: key.publicKey,
            signature,
          }));
          return;
        }

        if (serverMsg.type === "auth_ok") {
          setStatus("connected");
        }

        handler.onMessage(sanitizeServerMessage(serverMsg));
      } catch {
        // Malformed message — ignore silently
      }
    });

    ws.on("close", () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      ws = null;
      if (!closed) {
        setStatus("disconnected", `retrying ${Math.round(reconnectDelay / 1000)}s...`);
        scheduleReconnect();
      }
    });

    ws.on("error", () => {
      // close event will fire after this
    });
  }

  function scheduleReconnect() {
    if (closed) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  }

  // Start initial connection
  connect();

  return {
    send(msg: ClientMessage) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeMessage(msg));
      }
    },

    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
      setStatus("disconnected");
    },

    getStatus() {
      return status;
    },
  };
}
