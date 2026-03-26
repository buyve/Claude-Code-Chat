// First-run onboarding flow — interactive config setup

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { loadOrGenerateKey, fingerprint } from "../shared/crypto.ts";

const CONFIG_DIR = join(
  process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp",
  ".config",
  "ccc",
);
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface CccConfig {
  nick: string;
  server: string;
  keyPath: string;
  publicKey: string;
}

const DEFAULT_SERVER = "ws://localhost:3337";

/** Check if config exists (not first run). */
export function hasConfig(): boolean {
  return existsSync(CONFIG_PATH);
}

/** Load existing config. */
export function loadConfig(): CccConfig {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as CccConfig;
}

/** Save config to disk. */
function saveConfig(config: CccConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

/** Run interactive onboarding. Returns config when done. */
export async function runOnboarding(): Promise<CccConfig> {
  const write = (s: string) => process.stdout.write(s);
  const writeln = (s: string) => process.stdout.write(s + "\n");

  writeln("");
  writeln("  ╔═══════════════════════════════════════╗");
  writeln("  ║   Welcome to CCC (Claude Code Chat)   ║");
  writeln("  ║   Terminal messenger for developers    ║");
  writeln("  ╚═══════════════════════════════════════╝");
  writeln("");

  // Step 1: SSH key
  writeln("  [1/3] SSH Key Setup");
  const key = loadOrGenerateKey();
  const fp = fingerprint(key.publicKey);
  writeln(`    ✓ Key: ${key.privatePath}`);
  writeln(`    ✓ Fingerprint: ${fp}`);
  writeln("");

  // Step 2: Nickname
  writeln("  [2/3] Choose a nickname");
  const defaultNick = process.env["CCC_NICK"] ?? `user_${fp.slice(0, 8)}`;
  write(`    Nick [${defaultNick}]: `);

  const nick = await readLine() || defaultNick;
  writeln("");

  // Step 3: Server
  writeln("  [3/3] Server");
  const envServer = process.env["CCC_SERVER"];
  const defaultServer = envServer ?? DEFAULT_SERVER;
  write(`    Server [${defaultServer}]: `);

  const server = await readLine() || defaultServer;
  writeln("");

  const config: CccConfig = {
    nick,
    server,
    keyPath: key.privatePath,
    publicKey: key.publicKey,
  };

  saveConfig(config);
  writeln(`  ✓ Config saved to ${CONFIG_PATH}`);
  writeln("  Starting CCC...");
  writeln("");

  return config;
}

/** Read a line from stdin (non-raw mode). Handles Ctrl+C gracefully. */
function readLine(): Promise<string> {
  return new Promise((resolve) => {
    // Temporarily exit raw mode for line reading
    const wasRaw = process.stdin.isRaw;
    if (wasRaw) process.stdin.setRawMode(false);

    process.stdin.resume();

    const sigintHandler = () => {
      process.stdout.write("\n  Aborted.\n");
      process.exit(0);
    };
    process.on("SIGINT", sigintHandler);

    process.stdin.once("data", (data: Buffer) => {
      process.removeListener("SIGINT", sigintHandler);
      const line = data.toString("utf-8").trim();
      if (wasRaw) process.stdin.setRawMode(true);
      resolve(line);
    });
  });
}
