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
| Tool | `theme.tool` | Tool call lines (`→ currentTime({...})`) and the approval panel's summary |
| Error | `theme.error` | The error line under a reply, and nothing else |
| Border | `theme.border` | The composer frame (`theme.faint` while a reply streams), and a list's highlighted row |
| Selected | `theme.selectedBg` | A list's background, so it reads as a layer over the chat |

## Layout

Top to bottom: a one-row header (`orx`, the model, the short chat id right-aligned), the message list (fills the rest, sticks to the bottom while a reply streams), the composer (a bordered one-line input), and a one-row footer with key hints or a status message such as "Exported to orx-chat-0f0e0d0c.md". Every fixed row has `flexShrink={0}` so a long thread can't squeeze them.

Messages are separated by one blank row. A reply is its tool lines, then its text, then an error line if it failed, then its usage line (`model · 278 in / 30 out · $0.000057`). No boxes around messages, no avatars, no timestamps.

The model picker, the command list, and the `@` file list share one overlay (`src/tui/picker.tsx`): a search input and one row per item, sized to its content and anchored just above the composer, at most 10 rows (fewer on a short terminal). A longer list scrolls with the highlight and shows `3 of 48` in its bottom border. The command list puts each description beside its name; a label too long for the row is cut with `…` at the end, or at the start for a path so its file name stays. An empty result says "No matches". It's the only bordered panel besides the composer.

A tool call waiting for approval shows unbordered above the composer: the command (`Run  bun test`) or the change (`Edit src/x.ts`) in `tool`, then the rest of a multi-line command and the whole diff (added lines `text`, the rest `muted`), wrapped rather than clipped, since the user is approving every line. When it doesn't fit, the summary stays and the rest scrolls, with a `faint` `lines 1–12 of 84` under it and `↑↓ scroll` in the footer. While it's open the composer is unfocused, any open list closes, and the footer shows `y allow · a always · n deny · Esc stop`; y / a / n do nothing until the panel has been on screen for 300 ms, so keys typed ahead for the composer can't approve it. After `n` the composer takes an optional note (`/` and `@` don't open lists there). Summaries, diffs, tool lines, and replies are drawn without control characters (`printable.ts`): the model wrote them.

A finished agent tool call is one `tool` line saying what it did (`→ read src/x.ts · 120 lines`, `→ bash bun test · exit 1`), an edit's diff (or a new file's content) under it cut at 20 lines with a `faint` count. A failure shows its message's first line in `error`; a call the user or the mode denied is `muted` (`→ edit src/x.ts · denied · The user said no.`), since it isn't an error.

Slash command output (`/help`, an unknown command or mode) is a few unbordered lines between the messages and the composer, `muted` (or `error`), until the next message or Esc. A permission mode other than `default` shows right-aligned in the footer, `muted`.

## Keys

| Key | Does |
| --- | --- |
| Enter | Send the message, or run a `/command`; in a list, pick the highlighted item (in the command list, run it; with nothing matching, report the unknown command) |
| / | In an empty composer, open the command list (built-ins, custom commands, skills) |
| @ | At the start of a word, open the file list; picking inserts `@path`, and on send the file is attached for the model |
| Up / Down | Move the highlight in a list (typing a filter puts it back on the first match), or scroll an approval's diff |
| PgUp / PgDn | Scroll an approval's diff a page at a time |
| Tab | In a list, pick the highlighted item; in the command list, insert it into the composer to add arguments |
| Backspace | In a list's empty filter, close it and delete the `/` or `@` that opened it |
| y / a / n | With an approval open: allow, always allow (when offered), deny with an optional note |
| Shift+Tab | Cycle the permission mode: default, acceptEdits, plan. yolo (`--dangerously-skip-permissions`) isn't in the cycle: Shift+Tab from yolo goes to default, and the keyboard can't go back, so a stray key can only take permissions away |
| Esc | The innermost thing first: close a list, leave a deny note (back to y / a / n), dismiss the /help or error lines, else stop the streaming reply (it's saved, marked interrupted; with an approval open, that denies it) |
| Ctrl+P | Open the model picker (not while a reply streams) |
| Ctrl+E | Export the chat as Markdown into the current directory |
| Ctrl+C | Quit, stopping a reply first so it's saved; exit code 0 |

The footer shows the keys that fit in 80 columns next to the mode (`@ files · / commands · Shift+Tab mode · Ctrl+P model · Ctrl+C quit`, 66 columns, leaving room for `acceptEdits`); `/help` lists every key from `KEYS` in `src/tui/commands.ts`. A new key goes in `KEYS`, this table, and `app.tsx`'s docblock in the same change, and in the footer only if it still fits. Don't bind keys terminals commonly swallow (Ctrl+S, Ctrl+Q, Ctrl+Z). Ctrl+E takes over the input's end-of-line shortcut; the input is one line, so End does the same job.

## States

- Empty chat: one muted line saying how to send and pick a model (the footer lists the rest). No banner, no ASCII art.
- Streaming: the reply shows `…` until the first text arrives; the composer's placeholder says "Replying… Esc stops" and its border goes faint.
- Error: the partial reply stays, with the error line under it. A retryable error says "(send again to retry)"; a non-retryable one (a rejected key) says only what happened.
- Models list unavailable: the picker says so in the error color, and Esc closes it; chat keeps the current model.
- A custom command whose `model:` is unknown or can't call tools: the error line says which and where to change it, and nothing is sent.
- Custom commands or skills that didn't load cleanly (a bad file, a skill over its limits, a skill named like a command): when the session starts, one `muted` line per warning where `/help`'s lines go, until the next message or Esc.

## Do and don't

- Do let the terminal's background and font do the work. Don't draw full-width bars, gradients, or box-drawing frames around content.
- Do keep one accent job per screen. Don't color labels, counts, and borders in the accent at once.
- Do show numbers plainly (`12 in / 5 out`, `$0.000420`). Don't add spinners that move while nothing is happening; the streaming text is the progress indicator.
- Don't write to stdout or stderr while the TUI runs: logs go to the log file only (`TerminalLogging` is off).
