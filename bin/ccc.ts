#!/usr/bin/env bun

// CCC (Claude Code Chat) — WeeChat-style terminal messenger
// Entry point: routes to client or server mode

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`ccc — WeeChat-style terminal messenger for Claude Code users

Usage:
  ccc              Start chat client (connects to server)
  ccc server       Start chat server
  ccc --help       Show this help
  ccc --version    Show version`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  const pkg = await import("../package.json");
  console.log(`ccc v${pkg.version}`);
  process.exit(0);
}

if (args[0] === "server") {
  const { startServer } = await import("../src/server/index.ts");
  const dbPath = process.env["CCC_DB_PATH"];
  const noPersist = args.includes("--no-persist");
  startServer(noPersist ? ":memory:" : dbPath);
  // Keep server running
  await new Promise(() => {});
}

// Start client — check for first-run onboarding
import { hasConfig, loadConfig, runOnboarding } from "../src/client/onboarding.ts";
import { startApp } from "../src/client/app.ts";

if (!hasConfig()) {
  await runOnboarding();
}

// Apply config to env so connection.ts and app.ts pick them up
const config = loadConfig();
if (!process.env["CCC_SERVER"]) process.env["CCC_SERVER"] = config.server;
if (!process.env["CCC_NICK"]) process.env["CCC_NICK"] = config.nick;

startApp();
