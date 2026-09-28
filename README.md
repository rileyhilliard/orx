# orx

orx is a coding agent for your terminal, like Claude Code, that runs on any OpenRouter model that can call tools. Start it in a project and ask for a change: the model searches and reads the code, proposes edits, and shows you each diff before it touches a file. Every reply ends with what it cost.

This page gets you from an API key to watching orx do a small refactor, in about five minutes.

## What you need

- [Bun](https://bun.sh) 1.4.2 or newer (`curl -fsSL https://bun.sh/install | bash`) and git.
- An OpenRouter API key from [openrouter.ai/keys](https://openrouter.ai/keys). Give it a credit limit while you're there; the demo below costs well under a cent.

## 1. Get the code

```bash
git clone https://github.com/rileyhilliard/orx.git
cd orx
bun install
```

## 2. Connect your key

```bash
cp .env.example .env
```

Open `.env` and paste your key after `OPENROUTER_API_KEY=`. That's the only line you need to change. `OPENROUTER_MODEL` picks the default model, and `openai/gpt-6-luna` is a cheap one that handles the demo fine.

Check that orx can see the key and reach OpenRouter:

```bash
bun run orx -- doctor          # look for "apiKey  set"
bun run orx -- ask "say hi"    # streams a reply, then the model, tokens, and cost
```

If `ask` says `OPENROUTER_API_KEY isn't set`, orx didn't find `.env`: run it from the `orx` directory. If it says OpenRouter rejected the key, check the key you pasted.

## 3. Make a project to work on

You could point orx at one of your own repos, but a throwaway project makes the first run easier to judge. This creates one in a temp directory and prints its path:

```bash
bun run demo
```

It's a tiny TypeScript shop: a `fmtPrice` function in `src/money.ts`, called from two other files and mentioned in the project's README. It's committed to git, so you can see exactly what the agent changes.

## 4. Ask for a change

Start orx in the demo project, using the path `bun run demo` printed:

```bash
bun run orx -- --cwd /path/from/bun-run-demo
```

Type this and press Enter:

```
rename fmtPrice to formatPrice everywhere
```

The model's tool calls go by one line each as it searches for the name and reads the files. When it wants to edit a file, orx stops and shows you the diff:

- `y` applies this edit.
- `a` applies this edit and every later one in the session without asking.
- `n` refuses, and you can type a note telling the model why.

When it's done, the reply's last line shows the model, the tokens in and out, and the cost. Press Ctrl+C to quit, then look at what changed:

```bash
git -C /path/from/bun-run-demo diff
```

`fmtPrice` should be renamed in all four files and nothing else touched.

## Things to try next

In the same session, or a fresh copy from `bun run demo`:

- `write a script that prints a receipt for two teas at $2.50 each, then run it`. You'll approve the new file, then the command; shell commands always ask.
- Shift+Tab cycles modes. `acceptEdits` stops asking about edits, and `plan` lets the model read but not change anything.
- `@` picks a file to attach to your message, as in `explain @src/cart.ts`.
- `/model` switches models mid-chat, and `/help` lists every command and key.

You can also run a task without the interactive session. Nobody's there to approve anything, so `--permission-mode acceptEdits` lets it edit files, and shell commands are refused:

```bash
bun run orx -- ask --agent --cwd /path/from/bun-run-demo --permission-mode acceptEdits "rename fmtPrice to formatPrice everywhere"
```

Drop `--agent` for a plain question with no tools:

```bash
git diff | bun run orx -- ask "review this diff"
```

## Use it on your own code

Point `--cwd` at any project. orx can only read and edit files inside that directory, but a shell command you approve runs as you, so read it before you press `y`.

Once there's a release, you can install the binary and drop the `bun run orx --` prefix:

```bash
curl -fsSL https://github.com/rileyhilliard/orx/releases/latest/download/install.sh | bash
export OPENROUTER_API_KEY=sk-or-...
cd ~/code/your-project && orx
```

## What's built and what's planned

Everything on this page is phase 1, and it's built. Phases 2 and 3 are plans, and none of their features exist in orx yet:

- [Phase 1: it edits code](docs/rfcs/RFC001-bootstrap-agent-harness/phase-1-edits-code.md) (built): the workspace tools, the approval gate and modes, slash commands, skills, and `@` files.
- [Phase 2: it delegates](docs/rfcs/RFC001-bootstrap-agent-harness/phase-2-delegates.md) (planned): subagents on cheaper models, agent files, compatibility with `.claude/` directories, todos, compaction, and permission rules.
- [Phase 3: it runs unattended](docs/rfcs/RFC001-bootstrap-agent-harness/phase-3-runs-unattended.md) (planned): workspace trust, `/rewind`, background commands, web fetch, an MCP client, hooks, and a sandbox for shell commands.

The [roadmap](docs/rfcs/RFC001-bootstrap-agent-harness/README.md) has the phase map, and [follow-ups](docs/rfcs/RFC001-bootstrap-agent-harness/follow-ups.md) lists what's left out on purpose.

## More

- [The coding agent](docs/agent.md): tools, permission modes, protected files, custom slash commands, and skills.
- [Reference](docs/reference.md): every setting, `--json` output, exit codes, and logs.
- [Development](docs/development.md): running without a key, tests, the eval, a tour of the code, and releasing.

## License

Copyright (c) 2026 Riley Hilliard
