# Design

orx's terminal UI. It borrows rra's rules (dark, quiet, one accent, hierarchy from brightness rather than hue) and translates them to a character grid. Colors live in `src/tui/theme.ts`, the only file under `src/tui/` allowed to hold color literals (the Grit plugin flags hex strings anywhere else). This file says what each role is for. Read it before a visual change, and load the `tui-design-slop` skill before adding a panel, border, header, badge, spinner, or empty state.

## Theme

The terminal's own background shows through: orx never paints a full-screen fill, so it looks right in light and dark terminal themes as far as a fixed palette can. The palette assumes a dark background, the common case; text roles are chosen to stay readable on a light one.

## Color roles

| Role | Token | Use for |
| --- | --- | --- |
| Text | `theme.text` | Assistant replies |
| User | `theme.user` | The user's messages, prefixed `> ` |
| Muted | `theme.muted` | The model id in the header, placeholders, the empty-state line, a denied tool call |
| Faint | `theme.faint` | Usage lines, key hints, the chat id, an approval's scroll position: present but out of the way |
| Accent | `theme.accent` | The `orx` wordmark and the picker's border. One job per screen |
| Tool | `theme.tool` | Tool call lines (`→ read({...})`) and the approval panel's summary |
| Error | `theme.error` | The error line under a reply, and nothing else |
| Border | `theme.border` | The composer frame (`theme.faint` while a reply streams), and a list's highlighted row |
| Selected | `theme.selectedBg` | A list's background, so it reads as a layer over the chat |

## Layout

Top to bottom: a one-row header (`orx`, the model, `in ~/project` in `faint`, the short chat id right-aligned; on a narrow terminal the path is cut from the left, then dropped, before the model or the id give way), the message list (fills the rest, sticks to the bottom while a reply streams), the working row while a turn runs (see States), the composer (a bordered one-line input), and a one-row footer with key hints or a status message such as "Exported to orx-chat-0f0e0d0c.md". Every fixed row has `flexShrink={0}` so a long thread can't squeeze them.

Messages are separated by one blank row. A reply reads in the order it happened: the text the model wrote before a tool call, the call's line, the text after it, with a blank row wherever text gives way to tool lines or back (text from separate model steps is separate paragraphs). Then an error line if it failed, and its usage line (`model · 278 in / 30 out · $0.000057`). No boxes around messages, no avatars, no timestamps.

The model picker, the command list, and the `@` file list share one overlay (`src/tui/picker.tsx`): a search input and one row per item, sized to its content and anchored just above the composer, at most 10 rows (fewer on a short terminal). A longer list scrolls with the highlight and shows `3 of 48` in its bottom border. The command list puts each description beside its name; a label too long for the row is cut with `…` at the end, or at the start for a path so its file name stays. An empty result says "No matches". It's the only bordered panel besides the composer.

A tool call waiting for approval shows unbordered above the composer: the command (`Run  bun test`) or the change (`Edit src/x.ts`) in `tool`, then the rest of a multi-line command and the whole diff, its hunks without the file header (added lines `text`, the rest `muted`), wrapped rather than clipped, since the user is approving every line. When it doesn't fit, the summary stays and the rest scrolls, with a `faint` `lines 1–12 of 84` under it and `↑↓ scroll` in the footer. Under the diff, after a blank row, the choices sit on one row: `Allow`, `Always` (only when offered), `Deny`, the highlighted one `text` on `selectedBg` and the others `muted`. Allow is highlighted when the panel opens, so Enter allows. While it's open the composer is unfocused and says "Waiting for your answer above", any open list closes, and the footer shows `Enter pick · ←→ choose · y / a / n · Esc stop`; Enter and y / a / n do nothing until the panel has been on screen for 300 ms, so keys typed ahead for the composer can't approve it. After `n` the composer takes an optional note (`/` and `@` don't open lists there). Summaries, diffs, tool lines, and replies are drawn without control characters (`printable.ts`): the model wrote them.

