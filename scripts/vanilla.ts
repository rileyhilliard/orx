#!/usr/bin/env bun
// `bun run vanilla -- [--name <name>] [--branch <branch>] [--no-check]`: turns this checkout into
// a blank-slate CLI on a new branch. The infrastructure stays (build, install.sh, update, doctor,
// logging, config, the TUI shell, tests and stubs, hooks, CI, rr); the orx product goes (chat,
// models, extract, chats, export, mcp, the tool loop, evals, recorded fixtures). What's left is
// `ask` (one example model call) and `ui` (a placeholder screen), so the next CLI starts from
// code that builds and passes `bun run check`.
//
// It deletes REMOVE, copies template/vanilla/ over the tree (the files that referenced what was
// removed, rewritten), drops this machinery (this script, template/, the vanilla workflow), and
// with --name renames orx everywhere. Then `bun install`, `bun run format`, `bun run check`, and
// one commit. Needs a clean tree; the current branch is left as it was.
//
//   --name <name>      rename orx to <name> (lowercase, digits, dashes): ORX_* vars, paths, docs
//   --branch <branch>  the branch to create (default: vanilla)
//   --no-check         skip `bun run check` (it takes about a minute)
//   --verify           do all of it in a temporary worktree of HEAD (commit first: uncommitted
//                      changes aren't in it) and throw it away. CI runs this
//
// Ignored files are left alone: it refuses to delete a REMOVE path that holds any (evals/results),
// and files ignored before a --name run (.orx/ dev data) stay out of the commit.
//
// template/vanilla/ has to change with the code it replaces: CI's `vanilla` workflow runs
// `--verify`, which fails when a change on main breaks the vanilla result.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dirname, "..");

/** Product files and directories, deleted before the template is copied in. */
const REMOVE = [
  ".claude/commands/add-tool.md",
  ".claude/rules/src/agent-tools.md",
  "docs/rfcs",
  "evals",
  "plans",
  "scripts/lib/recording.ts",
  "scripts/lib/script-layer.ts",
  "scripts/record-openrouter.ts",
  "src/commands/chats.ts",
  "src/commands/export.ts",
  "src/commands/extract.ts",
  "src/commands/mcp.ts",
  "src/commands/models.ts",
  "src/commands/session.ts",
  "src/core/chat.ts",
  "src/core/commands.ts",
  "src/core/context.ts",
  "src/core/export.ts",
  "src/core/extract.ts",
  "src/core/files.ts",
  "src/core/mcp-stdio.ts",
  "src/core/mentions.ts",
  "src/core/models.ts",
  "src/core/prompt.ts",
  "src/core/session.ts",
  "src/core/skills.ts",
  "src/schemas/chat.ts",
  "src/schemas/events.ts",
  "src/schemas/extract.ts",
  "src/schemas/models.ts",
  "src/schemas/slash.ts",
  "src/schemas/tools.ts",
  "src/services/ChatStore.ts",
  "src/services/OpenRouterModels.ts",
  "src/services/file-state.ts",
  "src/services/permissions.ts",
  "src/services/workspace.ts",
  "src/tools",
  "src/tui/approval-panel.tsx",
  "src/tui/commands.ts",
  "src/tui/mentions.ts",
  "src/tui/message-list.tsx",
  "src/tui/model-picker.tsx",
  "src/tui/picker.tsx",
  "src/tui/printable.ts",
  "src/tui/tool-summary.ts",
  "tests/agent-approval.test.ts",
  "tests/agent-guards.test.ts",
  "tests/agent-interrupt.test.ts",
  "tests/agent-skills.test.ts",
  "tests/agent-tools.test.ts",
  "tests/agent-write-tools.test.ts",
  "tests/ask-agent.test.ts",
  "tests/chat-turn.test.ts",
  "tests/context-window.test.ts",
  "tests/evals.test.ts",
  "tests/fixtures",
  "tests/mcp.test.ts",
  "tests/mentions.test.ts",
  "tests/openrouter-models.test.ts",
  "tests/openrouter-replay.test.ts",
  "tests/permissions.test.ts",
  "tests/prompt.test.ts",
  "tests/recording.test.ts",
  "tests/script-layer.test.ts",
  "tests/slash.test.ts",
  "tests/tool-summary.test.ts",
  "tests/tui/bridge.test.ts",
  "tests/tui/closed-loop-agent.test.tsx",
  "tests/turn-history.test.ts",
  "tests/turn-loop.test.ts",
  "tests/upstream-errors.test.ts",
  "tests/workspace.test.ts",
];

