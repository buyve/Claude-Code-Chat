// Server-side SSH challenge-response authentication

import type { ServerWebSocket } from "bun";
import { generateChallenge, verifySignature, fingerprint } from "../shared/crypto.ts";
import { encodeMessage } from "../shared/protocol.ts";
import type { User } from "../shared/types.ts";

const AUTH_TIMEOUT_MS = 5000;

export interface PendingAuth {
  challenge: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface AuthState {
  pending: Map<ServerWebSocket<WSData>, PendingAuth>;
  authenticated: Map<ServerWebSocket<WSData>, User>;
}

export interface WSData {
  id: string;
}

export function createAuthState(): AuthState {
  return {
    pending: new Map(),
    authenticated: new Map(),
  };
}

/** Send a challenge to a newly connected WebSocket. */
export function sendChallenge(ws: ServerWebSocket<WSData>, auth: AuthState) {
  const challenge = generateChallenge();
  const timer = setTimeout(() => {
    // Auth timeout — close connection
    if (auth.pending.has(ws)) {
      ws.send(encodeMessage({ type: "auth_fail", reason: "Auth timeout" }));
      auth.pending.delete(ws);
      ws.close(4001, "Auth timeout");
    }
  }, AUTH_TIMEOUT_MS);

  auth.pending.set(ws, { challenge, timer });
  ws.send(encodeMessage({ type: "challenge", challenge }));
}

/** Handle an auth response. Returns the User on success, null on failure. */
export function handleAuth(
  ws: ServerWebSocket<WSData>,
  publicKey: string,
  signature: string,
  auth: AuthState,
  nickLookup: (fp: string) => string,
): User | null {
  const pendingAuth = auth.pending.get(ws);
  if (!pendingAuth) {
    ws.send(encodeMessage({ type: "auth_fail", reason: "No pending challenge" }));
    return null;
  }

  clearTimeout(pendingAuth.timer);
  auth.pending.delete(ws);

  const valid = verifySignature(pendingAuth.challenge, signature, publicKey);
  if (!valid) {
    ws.send(encodeMessage({ type: "auth_fail", reason: "Invalid signature" }));
    ws.close(4002, "Auth failed");
    return null;
  }

  const fp = fingerprint(publicKey);
  const nick = nickLookup(fp);

  const user: User = {
    id: fp,
    nick,
    publicKey,
    presence: "online",
  };

  auth.authenticated.set(ws, user);
  return user;
}

/** Get the authenticated user for a WebSocket. */
export function getUser(ws: ServerWebSocket<WSData>, auth: AuthState): User | null {
  return auth.authenticated.get(ws) ?? null;
}

/** Remove a disconnected WebSocket from auth state. */
export function removeConnection(ws: ServerWebSocket<WSData>, auth: AuthState): User | null {
  const user = auth.authenticated.get(ws) ?? null;
  auth.authenticated.delete(ws);
  const pending = auth.pending.get(ws);
  if (pending) {
    clearTimeout(pending.timer);
    auth.pending.delete(ws);
  }
  return user;
}

/** Find WebSocket(s) for a given user ID. */
export function findSockets(
  userId: string,
  auth: AuthState,
): ServerWebSocket<WSData>[] {
  const sockets: ServerWebSocket<WSData>[] = [];
  for (const [ws, user] of auth.authenticated) {
    if (user.id === userId) sockets.push(ws);
  }
  return sockets;
}
