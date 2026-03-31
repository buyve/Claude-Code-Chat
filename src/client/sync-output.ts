// DEC 2026 synchronized output — prevents torn frames
// Adapted from Ink's terminal.ts isSynchronizedOutputSupported()

export const BSU = "\x1b[?2026h"; // Begin Synchronized Update
export const ESU = "\x1b[?2026l"; // End Synchronized Update

function isSyncOutputSupported(): boolean {
  // tmux doesn't implement DEC 2026 — BSU/ESU pass through but atomicity breaks
  if (process.env["TMUX"]) return false;

  const termProgram = process.env["TERM_PROGRAM"];
  const term = process.env["TERM"];

  // Known DEC 2026 terminals
  if (
    termProgram === "iTerm.app" ||
    termProgram === "WezTerm" ||
    termProgram === "WarpTerminal" ||
    termProgram === "ghostty" ||
    termProgram === "contour" ||
    termProgram === "vscode" ||
    termProgram === "alacritty"
  ) return true;

  // kitty
  if (term?.includes("kitty") || process.env["KITTY_WINDOW_ID"]) return true;

  // Ghostty / foot / Alacritty via TERM
  if (term === "xterm-ghostty") return true;
  if (term?.startsWith("foot")) return true;
  if (term?.includes("alacritty")) return true;

  // Zed / Windows Terminal
  if (process.env["ZED_TERM"]) return true;
  if (process.env["WT_SESSION"]) return true;

  // VTE-based (GNOME Terminal, Tilix) since VTE 0.68
  const vteVersion = process.env["VTE_VERSION"];
  if (vteVersion) {
    const version = parseInt(vteVersion, 10);
    if (version >= 6800) return true;
  }

  return false;
}

// Computed once at module load
export const SYNC_SUPPORTED = isSyncOutputSupported();
