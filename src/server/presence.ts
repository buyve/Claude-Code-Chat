// Server-side presence tracking — grace period, DND suppression

import type { PresenceStatus, RichPresence, User } from "../shared/types.ts";

const OFFLINE_GRACE_MS = 30_000; // 30s before marking offline

interface PresenceEntry {
  status: PresenceStatus;
  richPresence?: RichPresence;
  lastSeen: number;
  graceTimer?: ReturnType<typeof setTimeout>;
  generation: number; // prevents stale grace timers from overwriting fresh state
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
      const gen = (existing?.generation ?? 0) + 1;
      entries.set(userId, {
        status,
        richPresence: rich,
        lastSeen: Date.now(),
        generation: gen,
      });
    },

    get(userId: string) {
      return entries.get(userId);
    },

    disconnect(userId: string, onOffline: (userId: string) => void) {
      const entry = entries.get(userId);
      if (!entry) return;

      // Capture generation at disconnect time
      const gen = entry.generation;
      entry.graceTimer = setTimeout(() => {
        // Only fire if generation hasn't changed (no reconnect happened)
        const current = entries.get(userId);
        if (current && current.generation === gen) {
          current.status = "offline";
          current.graceTimer = undefined;
          onOffline(userId);
        }
      }, OFFLINE_GRACE_MS);
    },

    reconnect(userId: string) {
      const entry = entries.get(userId);
      if (entry) {
        if (entry.graceTimer) {
          clearTimeout(entry.graceTimer);
          entry.graceTimer = undefined;
        }
        // Bump generation to invalidate any pending grace timers
        entry.generation++;
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
