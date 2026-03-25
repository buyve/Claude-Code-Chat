// Channel & DM routing — manages membership, join/part, broadcast targets

import type { User } from "../shared/types.ts";
import type { Store } from "./store.ts";

const DEFAULT_CHANNELS = ["#general", "#dev", "#help"];

export interface ChannelManager {
  join(user: User, channel: string): void;
  part(user: User, channel: string): void;
  getMembers(channel: string): string[];
  getUserChannels(userId: string): string[];
  exists(channel: string): boolean;
}

export function createChannelManager(store: Store): ChannelManager {
  // In-memory membership (fast lookups). SQLite is for persistence across restarts.
  const members = new Map<string, Set<string>>(); // channel -> Set<userId>

  // Initialize default channels
  for (const ch of DEFAULT_CHANNELS) {
    members.set(ch, new Set());
  }

  return {
    join(user: User, channel: string) {
      if (!members.has(channel)) {
        members.set(channel, new Set());
      }
      members.get(channel)!.add(user.id);
    },

    part(user: User, channel: string) {
      members.get(channel)?.delete(user.id);
    },

    getMembers(channel: string): string[] {
      return Array.from(members.get(channel) ?? []);
    },

    getUserChannels(userId: string): string[] {
      const result: string[] = [];
      for (const [ch, memberSet] of members) {
        if (memberSet.has(userId)) result.push(ch);
      }
      return result;
    },

    exists(channel: string): boolean {
      return members.has(channel);
    },
  };
}
