# Follow-ups

Status: TRACKING | Size: n/a | Depends on: n/a

Work that is deliberately not scheduled in any phase, so nobody mistakes it for forgotten work. Each entry says why it's out and what would bring it in. When a trigger fires, move the item into a phase file (or a new one) and delete it here. `AGENTS.md`'s "Deferred" section lists the distribution and storage items too; keep the two in step.

## Distribution and platforms

**Windows.** The `bash` tool runs `/bin/bash`, `install.sh` is POSIX, and there's no Windows smoke job or `install.ps1`. Supporting it means a shell story for the agent (Git Bash, WSL, or PowerShell with a different tool description), not only a build target. Trigger: a user who can't use WSL asks, or Codex-style native Windows sandboxing becomes something orx wants to match.

**musl Linux.** OpenTUI needs `OPENTUI_LIBC=musl` at runtime, which means a separate build target and a smoke test on Alpine. Trigger: someone wants orx in an Alpine container, most likely for headless `ask --agent` in CI.

**npm distribution.** The single binary and `install.sh` cover macOS and glibc Linux, and an npm package would need per-platform optional dependencies to carry the native library. Trigger: people asking for `npx orx` or a version pin in `package.json`.

**Code signing and notarization for macOS.** Gatekeeper doesn't quarantine a binary fetched with `curl`, so `install.sh` and `orx update` work unsigned. Trigger: distribution through a browser download or Homebrew cask, or a corporate MDM that blocks unsigned binaries.

## Accounts and cost

**Auth beyond the API key.** OpenRouter has an OAuth PKCE flow that issues a key to an app, which would let `orx` sign a user in without them creating a key. Everyone using orx today already has a key, and a stored credential adds a storage and revocation story. Trigger: orx is handed to people who don't have OpenRouter accounts yet.

**A session spend cap.** `ORX_MAX_SESSION_COST` stopping a session (or a subagent) at a dollar amount, from the per-reply `usage.cost` orx already sums. The README tells users to set a credit limit on the key, which OpenRouter enforces server-side and which covers every tool, not only orx. Trigger: the first report of a runaway bill from parallel subagents, or headless `ask --agent` in CI where a per-run cap matters more than a per-key one.

## Chat storage

**Concurrent writers to one chat.** Two processes saving the same chat: the last write wins. Nobody runs two sessions on one chat on purpose. Trigger: phase 3 background jobs or subagent transcripts making concurrent saves happen inside one process, or a user losing messages this way.

**Chat search and deletion from the CLI.** `orx chats` lists; files live in `$ORX_DATA_DIR/chats/` and `rm` works. Trigger: users with hundreds of chats, or `--resume` needing a way to find one other than the id.

## Agent behavior

**A persistent shell.** Moved from phase 3. Each `bash` call is a fresh `/bin/bash -c` in the workspace root, the prompt and tool description say so, and phase 3's background commands cover the job people usually mean (a dev server that keeps running). A real persistent shell means parsing a sentinel out of a long-lived process's output and restoring state after a timeout, which is where other agents' shell bugs come from. Trigger: eval transcripts showing models repeatedly failing because a `cd` or `export` didn't carry over.

**Per-model edit formats (`apply_patch` for codex models).** Moved from phase 3. `edit` already tolerates pasted line numbers, CRLF, and indentation drift, and no eval has measured an edit failure rate for any model. OpenRouter's `openrouter:apply_patch` is a Responses-API server tool the provider can't send, and opencode's substring-based switching draws complaints. Trigger: phase 1 and 2 evals show one model family failing `edit` in more than about one run in five, where that family was trained on `apply_patch`.

**Nested, background, and resumable subagents; worktree isolation.** Phase 2 subagents are depth one, foreground, and finish when they return. Claude Code allows three levels, background agents that report later, `SendMessage` to resume one, and `isolation: worktree`. Each adds state and UI orx has no use for yet. Trigger: a concrete workflow (parallel implementers in separate worktrees, say) that phase 2's `general` agent can't do.

**OpenRouter server-side agents (`openrouter:subagent`, `openrouter:advisor`).** OpenRouter can delegate to a cheaper worker or consult a stronger advisor inside one request. `@effect/ai-openrouter` rejects provider-defined tools at `4.0.0-rc.117`, and a server-side worker can't call orx's local tools. Trigger: the provider supports server tools, and there's a use that needs no local tools (the advisor for a planning step is the likely one).

**An automatic approval classifier.** Claude Code's `auto` mode lets a model approve tool calls. Phase 3's sandbox and rules get most of the benefit with rules a person can read. Trigger: users on the sandbox still reporting approval fatigue.

**LSP diagnostics.** Feeding type errors back after an edit, as Claude Code's IDE integrations and some agents do. A `PostToolUse` hook running `tsc` or a linter (phase 3) covers it per project without orx speaking LSP. Trigger: hooks prove too slow or too project-specific.

**Image input.** Pasting a screenshot for the model. Many OpenRouter models accept images and Effect AI has file parts, but the TUI has no paste path for binary data and the terminal protocols for it vary. Trigger: a user workflow (UI bugs from screenshots) that comes up repeatedly.

**Serving the agent's tools over `orx mcp`.** Won't do as long as the approval gate lives in orx's TUI: an MCP client calling `edit` or `bash` would bypass it. Listed so nobody adds it by accident.

## TUI

**Animations.** `DESIGN.md` rules out motion that doesn't carry information, and streaming text is the progress indicator. Trigger: a state where the user can't tell whether orx is working, which a progress line can't fix.

## Found while writing the phase plans

These are small, known, and not phase work; each is one PR.

- `HEADLESS_DENIAL` in `src/services/permissions.ts` tells the user to "run orx chat", which no longer exists.
- `DESIGN.md` says the footer always lists every key; since phase 1 it shows a fixed subset and `/help` lists the rest.
- `scripts/vanilla.ts` doesn't remove `plans/`, so the vanilla tree inherits orx's product plans.
- The coding eval has never run against a real model ([phase 1](phase-1-edits-code.md), "Still open").
