// SessionStart: a few lines of live state that AGENTS.md can't carry because it is static: the
// branch, how dirty the tree is, whether .env exists, whether dependencies are installed, whether
// the installed Bun matches `packageManager`, whether OpenTUI's native package for this host is
// installed, whether the stub servers from this checkout are running, and how many warn/error
// lines the dev log gained since the previous session started.
//
// Plain-text stdout from a SessionStart hook is added to the agent's context. Cheap: a few git
// calls and file checks. Add project-specific checks at the end (a missing symlink, a required
// login).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDir, projectRoot, readPayload } from "./_lib";

readPayload(); // Unused, but read so the writer never blocks on a full pipe.

const lines: string[] = [];
const say = (line: string) => lines.push(line);

const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" });

function repoState(): void {
  if (git("rev-parse", "--is-inside-work-tree").status !== 0) return;
  // `branch --show-current` rather than `rev-parse --abbrev-ref HEAD`, which prints "HEAD"
  // before the first commit.
  const branch = git("branch", "--show-current").stdout?.trim() || "(detached HEAD)";
  const status = git("status", "--porcelain");
  const dirty = status.status === 0 ? String(status.stdout.split("\n").length - 1) : "?";
  say(`Repo state: branch \`${branch}\`, ${dirty} changed file(s).`);
  // No nag before the first commit: a new project's initial commit goes on main. Repos that work
  // on main by design opt out with `git config orx.allowMain true`.
  const hasCommit = git("rev-parse", "-q", "--verify", "HEAD").status === 0;
  const allowMain = git("config", "--bool", "orx.allowMain").stdout?.trim() === "true";
  if (hasCommit && !allowMain && (branch === "main" || branch === "master")) {
    say(`You're on \`${branch}\`: create a branch before committing non-trivial work.`);
  }
}

function envFile(): void {
  if (existsSync(".env.example") && !existsSync(".env")) {
    say(
      ".env is missing. Copy .env.example to .env and fill in local values before running the app (tests don't need it).",
    );
  }
}

function installCommand(dir: string): string {
  for (const lockDir of [dir, "."]) {
    if (existsSync(join(lockDir, "bun.lock")) || existsSync(join(lockDir, "bun.lockb"))) {
      return "bun install";
    }
    if (existsSync(join(lockDir, "pnpm-lock.yaml"))) return "pnpm install";
    if (existsSync(join(lockDir, "yarn.lock"))) return "yarn install";
    if (existsSync(join(lockDir, "package-lock.json"))) return "npm install";
  }
  return "npm install";
}

// A package.json without node_modules/, at the root or one directory down. lint-on-write and
// format-changed only use project-local tools, so without an install they go quiet.
function dependencies(): void {
  // Workspace members install into the root node_modules.
  const workspace =
    isDir("node_modules") &&
    (existsSync("pnpm-workspace.yaml") ||
      (existsSync("package.json") &&
        readFileSync("package.json", "utf8").includes('"workspaces"')));
  const skipped = new Set(["node_modules", ".venv", "venv", "vendor", "dist", "build", "target"]);
  const dirs = [
    ".",
    ...readdirSync(".")
      .filter((name) => !name.startsWith(".") && !skipped.has(name) && isDir(name))
      .sort(),
  ];
  const missing: string[] = [];
  const hints: string[] = [];
  for (const dir of dirs) {
    const top = dir === ".";
    if (
      existsSync(join(dir, "package.json")) &&
      !isDir(join(dir, "node_modules")) &&
      (top || !workspace)
    ) {
      missing.push(`${top ? "" : `${dir}/`}node_modules`);
      hints.push(`\`${top ? "" : `cd ${dir} && `}${installCommand(dir)}\``);
    }
  }
  if (missing.length === 0) return;
  const make = existsSync("Makefile") && /^install\s*:/m.test(readFileSync("Makefile", "utf8"));
  say(
    `Dependencies not installed (missing ${missing.join(", ")}), so lint-on-write and format-changed skip those files. Install with ${make ? "`make install`" : hints.join("; ")}.`,
  );
}

// orx: `bun run` resolves to whatever bun is on PATH, and bun doesn't enforce `packageManager`, so
// a different version builds and tests against a runtime CI doesn't use. This hook runs under
// that same bun.
function bunVersion(): void {
  if (!existsSync("package.json")) return;
  let pinned: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { packageManager?: unknown };
    pinned = typeof pkg.packageManager === "string" ? pkg.packageManager : undefined;
  } catch {
    return;
  }
  const wanted = pinned?.startsWith("bun@") ? pinned.slice(4) : undefined;
  const running = process.versions.bun;
  if (!wanted || !running || wanted === running) return;
  say(
    `bun ${running} is on PATH, but package.json pins bun@${wanted} (packageManager), which CI and the release builds use. Ask the user before running \`bun upgrade\` (it changes their machine); until then, a difference between local and CI results may be the runtime.`,
  );
}

