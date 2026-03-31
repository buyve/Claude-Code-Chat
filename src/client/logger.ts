// Chat logger — append messages to per-channel log files
// Logs to ~/.local/share/ccc/logs/<channel>.log

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Message } from "../shared/types.ts";

const LOG_DIR = join(homedir(), ".local", "share", "ccc", "logs");
let dirCreated = false;

function ensureDir(): void {
  if (dirCreated) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    dirCreated = true;
  } catch { /* already exists or can't create */ }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_#-]/g, "_");
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Append a message to the channel's log file. */
export function logMessage(msg: Message): void {
  ensureDir();
  const filename = sanitizeFilename(msg.channel) + ".log";
  const path = join(LOG_DIR, filename);

  let line: string;
  switch (msg.type) {
    case "chat":
      line = `[${formatTime(msg.timestamp)}] <${msg.fromNick}> ${msg.content}`;
      break;
    case "action":
      line = `[${formatTime(msg.timestamp)}] * ${msg.fromNick} ${msg.content}`;
      break;
    case "join":
      line = `[${formatTime(msg.timestamp)}] --> ${msg.fromNick} has joined`;
      break;
    case "part":
      line = `[${formatTime(msg.timestamp)}] <-- ${msg.fromNick} has left: ${msg.content}`;
      break;
    default:
      line = `[${formatTime(msg.timestamp)}] -- ${msg.content}`;
  }

  try {
    appendFileSync(path, line + "\n");
  } catch { /* write failed, ignore */ }
}
