# The coding agent

Bare `orx` (and `orx ask --agent`) gives the model a workspace: the directory orx started in, or `--cwd`. This page covers what the model can do there, what asks first, and the session's commands.

## Tools

The model gets `read`, `glob`, `grep`, `write`, `edit`, and `bash`, plus `skill`, and orx only offers models whose OpenRouter listing says they support tool calling. File tools resolve every path inside the workspace (symlinks included) and refuse anything outside it. `bash` runs in the workspace with the API key scrubbed from its environment, but it isn't sandboxed: an approved command can touch anything your user can. For that reason orx won't start in your home directory or `/` unless `--cwd` names it explicitly.

`grep` uses `rg` (ripgrep) when it's on your PATH and a JS search when it isn't.

## Permissions

What runs without asking depends on the permission mode:

| Mode | Reads | Writes and edits | bash |
|---|---|---|---|
| `default` | allowed | ask | ask |
| `acceptEdits` | allowed | allowed, except protected paths | ask |
| `plan` | allowed | denied | denied |
| `yolo` | allowed | allowed | allowed |

Shift+Tab or `/mode` switches between the first three. `--dangerously-skip-permissions` starts in `yolo`.

An approval shows the diff or the command: `y` allows it once, and `n` refuses with an optional note for the model. `a` (always) on an edit switches the session to `acceptEdits`; on a command it allows that exact command for the rest of the session.

Two kinds of path always ask, in every mode except `yolo`:

- Secret-shaped files: `.env*`, `*.pem`, `*.key`, and `id_*` ask before they're read or written. `@` won't attach them, and `grep` never searches them; it tells the model how many it skipped.
- Protected paths ask before a write even in `acceptEdits`, because a later approved command would run or load them: anything under `.git/`, `.orx/commands/`, or `.orx/skills/`, plus any `package.json`, `lefthook.yml`, `AGENTS.md`, or `CLAUDE.md`. The comparison ignores case (on macOS, `.GIT/config` is `.git/config`).

"Always" isn't offered for compound shell commands (`;`, `&&`, pipes, redirects, substitution) or for secret and protected paths.

## Headless: `orx ask --agent`

`orx ask --agent` has no one to ask, so anything that would ask is denied, and the model sees why. `--permission-mode` sets what may run; its default, `default`, denies every write, edit, and command. Tool calls go to stderr as they happen and the answer to stdout. With `--json`, a denied call emits `{"type":"permission-denied","id","tool","message"}` just before that call's `tool-result`.

Plain `orx ask`, without `--agent`, sends no tools: it's a question and an answer.

## In the session

- Memory: the system prompt includes `~/.config/orx/AGENTS.md`, then the `AGENTS.md` of each directory from the git root down to the workspace, capped at 32 KiB. `CLAUDE.md` is used where a directory has no `AGENTS.md`.
- Slash commands: `/` lists the built-ins (`/help`, `/clear`, `/model`, `/mode`, `/export`, `/quit`), your custom commands, and your skills.
  - A custom command is a Markdown file in `.orx/commands/` or `~/.config/orx/commands/`. `/name args` sends its body with `$ARGUMENTS` filled in. A `model:` line in its frontmatter runs that turn on a different model.
  - A skill is a directory in `.orx/skills/` or `~/.config/orx/skills/` containing a `SKILL.md` with `name` and `description` in its frontmatter. The description goes in the system prompt, and the model loads the body with the `skill` tool when it needs it.
  - When a name exists in both places, the workspace's version wins.
- `@` mentions: `@` opens a fuzzy file picker. Each `@path` in a message attaches that file (with line numbers, up to the first 2000 lines) or that directory's listing. The chat and its exports show only what you typed.
- Context: when a long chat nears the model's context window, old tool outputs and older attachments are replaced by one-line stubs.

Chats remember their workspace. Running `--resume` from a different directory exits 2 and names the chat's directory; pass `--cwd` explicitly to continue it somewhere else.
