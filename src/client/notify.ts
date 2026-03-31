// Desktop notification on @mention — OSC 777 + native fallback

/**
 * Send a desktop notification.
 * Uses OSC 777 (supported by iTerm2, kitty, foot) with native fallback.
 */
export function sendNotification(title: string, body: string): void {
  // OSC 777 — terminal-native notification
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);

  // BEL — audible/visual bell as fallback
  process.stdout.write("\x07");

  // Native notification (macOS osascript, Linux notify-send)
  if (process.platform === "darwin") {
    try {
      Bun.spawn(["osascript", "-e",
        `display notification "${body}" with title "${title}"`]);
    } catch { /* no osascript */ }
  } else if (process.platform === "linux") {
    try {
      Bun.spawn(["notify-send", title, body]);
    } catch { /* no notify-send */ }
  }
}