A running agent tool call is one `tool` line naming what it touches (`→ edit src/x.ts · running`), never its raw input. A finished one is one `tool` line saying what it did (`→ read src/x.ts · 120 lines`, `→ edit src/x.ts · +2 −1`, `→ write src/y.ts · new file, 40 lines`, `→ bash bun test · exit 1`), paths relative to the workspace however the model spelled them, an edit's diff (hunks only: the `---`/`+++` header would repeat the line above it) (or a new file's content) under it cut at 20 lines with a `faint` count. A failure shows its message's first line in `error`; a call the user or the mode denied is `muted` (`→ edit src/x.ts · denied · The user said no.`), since it isn't an error. A finished reply that used tools ends, above its usage line, with a `muted` line that orx writes from the calls rather than the model: `Done · changed src/a.ts, src/b.ts · ran 1 command` (the first five files, then a count), `Done · ran 2 commands` when only commands ran (they may have changed files orx can't see), or `Done · no files changed`. It isn't shown after an error, after a note that stopped the reply early, or on a reply the user stopped.

Slash command output (`/help`, an unknown command or mode) is a few unbordered lines between the messages and the composer, `muted` (or `error`), until the next message or Esc. A permission mode other than `default` shows right-aligned in the footer, `muted`.

## Keys

| Key | Does |
| --- | --- |
| Enter | Send the message, or run a `/command`; in a list, pick the highlighted item (in the command list, run it; with nothing matching, report the unknown command); with an approval open, pick the highlighted choice |
| / | In an empty composer, open the command list (built-ins, custom commands, skills) |
| @ | At the start of a word, open the file list; picking inserts `@path`, and on send the file is attached for the model |
| Up / Down | Move the highlight in a list (typing a filter puts it back on the first match), or scroll an approval's diff |
| PgUp / PgDn | Scroll an approval's diff a page at a time |
| Tab | In a list, pick the highlighted item; in the command list, insert it into the composer to add arguments |
| Backspace | In a list's empty filter, close it and delete the `/` or `@` that opened it |
| ←/→ | With an approval open: move between Allow, Always (when offered), and Deny |
| y / a / n | With an approval open: allow, always allow (when offered), or deny with an optional note, without moving the highlight |
| Shift+Tab | Cycle the permission mode: default, acceptEdits, plan. yolo (`--dangerously-skip-permissions`) isn't in the cycle: Shift+Tab from yolo goes to default, and the keyboard can't go back, so a stray key can only take permissions away |
| Esc | The innermost thing first: close a list, leave a deny note (back to the choices), dismiss the /help or error lines, else stop the streaming reply (it's saved, marked interrupted; with an approval open, that denies it) |
| Ctrl+P | Open the model picker (not while a reply streams) |
| Ctrl+E | Export the chat as Markdown into the current directory |
| Ctrl+C | Quit, stopping a reply first so it's saved; exit code 0 |

The footer shows the keys that fit in 80 columns next to the mode (`@ files · / commands · Shift+Tab mode · Ctrl+P model · Ctrl+C quit`, 66 columns, leaving room for `acceptEdits`); `/help` lists every key from `KEYS` in `src/tui/commands.ts`. A new key goes in `KEYS`, this table, and `app.tsx`'s docblock in the same change, and in the footer only if it still fits. Don't bind keys terminals commonly swallow (Ctrl+S, Ctrl+Q, Ctrl+Z). Ctrl+E takes over the input's end-of-line shortcut; the input is one line, so End does the same job.

## States

- Empty chat: one muted line saying what to ask for and what the permission mode lets the agent do (`Ask for a change here. Edits apply as they're made; commands ask first.`); it follows a mode change. The footer lists the keys. No banner, no ASCII art.
- Streaming: a working row sits right above the composer whenever the turn is running and nothing shows progress: from the moment a message is sent until text arrives, after each tool result, and once streamed text has been quiet for a second (`WORKING_IDLE_MS`). While text streams it's blank but keeps its row, so the conversation doesn't jump when it comes back; it's gone while an approval waits on the user and when the turn ends. It's a braille spinner in `tool`, what the agent is doing in `muted` (`Thinking`, or the running tool's line, `bash bun test`), and the turn's elapsed time in `faint` (`12s`, `1m 05s`). It's the only animation, driven by OpenTUI's timeline (`src/tui/working.tsx`), and it exists because a model step or a command can be silent for a long time. The composer's placeholder says "Replying… Esc stops" and its border goes faint.
- Error: the partial reply stays, with the error line under it. A retryable error says "(send again to retry)"; a non-retryable one (a rejected key) says only what happened.
- Models list unavailable: the picker says so in the error color, and Esc closes it; chat keeps the current model.
- A custom command whose `model:` is unknown or can't call tools: the error line says which and where to change it, and nothing is sent.
- Custom commands or skills that didn't load cleanly (a bad file, a skill over its limits, a skill named like a command): when the session starts, one `muted` line per warning where `/help`'s lines go, until the next message or Esc.

## Do and don't

- Do let the terminal's background and font do the work. Don't draw full-width bars, gradients, or box-drawing frames around content.
- Do keep one accent job per screen. Don't color labels, counts, and borders in the accent at once.
- Do show numbers plainly (`12 in / 5 out`, `$0.000420`). Don't add spinners that move while nothing is happening; the streaming text is the progress indicator.
- Don't write to stdout or stderr while the TUI runs: logs go to the log file only (`TerminalLogging` is off).
