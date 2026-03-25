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
  // TODO: start server (Phase 2)
  console.log("Server mode not yet implemented.");
  process.exit(0);
}

// Start client
import { startApp } from "../src/client/app.ts";
startApp();
