// SQLite message store — bun:sqlite, WAL mode, auto-prune

import { Database } from "bun:sqlite";
import type { Message } from "../shared/types.ts";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

const MAX_MESSAGES_PER_CHANNEL = 10_000;
const DEFAULT_HISTORY_LIMIT = 50;

export interface Store {
  addMessage(msg: Message): void;
  getHistory(channel: string, limit?: number): Message[];
  getNick(userId: string): string | null;
  setNick(userId: string, nick: string): void;
  nickExists(nick: string, excludeUserId?: string): boolean;
  close(): void;
}

export function createStore(dbPath?: string): Store {
  const isMemory = dbPath === ":memory:" || !dbPath;
  let finalPath = dbPath;

  if (!isMemory && finalPath) {
    const dir = dirname(finalPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(finalPath ?? ":memory:");

  // WAL mode for concurrent reads
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      from_id TEXT NOT NULL,
      from_nick TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_ts
    ON messages(channel, timestamp)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      public_key TEXT PRIMARY KEY,
      nick TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS channel_members (
      channel TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (channel, user_id)
    )
  `);

  // Prepared statements
  const insertMsg = db.prepare(`
    INSERT INTO messages (id, channel, from_id, from_nick, content, type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const selectHistory = db.prepare(`
    SELECT id, channel, from_id, from_nick, content, type, timestamp
    FROM messages
    WHERE channel = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);

  const countMsgs = db.prepare(`
    SELECT COUNT(*) as cnt FROM messages WHERE channel = ?
  `);

  const pruneOld = db.prepare(`
    DELETE FROM messages WHERE channel = ? AND id NOT IN (
      SELECT id FROM messages WHERE channel = ?
      ORDER BY timestamp DESC LIMIT ?
    )
  `);

  const selectNick = db.prepare(`
    SELECT nick FROM users WHERE public_key = ?
  `);

  const upsertNick = db.prepare(`
    INSERT INTO users (public_key, nick, created_at) VALUES (?, ?, ?)
    ON CONFLICT(public_key) DO UPDATE SET nick = excluded.nick
  `);

  const checkNickExists = db.prepare(`
    SELECT public_key FROM users WHERE nick = ? AND public_key != ?
  `);

  return {
    addMessage(msg: Message) {
      insertMsg.run(msg.id, msg.channel, msg.from, msg.fromNick, msg.content, msg.type, msg.timestamp);

      // Auto-prune
      const row = countMsgs.get(msg.channel) as { cnt: number } | null;
      if (row && row.cnt > MAX_MESSAGES_PER_CHANNEL) {
        pruneOld.run(msg.channel, msg.channel, MAX_MESSAGES_PER_CHANNEL);
      }
    },

    getHistory(channel: string, limit = DEFAULT_HISTORY_LIMIT): Message[] {
      const rows = selectHistory.all(channel, limit) as Array<{
        id: string;
        channel: string;
        from_id: string;
        from_nick: string;
        content: string;
        type: string;
        timestamp: number;
      }>;

      // Reverse so oldest first
      return rows.reverse().map((r) => ({
        id: r.id,
        from: r.from_id,
        fromNick: r.from_nick,
        channel: r.channel,
        content: r.content,
        timestamp: r.timestamp,
        type: r.type as Message["type"],
      }));
    },

    getNick(userId: string): string | null {
      const row = selectNick.get(userId) as { nick: string } | null;
      return row?.nick ?? null;
    },

    setNick(userId: string, nick: string) {
      upsertNick.run(userId, nick, Date.now());
    },

    nickExists(nick: string, excludeUserId = ""): boolean {
      const row = checkNickExists.get(nick, excludeUserId);
      return row !== null;
    },

    close() {
      db.close();
    },
  };
}