/** The vanilla machinery itself, gone from the result. */
const MACHINERY = ["scripts/vanilla.ts", "template", ".github/workflows/vanilla.yml"];
/** package.json scripts for removed features, and this one. */
const DROP_SCRIPTS = ["eval", "record:openrouter", "vanilla"];
/** Dependencies only removed code imports (the agent's file tools). */
const DROP_DEPENDENCIES = ["diff", "ignore", "picomatch", "@types/picomatch"];

/** An expected failure: printed as one line, exit 1. Thrown, so cleanup and undo hints still run. */
class VanillaError extends Error {}

const fail = (message: string): never => {
  throw new VanillaError(message);
};

/** A bad argument, before anything changed: exit 2. */
const usage = (message: string): never => {
  process.stderr.write(`vanilla: ${message}\n`);
  process.exit(2);
};

const run = (cmd: string[], cwd: string, options: { quiet?: boolean } = {}) => {
  if (!options.quiet) process.stderr.write(`$ ${cmd.join(" ")}\n`);
  const result = Bun.spawnSync(cmd, {
    cwd,
    stdin: "inherit",
    stdout: options.quiet ? "pipe" : "inherit",
    stderr: options.quiet ? "pipe" : "inherit",
  });
  if (result.exitCode !== 0) {
    const output = options.quiet
      ? `\n${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`
      : "";
    fail(`\`${cmd.join(" ")}\` exited ${result.exitCode}${output}`);
  }
  return result.stdout?.toString() ?? "";
};

const git = (args: string[], cwd: string) => run(["git", ...args], cwd, { quiet: true });

const parse = () => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: {
        name: { type: "string" },
        branch: { type: "string", default: "vanilla" },
        "no-check": { type: "boolean", default: false },
        verify: { type: "boolean", default: false },
        // Internal: --verify runs HEAD's copy of this script in the worktree with this flag.
        "no-commit": { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
};

const options = parse();
const name = options.name;
if (name !== undefined && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
  usage(
    `--name must be lowercase letters, digits, and single dashes (like my-tool), got "${name}"`,
  );
}
if (name !== undefined) {
  // `bun run <name>` is the dev runner (today `bun run orx`), and dist/<name> goes on PATH.
  const scripts = Object.keys(
    (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: object }).scripts,
  );
  const taken = [...scripts.filter((s) => s !== "orx"), "bun", "node", "npm", "npx", "git"];
  if (taken.includes(name))
    usage(`--name ${name} is taken (a package.json script or a common tool)`);
}

/**
 * orx -> name, ORX -> NAME (dashes become underscores), Orx -> Name. In a camelCase identifier
 * (`orxLog`, `OrxError`, `orx_x`) the name is camelCased too (my-tool: `myToolLog`, `MyToolError`), so
 * code still parses. Never inside another word.
 */
