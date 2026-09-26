import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bash, denyReason, hookCommand, REPO, runHook, wiredCommands } from "../helpers/hooks";

const settings = JSON.parse(readFileSync(`${REPO}/.claude/settings.json`, "utf8")) as {
  permissions: { allow: string[]; deny: string[] };
};

describe("hook wiring in .claude/settings.json", () => {
  it("points every hook command at a file that exists", () => {
    for (const command of wiredCommands()) {
      const path = /"\$\{CLAUDE_PROJECT_DIR\}(\/[^"]+)"/.exec(command)?.[1];
      expect(path, command).toBeDefined();
      expect(existsSync(`${REPO}${path}`), command).toBe(true);
    }
  });

  it.each([
    ["SessionStart", "session-start", undefined],
    ["PreToolUse", "block-destructive", "Bash"],
    ["PreToolUse", "guard-commands", "Bash"],
    ["PreToolUse", "detect-secrets", "Write"],
    ["PreToolUse", "detect-secrets", "Edit"],
    ["PreToolUse", "guard-generated", "Write"],
    ["PreToolUse", "guard-generated", "Edit"],
    ["PreToolUse", "guard-boundaries", "Write"],
    ["PreToolUse", "guard-boundaries", "Edit"],
    ["PostToolUse", "lint-on-write", "Write"],
    ["PostToolUse", "typecheck-on-write", "Edit"],
    ["Stop", "format-changed", undefined],
  ])("runs %s %s for %s", (event, script, tool) => {
    expect(() => hookCommand(event, script, tool)).not.toThrow();
  });

  it("wires no guard for tools it doesn't cover", () => {
    expect(() => hookCommand("PreToolUse", "block-destructive", "Write")).toThrow();
    expect(() => hookCommand("PreToolUse", "guard-commands", "Edit")).toThrow();
    expect(() => hookCommand("PreToolUse", "detect-secrets", "Bash")).toThrow();
    expect(() => hookCommand("PreToolUse", "guard-boundaries", "Bash")).toThrow();
  });

  it("wires every hook script in .claude/hooks", () => {
    const scripts = readdirSync(`${REPO}/.claude/hooks`).filter(
      (name) => name.endsWith(".ts") && !name.startsWith("_"),
    );
    const wired = wiredCommands().join("\n");
    for (const script of scripts) expect(wired, script).toContain(`/.claude/hooks/${script}"`);
  });

  it("keeps the worst destructive commands in permissions.deny", () => {
    for (const rule of [
      "Bash(rm -rf /)",
      "Bash(rm -rf ~)",
      "Bash(git push --force)",
      "Bash(git reset --hard)",
      "Read(./.env)",
    ]) {
      expect(settings.permissions.deny).toContain(rule);
    }
  });

  it("allows no command guard-commands denies", { timeout: 30_000 }, async () => {
    // An allow rule skips the prompt, not the hooks; one that names a denied command means the
    // two drifted apart. `*` stands for any argument.
    const commands = settings.permissions.allow
      .filter((rule) => rule.startsWith("Bash("))
      .map((rule) => rule.slice(5, -1).replaceAll("*", "x"));
    for (const command of commands) {
      const result = await runHook("PreToolUse", "guard-commands", bash(command));
      expect(denyReason(result), command).toBeUndefined();
    }
  });
});
