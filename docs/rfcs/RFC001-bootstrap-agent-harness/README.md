# Plans

The roadmap for orx as a coding agent: what it's building, in what order, and what already shipped. One file per phase, plus a list of what's deliberately left out. A `/feature` RFC for one step of a phase goes in `docs/rfcs/` beside this folder and links the phase file it implements.

## What orx is building, and why

orx is a Claude Code-style coding agent that runs on any tool-capable OpenRouter model, shipped as one binary. The person it's for already works the way Claude Code taught (an agent in the terminal, approvals, `AGENTS.md`, slash commands, skills) and wants model choice without switching tools: a cheap model for routine work, a strong one for the hard parts, a zero-data-retention route for sensitive code, all on one key and one bill. The bet is that the agent loop is now well understood, and what a multi-vendor client can add is choosing the model per job and showing what each job cost.

## Phase map

| Phase | File | Status | In one line |
| --- | --- | --- | --- |
| 1 | [phase-1-edits-code.md](phase-1-edits-code.md) | Done (2026-09-28); the coding eval passes on 3 of 4 cheap models | Reads, edits, and runs commands in a workspace behind an approval gate, with slash commands, skills, and `@` files |
| 2 | [phase-2-delegates.md](phase-2-delegates.md) | Proposed | Subagents on cheaper models with their own cost, agent files, `.claude/` compatibility, todos, compaction, permission rules |
| 3 | [phase-3-runs-unattended.md](phase-3-runs-unattended.md) | Proposed | Workspace trust, `/rewind`, background commands, `web_fetch`, an MCP client, hooks, an OS sandbox for `bash` |
| n/a | [follow-ups.md](follow-ups.md) | Tracking | Out of scope on purpose, each with the trigger that would bring it in |

What phase 1 shipped:

- Bare `orx` is the agent session; `orx chat` is gone. `ask --agent` runs the same tools headless, with `--permission-mode` and `permission-denied` events in `--json`.
- A workspace root with path containment (`Workspace`), stale-edit checks (`FileState`), and six tools: `read`, `glob`, `grep`, `write`, `edit`, `bash`, plus `skill`.
- A `Permissions` service with four modes, an approval panel with yes, always, and no-with-a-note, protected and secret-shaped paths, and a refusal of models without tool calling.
- Tool history replayed across turns with call ids and reasoning details, context elision against each model's window, Anthropic cache breakpoints, an idle timeout in place of a whole-turn deadline, and step and repeat guards.
- `AGENTS.md`/`CLAUDE.md` memory, custom commands and skills from `.orx/` and `~/.config/orx/`, the shared picker, and `@path` attachments stored beside the message.
- A `rename-across-files` coding eval that runs through `ask --agent`.

Phase 2's proposal moves permission rules and `` !`cmd` `` expansion in from phase 3; phase 3 moves the persistent shell and per-model edit formats out to follow-ups. Each file explains its moves.

## How plan files are written

Each plan file starts with a status line, then the plan:

```
Status: PROPOSED 2026-09-28 | Size: XL (eight PR-sized steps) | Depends on: phase 1
```

Status is one of `PROPOSED`, `IN PROGRESS`, `EXECUTED <date>`, `PARTIALLY EXECUTED <date>` (with what was deferred and why), or `TRACKING` for the follow-ups list. A plan that shipped half its scope says so; that's more useful than a plan that looks finished.

A proposed phase covers the jobs it's for and who has them, what the other agents do (with sources), scope in and out with where each "out" went, the experience in the TUI and headless, how it fits the existing code, PR-sized steps with dependencies, testing, success criteria, risks, and open questions. An executed phase keeps its design as built, its review notes, what changed during execution, corrections to the design, and what's still open.

Cite symbols, not line numbers: `decide` in `src/services/permissions.ts`, not `permissions.ts:103`. Line numbers drift within days and have to be re-found by symbol anyway.

Plans are hypotheses, not specifications. Check each claim about the code before building on it; the phase 1 record has a "Corrections to the design" section for exactly this reason.

## How plan files are updated

- When a step starts, set the phase to `IN PROGRESS` and note the step. When it merges, add its commits to the phase file.
- When the design changes during execution, write what changed and why under "What changed during execution" in the same PR as the change. The record of what the plan got wrong is usually worth more than the record of what got built.
- When a phase is done, mark it `EXECUTED`, list what shipped, and move anything unfinished to "Still open" in that file or to [follow-ups.md](follow-ups.md).
- When a follow-up's trigger fires, move it into a phase and delete it from the follow-ups list.
- Keep this index's phase map and its "what phase 1 shipped" list current; it's the first thing a new session reads.

## Related

- [`AGENTS.md`](../../../AGENTS.md): the architecture map and conventions the plans build on.
- [`README.md`](../../../README.md): the coding agent as users see it, including permission modes and configuration.
- [`DESIGN.md`](../../../DESIGN.md): the TUI's color roles, layout, and keys, which every phase's TUI work follows.
- [`docs/harness.md`](../../harness.md) and [`docs/rfcs/`](../): how the repository's own guardrails work and why.