const renamer = (to: string) => {
  const upper = to.toUpperCase().replaceAll("-", "_");
  const camel = to.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const pascal = camel[0]?.toUpperCase() + camel.slice(1);
  const title = to[0]?.toUpperCase() + to.slice(1);
  return (text: string) =>
    text
      .replace(/(?<![A-Za-z0-9])orx(?=[A-Z_])/g, camel)
      .replace(/(?<![A-Za-z0-9])Orx(?=[A-Z])/g, pascal)
      .replace(/(?<![A-Za-z0-9])orx(?![a-z0-9])/g, to)
      .replace(/(?<![A-Za-z0-9])ORX(?![A-Z0-9])/g, upper)
      .replace(/(?<![A-Za-z0-9])Orx(?![a-z0-9])/g, title);
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

/** Every file git tracks or would track, after the changes so far. */
const trackedFiles = (cwd: string) =>
  git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd)
    .split("\0")
    .filter((path) => path !== "" && existsSync(join(cwd, path)));

const rename = (cwd: string, to: string) => {
  const apply = renamer(to);
  for (const path of trackedFiles(cwd)) {
    // Only the root package's name: the rest is dependency hashes. bun install keeps it as is.
    if (path === "bun.lock") {
      const lock = readFileSync(join(cwd, path), "utf8");
      writeFileSync(join(cwd, path), lock.replace('"name": "orx"', `"name": "${to}"`));
      continue;
    }
    const full = join(cwd, path);
    if (!lstatSync(full).isFile()) continue; // symlinks (.claude/skills) point at renamed files
    const bytes = readFileSync(full);
    if (bytes.includes(0)) continue; // binary
    const text = bytes.toString("utf8");
    const renamed = apply(text);
    if (renamed !== text) writeFileSync(full, renamed);
    // Only the file name: a directory named orx would be a surprise worth failing on later.
    const target = join(dirname(path), apply(basename(path)));
    if (target !== path) renameSync(full, join(cwd, target));
  }
};

/** Removes one exact entry the vanilla machinery added to a config file. */
const dropEntry = (cwd: string, file: string, entry: string) => {
  const path = join(cwd, file);
  const text = readFileSync(path, "utf8");
  if (!text.includes(entry))
    fail(`${file} no longer has ${entry.trim()}; update scripts/vanilla.ts`);
  writeFileSync(path, text.replace(entry, ""));
};

const makeVanilla = (cwd: string, branch: string, check: boolean) => {
  if (git(["status", "--porcelain"], cwd).trim() !== "") {
    fail(
      "the working tree has changes. Commit or stash them first: this creates a branch from HEAD.",
    );
  }
  if (git(["branch", "--list", branch], cwd).trim() !== "") {
    fail(`branch ${branch} already exists. Pass --branch <name>, or delete it.`);
  }
  // `git status` doesn't show ignored files, and deleting them can't be undone.
  const doomed = git(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--", ...REMOVE],
    cwd,
  ).trim();
  if (doomed !== "") {
    fail(`these ignored files are under paths vanilla deletes; move them first:\n${doomed}`);
  }
  git(["switch", "--quiet", "-c", branch], cwd);

  for (const path of REMOVE) rmSync(join(cwd, path), { recursive: true, force: true });
  const template = join(cwd, "template", "vanilla");
  for (const file of walk(template)) cpSync(file, join(cwd, relative(template, file)));

  const pkgPath = join(cwd, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  for (const script of DROP_SCRIPTS) delete pkg.scripts[script];
  for (const dep of DROP_DEPENDENCIES) {
    if (!(dep in pkg.dependencies) && !(dep in pkg.devDependencies)) {
      fail(`package.json no longer depends on ${dep}; update scripts/vanilla.ts`);
    }
    delete pkg.dependencies[dep];
    delete pkg.devDependencies[dep];
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  dropEntry(cwd, "tsconfig.json", ', "template"');
  dropEntry(cwd, "biome.json", ', "!template"');
  for (const path of MACHINERY) rmSync(join(cwd, path), { recursive: true, force: true });

  if (name !== undefined) rename(cwd, name);

  // Not --frozen-lockfile: the lockfile names the root package, which --name renames.
  run(["bun", "install"], cwd);
  run(["bun", "run", "format"], cwd);
  if (check) run(["bun", "run", "check"], cwd);
};

/** Ignored paths now (`.orx/`), which a --name run would un-ignore; kept out of the commit. */
const ignoredNow = (cwd: string) =>
  git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], cwd)
    .split("\0")
    .filter((path) => path !== "");

