# Design

orx's terminal UI. Today it's one placeholder screen (`orx ui`, `src/tui/app.tsx`): a prompt, the model's last reply, and a key hint. The rules here are meant to outlast it: dark, quiet, one accent, hierarchy from brightness rather than hue, on a character grid. Colors live in `src/tui/theme.ts`, the only file under `src/tui/` allowed to hold color literals (the Grit plugin flags hex strings anywhere else). This file says what each role is for. Read it before a visual change, and load the `tui-design-slop` skill before adding a panel, border, header, badge, spinner, or empty state. When you replace the placeholder, update the layout, keys, and states below in the same change.

## Theme

The terminal's own background shows through: orx never paints a full-screen fill, so it looks right in light and dark terminal themes as far as a fixed palette can. The palette assumes a dark background, the common case; text roles are chosen to stay readable on a light one.

## Color roles

| Role | Token | Use for |
| --- | --- | --- |
| Text | `theme.text` | The model's reply |
| User | `theme.user` | The prompt you sent, prefixed `> ` |
| Muted | `theme.muted` | The model id in the header, the empty-state line |
| Faint | `theme.faint` | The usage line, the key hints, the input's border while waiting: present but out of the way |
| Accent | `theme.accent` | The `orx` wordmark. One job per screen |
| Error | `theme.error` | The error line in place of a reply, and nothing else |
| Border | `theme.border` | The input frame |

## Layout

Top to bottom: a one-row header (`orx` and the model id), the body (fills the rest: the last prompt, then the reply and its usage line, or an error), the input (a bordered one-line field), and a one-row footer with the key hints. Every fixed row has `flexShrink={0}` so a long reply can't squeeze them.

The reply sits one blank row under the prompt, with its usage line (`model · 278 in / 30 out · $0.000057`) directly under the text. No boxes around content, no avatars, no timestamps. The input is the only bordered element.

## Keys

| Key | Does |
| --- | --- |
| Enter | Send the prompt (ignored while a reply is pending or the input is blank) |
| Ctrl+C | Quit; exit code 0 |

The footer always lists these. A new key goes in the footer, this table, and `app.tsx`'s docblock in the same change. Don't bind keys terminals commonly swallow (Ctrl+S, Ctrl+Q, Ctrl+Z).

## States

- Empty: one muted line, "Type a prompt and press Enter." No banner, no ASCII art.
- Waiting: the prompt shows, the input clears, its placeholder says "Waiting for the model…", and its border goes faint. No spinner: nothing moves while nothing is happening.
- Reply: the text, then the usage line in faint.
- Error: one line in the error color. A retryable error adds "Send again to retry."; a non-retryable one (a rejected key) says only what happened.

## Do and don't

- Do let the terminal's background and font do the work. Don't draw full-width bars, gradients, or box-drawing frames around content.
- Do keep one accent job per screen. Don't color labels, counts, and borders in the accent at once.
- Do show numbers plainly (`12 in / 5 out`, `$0.000420`). Don't add spinners that move while nothing is happening.
- Don't write to stdout or stderr while the TUI runs: logs go to the log file only (`TerminalLogging` is off).
