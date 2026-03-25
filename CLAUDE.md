# CLAUDE.md

## Project
CCC (Claude Code Chat) — WeeChat-style terminal messenger for Claude Code users.
Package: `cc-chat`, binary: `ccc`.

## Plan
Read `PLAN.md` in full before writing any code. It is the single source of truth.
Follow it task by task, phase by phase. Do not skip ahead.

## Development Rules

### Execution
- Implement one task at a time (e.g. 1.1, then 1.2, then 1.3...)
- After each task, run the "Done when" check from PLAN.md
- If a task's "Done when" fails, fix before moving to the next task
- Commit after each task with message: `feat(P1): 1.1 — project scaffolding`

### Code Style
- TypeScript strict mode, no `any`
- Bun runtime — use `bun:sqlite`, `Bun.serve()`, `bun test`
- No classes unless state management requires it — prefer functions + closures
- Keep files under 200 lines. Split if approaching
- All string width calculations must use `string-width` (Korean/CJK/emoji)

### TUI Rendering
- Custom ANSI — `process.stdout.write()` + `ansi-escapes` + `chalk` + `string-width` + `cli-cursor`
- NO blessed, NO neo-blessed, NO ink
- Alternate screen buffer (`\x1b[?1049h` on enter, `\x1b[?1049l` on exit)
- Always restore terminal state on exit (including crash — use process handlers)
- Every `writeLine()` must truncate/pad to region width via `string-width`
- Test Korean text rendering after every widget: `한글 테스트 🎮`

### WeeChat Fidelity
- Reference the WeeChat source files listed in PLAN.md Context section for behavior
- Prefix system is non-negotiable: `-->`, `<--`, `=!=`, `--`, `*`
- Nick alignment: right-aligned nick column + `│` separator
- Time elision: blank timestamp if same minute as previous message
- Hotlist: 4-level priority with distinct colors
- Read marker: `────────────` line

### Testing
- `bun test` for unit tests
- Manual verification against PLAN.md's verification tables after each phase
- Test in at least 80x24 and 200x50 terminal sizes

### What NOT to Do
- Do not add features not in PLAN.md
- Do not use external TUI frameworks
- Do not store secrets in code
- Do not skip the "Done when" checks
- Do not combine multiple tasks in one commit
