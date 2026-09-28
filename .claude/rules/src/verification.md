---
paths:
  - "src/**"
  - "tests/**"
  - "e2e/**"
  - "scripts/**"
---

# Before calling work done

Run `bun run check` (lint, typecheck, the unit and TUI tests, then e2e, which builds the binary) and read the output. e2e is the only check of the compiled binary, and the only one that runs the TUI in a real PTY. CI also runs `bun run coverage` and, after `bun install --os='*' --cpu='*'`, `bun run build:all`; `check` runs neither.

- A clean exit code isn't a pass. Read the counts: a `-t` filter that matches nothing can exit 0 with every test skipped.
- Run the real CLI, not only the tests. With no key and no spend: `bun run stub`, export the env it prints, then `bun run orx -- ask "hi"`, `bun run orx -- ask "what time is it in Paris" --json`, `bun run orx -- models gpt`. Each run appends to `logs/orx.jsonl` (one `command` line, and an `llm call` line per turn) and tees stderr to `logs/orx.log`. `bun run stub:stop` when done, if you started it.
- Check the contract by hand when a command changed: stdout holds only the result (`bun run orx -- ask hi --json | jq`), a bad flag leaves stdout empty and exits 2 (`echo $?`), no key exits 3.
- TUI changes: `bun run tui:capture -- --keys "hi<enter>"` prints the rendered screen as text, including the streamed reply and the usage line. Check the states the change touches (`tui.md`).
- Distribution changes: `bun run build`, then `./dist/orx --version`, `./dist/orx doctor --tui`, and the affected command against the stubs. `bun run build:all` when the build script or native-lib plugin changed.
- For any failure, read `logs/orx.jsonl` (structured; `jq -c 'select(.level == "error" or .level == "warn")' logs/orx.jsonl`) and `logs/orx.log` (the whole stderr) before guessing.
- A green commit isn't a complete one: after a hook-running commit, check `git status` for files a hook rewrote and left unstaged.
- Don't report a cause you didn't observe. Quote the error output you're basing it on.
