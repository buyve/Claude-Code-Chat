// CC session detection — polls ~/.claude/sessions/ for active sessions

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import type { PresenceStatus, RichPresence } from "../shared/types.ts";

const POLL_INTERVAL = 5000; // 5s
const SESSIONS_DIR = join(
  process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp",
  ".claude",
  "sessions",
);

// Language inference markers
const LANG_MARKERS: Array<[string, string]> = [
  ["package.json", "TypeScript"],
  ["tsconfig.json", "TypeScript"],
  ["Cargo.toml", "Rust"],
  ["go.mod", "Go"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["Gemfile", "Ruby"],
  ["build.gradle", "Java"],
  ["pom.xml", "Java"],
];

interface SessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind?: string;
}

export interface DetectedSession {
  sessionId: string;
  pid: number;
  project: string;
  language?: string;
  cwd: string;
  startedAt: number;
}

export type PresenceChangeHandler = (
  status: PresenceStatus,
  rich?: RichPresence,
  sessions?: DetectedSession[],
) => void;

export interface PresenceWatcher {
  start(): void;
  stop(): void;
  getSessions(): DetectedSession[];
  onChange(handler: PresenceChangeHandler): void;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function inferLanguage(cwd: string): string | undefined {
  for (const [file, lang] of LANG_MARKERS) {
    if (existsSync(join(cwd, file))) return lang;
  }
  return undefined;
}

function readSessions(): DetectedSession[] {
  if (!existsSync(SESSIONS_DIR)) return [];

  const sessions: DetectedSession[] = [];

  try {
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      try {
        const raw = readFileSync(join(SESSIONS_DIR, file), "utf-8");
        const data = JSON.parse(raw) as SessionFile;

        if (!data.pid || !isPidAlive(data.pid)) continue;

        const project = basename(data.cwd || "unknown");
        const language = inferLanguage(data.cwd || "");

        sessions.push({
          sessionId: data.sessionId || file.replace(".json", ""),
          pid: data.pid,
          project,
          language,
          cwd: data.cwd || "",
          startedAt: data.startedAt || Date.now(),
        });
      } catch {
        // Skip malformed session files
      }
    }
  } catch {
    // Sessions dir read error
  }

  return sessions;
}

export function createPresenceWatcher(): PresenceWatcher {
  let timer: ReturnType<typeof setInterval> | null = null;
  let currentSessions: DetectedSession[] = [];
  let handlers: PresenceChangeHandler[] = [];
  let lastStatus: PresenceStatus = "online";

  function poll() {
    const sessions = readSessions();
    const newStatus: PresenceStatus = sessions.length > 0 ? "coding" : "online";

    // Check if anything changed
    const changed =
      newStatus !== lastStatus ||
      sessions.length !== currentSessions.length ||
      sessions.some(
        (s, i) => currentSessions[i]?.sessionId !== s.sessionId,
      );

    if (changed) {
      currentSessions = sessions;
      lastStatus = newStatus;

      const rich: RichPresence | undefined =
        sessions.length > 0
          ? {
              project: sessions[0]!.project,
              language: sessions[0]!.language,
              duration: Math.floor(
                (Date.now() - sessions[0]!.startedAt) / 60000,
              ),
            }
          : undefined;

      for (const handler of handlers) {
        handler(newStatus, rich, sessions);
      }
    }
  }

  return {
    start() {
      // Initial poll
      poll();
      timer = setInterval(poll, POLL_INTERVAL);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      handlers = [];
    },

    getSessions() {
      return currentSessions;
    },

    onChange(handler: PresenceChangeHandler) {
      handlers.push(handler);
    },
  };
}
