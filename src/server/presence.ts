// Server-side presence tracking — grace period, DND suppression

import type { PresenceStatus, RichPresence, User } from "../shared/types.ts";

const OFFLINE_GRACE_MS = 30_000; // 30s before marking offline

interface PresenceEntry {
  status: PresenceStatus;
  richPresence?: RichPresence;
  lastSeen: number;
  graceTimer?: ReturnType<typeof setTimeout>;
}

export interface PresenceManager {
  update(userId: string, status: PresenceStatus, rich?: RichPresence): void;
  get(userId: string): PresenceEntry | undefined;
  disconnect(userId: string, onOffline: (userId: string) => void): void;
  reconnect(userId: string): void;
  isDnd(userId: string): boolean;
  getAll(): Map<string, PresenceEntry>;
}

export function createPresenceManager(): PresenceManager {
  const entries = new Map<string, PresenceEntry>();

  return {
    update(userId: string, status: PresenceStatus, rich?: RichPresence) {
      const existing = entries.get(userId);
      if (existing?.graceTimer) {
        clearTimeout(existing.graceTimer);
      }
      entries.set(userId, {
        status,
        richPresence: rich,
        lastSeen: Date.now(),
      });
    },

    get(userId: string) {
      return entries.get(userId);
    },

    disconnect(userId: string, onOffline: (userId: string) => void) {
      const entry = entries.get(userId);
      if (!entry) return;

      // Start grace period
      entry.graceTimer = setTimeout(() => {
        entry.status = "offline";
        entry.graceTimer = undefined;
        onOffline(userId);
      }, OFFLINE_GRACE_MS);
    },

    reconnect(userId: string) {
      const entry = entries.get(userId);
      if (entry?.graceTimer) {
        clearTimeout(entry.graceTimer);
        entry.graceTimer = undefined;
      }
    },

    isDnd(userId: string): boolean {
      return entries.get(userId)?.status === "dnd";
    },

    getAll() {
      return entries;
    },
  };
}
