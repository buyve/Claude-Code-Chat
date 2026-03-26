// Channel & DM routing — manages membership, join/part, broadcast targets

import type { User } from "../shared/types.ts";
import type { Store } from "./store.ts";

const DEFAULT_CHANNELS = ["#general", "#dev", "#help"];
const MAX_CHANNELS = 50; // prevent unbounded channel creation

export interface ChannelManager {
  join(user: User, channel: string): boolean;
  part(user: User, channel: string): void;
  getMembers(channel: string): string[];
  getUserChannels(userId: string): string[];
  exists(channel: string): boolean;
}

export function createChannelManager(store: Store): ChannelManager {
  // In-memory membership (fast lookups). SQLite persists across restarts.
  const members = new Map<string, Set<string>>(); // channel -> Set<userId>

  // Initialize default channels
  for (const ch of DEFAULT_CHANNELS) {
    members.set(ch, new Set());
  }

  // Restore persisted memberships from SQLite
  const persisted = store.getAllChannelMembers();
  for (const [ch, memberSet] of persisted) {
    if (!members.has(ch)) members.set(ch, new Set());
    for (const userId of memberSet) {
      members.get(ch)!.add(userId);
    }
  }

  return {
    join(user: User, channel: string): boolean {
      if (!members.has(channel)) {
        if (members.size >= MAX_CHANNELS) return false;
        members.set(channel, new Set());
      }
      const isNew = !members.get(channel)!.has(user.id);
      members.get(channel)!.add(user.id);
      if (isNew) store.saveChannelMember(channel, user.id);
      return true;
    },

    part(user: User, channel: string) {
      members.get(channel)?.delete(user.id);
      store.removeChannelMember(channel, user.id);
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