const commit = (cwd: string, ignored: string[]) => {
  git(["add", "-A"], cwd);
  if (ignored.length > 0) git(["reset", "--quiet", "--", ...ignored], cwd);
  run(
    [
      "git",
      "commit",
      "--quiet",
      "-m",
      `chore: start from the vanilla template${name ? ` as ${name}` : ""}`,
    ],
    cwd,
  );
};

const verify = () => {
  // A throwaway worktree of HEAD, running HEAD's own copy of this script, so this checkout and its
  // branches are untouched and the result is exactly what a run on HEAD makes.
  const dir = mkdtempSync(join(tmpdir(), "vanilla-verify-"));
  const branch = `vanilla-verify-${process.pid}`;
  if (git(["status", "--porcelain"], ROOT).trim() !== "") {
    process.stderr.write("vanilla: --verify checks HEAD; uncommitted changes aren't included.\n");
  }
  // Ctrl+C reaches the child too; ignoring it here lets the cleanup below run.
  process.on("SIGINT", () => {});
  git(["worktree", "add", "--quiet", "--detach", dir, "HEAD"], ROOT);
  try {
    const args = ["--branch", branch, "--no-commit"];
    if (name !== undefined) args.push("--name", name);
    if (options["no-check"]) args.push("--no-check");
    const result = Bun.spawnSync(["bun", "scripts/vanilla.ts", ...args], {
      cwd: dir,
      env: { ...process.env, CI: process.env.CI ?? "1" }, // no git hooks in the throwaway tree
      stdio: ["inherit", "inherit", "inherit"],
    });
    if (result.exitCode !== 0) fail("the vanilla tree failed (output above).");
    process.stderr.write("vanilla: the vanilla tree passes.\n");
  } finally {
    // Never throws: a cleanup failure mustn't hide the real result.
    for (const cmd of [
      ["git", "worktree", "remove", "--force", dir],
      ["git", "branch", "-D", branch],
    ]) {
      Bun.spawnSync(cmd, { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
    }
  }
};

const main = () => {
  if (options.verify) return verify();
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"], ROOT).trim();
  const back =
    head === "HEAD"
      ? `git switch -f --detach ${git(["rev-parse", "HEAD"], ROOT).trim()}`
      : `git switch -f ${head}`;
  const ignored = ignoredNow(ROOT);
  try {
    makeVanilla(ROOT, options.branch, !options["no-check"]);
    if (!options["no-commit"]) commit(ROOT, ignored);
  } catch (error) {
    // Past the clean-tree check, a failure leaves the half-made tree on the new branch.
    const onBranch =
      Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT })
        .stdout.toString()
        .trim() === options.branch;
    if (onBranch && !options["no-commit"]) {
      process.stderr.write(
        `vanilla: the partial result is on branch ${options.branch}. To undo: ` +
          `${back} && git clean -fd && git branch -D ${options.branch}\n`,
      );
    }
    throw error;
  }
  if (options["no-commit"]) return;
  process.stderr.write(
    `vanilla: on branch ${options.branch}, one commit ahead. Next: read AGENTS.md, then replace ` +
      "src/commands/ask.ts and src/tui/app.tsx with the new CLI's first command and screen.\n",
  );
  if (name !== undefined && existsSync(join(ROOT, ".env"))) {
    process.stderr.write(
      `vanilla: .env isn't tracked, so rename any ORX_* settings in it yourself.\n`,
    );
  }
};

try {
  main();
} catch (error) {
  if (!(error instanceof VanillaError)) throw error;
  process.stderr.write(`vanilla: ${error.message}\n`);
  process.exit(1);
}