// orx: OpenTUI loads a native library from an optional package per platform. bun skips optional
// packages it can't install, so a missing one shows up only when the TUI starts.
function openTuiNative(): void {
  const core = "node_modules/@opentui/core/package.json";
  if (!existsSync(core)) return;
  const base = `@opentui/core-${process.platform}-${process.arch}`;
  const candidates = process.platform === "linux" ? [base, `${base}-musl`] : [base];
  if (candidates.some((name) => isDir(join("node_modules", name)))) return;
  say(
    `node_modules/${base} is missing, so OpenTUI can't load its native library: bare orx, orx doctor --tui, and bun run test:tui fail on this machine. Run \`bun install\` (it installs the optional package for this platform); everything else works without it.`,
  );
}

// orx: stub OpenRouter and releases servers started by `bun run stub` from this checkout
// (logs/stub.pid holds "<pid> ..."; the process's command names scripts/stub-server.ts, so a stale pid
// reused by something else is ignored).
function stub(): void {
  if (!existsSync("logs/stub.pid")) return;
  const [pid] = readFileSync("logs/stub.pid", "utf8").trim().split(/\s+/);
  if (!pid || !/^[0-9]+$/.test(pid)) return;
  const ps = spawnSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" });
  if (!ps.stdout?.includes("scripts/stub-server.ts")) return;
  say(
    `The stub OpenRouter and releases servers are running (pid ${pid}); \`bun run stub\` prints the env that points orx at them. \`bun run stub:stop\` stops them; leave them running if the user started them.`,
  );
}

// orx: `bun run orx -- <args>` appends JSON log lines to logs/orx.jsonl. Problems since the last
// session are worth reading before guessing; older ones were reported then. The byte offset read
// up to is kept under $TMPDIR/orx-hooks/, keyed by the repo root, with the file's inode and first
// bytes: when either changes (scripts/orx-dev.ts rotated the log, or it was deleted and recreated)
// or the file shrank, it is read from the start again.
type LogMark = { ino: number; head: string; offset: number };

function readBytes(file: string, start: number, length: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function orxLog(root: string): void {
  const file = "logs/orx.jsonl";
  if (!existsSync(file)) return;
  const dir = join((process.env.TMPDIR || "/tmp").replace(/\/$/, ""), "orx-hooks");
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const markFile = join(dir, `orx-log-${key}.json`);

  const { ino, size } = statSync(file);
  const head = readBytes(file, 0, Math.min(size, 256)).toString("latin1");
  let start = 0;
  try {
    const mark = JSON.parse(readFileSync(markFile, "utf8")) as Partial<LogMark>;
    const same = mark.ino === ino && typeof mark.head === "string" && head.startsWith(mark.head);
    if (same && typeof mark.offset === "number" && mark.offset <= size) start = mark.offset;
  } catch {
    // No mark yet (the first session in this checkout) or an unreadable one: count from the start.
  }

  const added = readBytes(file, start, size - start);
  // Only whole lines: one still being written is counted next time.
  const end = added.lastIndexOf(0x0a) + 1;
  const problems = added
    .subarray(0, end)
    .toString("utf8")
    .split("\n")
    .filter((line) => /"level":"(warn|error|fatal)"/.test(line)).length;
  try {
    mkdirSync(dir, { recursive: true });
    const mark: LogMark = { ino, head, offset: start + end };
    writeFileSync(markFile, JSON.stringify(mark));
  } catch {
    // An unwritable TMPDIR: the next session counts these lines again, which is only noise.
  }
  if (problems === 0) return;
  const query = `jq -c 'select(.level == "warn" or .level == "error" or .level == "fatal")'`;
  say(
    start === 0
      ? `${file} has ${problems} warn/error line(s): ${query} ${file}`
      : `${file} has ${problems} new warn/error line(s) since the last session started: tail -c +${start + 1} ${file} | ${query}`,
  );
}

const root = projectRoot();
try {
  process.chdir(root);
} catch {
  process.exit(0);
}
repoState();
envFile();
dependencies();
bunVersion();
openTuiNative();
stub();
orxLog(root);
if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
