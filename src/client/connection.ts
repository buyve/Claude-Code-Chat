// WebSocket client connection with auto-auth and reconnect

import WebSocket from "ws";
import { loadOrGenerateKey, signChallenge } from "../shared/crypto.ts";
import { encodeMessage, decodeMessage } from "../shared/protocol.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

const DEFAULT_URL = "ws://localhost:3337";
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 16000;

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface ConnectionHandler {
  onMessage: (msg: ServerMessage) => void;
  onStatusChange: (status: ConnectionStatus, detail?: string) => void;
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

        handler.onMessage(serverMsg);
      } catch {
        // Malformed message — ignore silently
      }
    });

    ws.on("close", () => {
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
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      ws = null;
    },

    getStatus() {
      return status;
    },
  };
}
