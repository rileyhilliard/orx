// Destructive-command rules, used by block-destructive.ts. Kept in their own module so any other
// hook you add (an auto-approver, a Bash rewriter) can consult the same list: if a rule lives here,
// nothing can approve a command the guard would deny.
//
// Rules look at commands the way bash runs them (see _shell.ts): the command word and its
// arguments, so a commit message, a heredoc fed to Python, or a quoted test string that mentions
// a dangerous command doesn't trip them. The aim is to stop what can't be undone (losing
// uncommitted work, rewriting shared history, deleting data) without getting in the way of
// ordinary work: a hard reset on a clean tree, pruning Docker images, or removing __pycache__
// directories with find all pass.
//
// Add project-specific rules at the end of check() (e.g. a deploy script that must never run from
// an agent session), with rows in tests/hooks/block-destructive.test.ts.
import { basename, join } from "node:path";
import { type Command, commands } from "./_shell";

/**
 * What a git command would throw away, when that can be checked before it runs: block-destructive
 * allows the command if git reports nothing of that kind in `dir` (relative to the tool call's
 * cwd) for `paths`. "tracked": staged or unstaged changes. "untracked": untracked files, plus
 * ignored ones with `ignored`. "any": either (a reset to another commit overwrites untracked files
 * that commit has).
 */
export type Loss = {
  kind: "tracked" | "untracked" | "any";
  ignored?: boolean;
  dir: string | undefined;
  paths: string[];
};

export type Finding = { reason: string; suggestion: string; loss?: Loss };

const hit = (reason: string, suggestion: string, loss?: Loss): Finding =>
  loss ? { reason, suggestion, loss } : { reason, suggestion };

// rm targets: /, ~, ., .., $HOME, $PWD, or their / and /* forms, quoted or not.
const RM_ROOT = /^(\/\*?|(~|\$HOME|\$\{HOME\}|\$PWD|\$\{PWD\}|\.\.?)(\/\*?)?)$/;
const RAW_DISK = /^\/dev\/(sd|nvme|hd|disk|mapper|vd|xvd)/;
const DB_CLIENTS = new Set([
  "psql",
  "pgcli",
  "mysql",
  "mariadb",
  "mycli",
  "sqlite3",
  "litecli",
  "sqlcmd",
  "duckdb",
  "clickhouse",
  "clickhouse-client",
  "cockroach",
  "snowsql",
]);
const PUBLISHERS = new Set(["npm", "pnpm", "yarn", "bun", "uv", "cargo", "poetry", "gem"]);
// find tests that narrow what matches by name or path.
const FIND_FILTERS = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-iwholename",
  "-regex",
  "-iregex",
]);
// find's own options, before its start paths (GNU and BSD).
const FIND_OPTIONS = /^-([HLPEXdsx]|D|f|O[0-9]?)$/;
// Pathspecs that mean "everything here".
const EVERYTHING = new Set([".", "./", ":/", "*"]);

/** A short-option cluster (-fdx) containing `letter`; long options don't count. */
const hasShort = (args: string[], letter: string) =>
  args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));

/** Options before the subcommand (-C dir, -c key=value) and the directory the command acts on. */
function gitParts(cmd: Command) {
  const { argv } = cmd;
  let dir: string | null | undefined = cmd.dir;
  let i = 1;
  while (i < argv.length && (argv[i] as string).startsWith("-")) {
    const opt = argv[i] as string;
    if (opt === "-c" && /^core\.(worktree|bare)/.test(argv[i + 1] ?? "")) dir = null;
    if (opt === "-C") {
      const target = argv[i + 1];
      dir =
        dir === null || target === undefined || /[$~`]/.test(target)
          ? null
          : target.startsWith("/")
            ? target
            : join(dir ?? ".", target);
    }
    if (opt.startsWith("--git-dir") || opt.startsWith("--work-tree")) dir = null;
    i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(opt) ? 2 : 1;
  }
  // GIT_DIR=... or GIT_WORK_TREE=... points git somewhere other than the directory.
  if (cmd.remote || cmd.env.some((e) => /^GIT_(DIR|WORK_TREE|COMMON_DIR)=/.test(e))) dir = null;
  return { sub: argv[i], args: argv.slice(i + 1), dir };
}

/**
 * Arguments that aren't options or option values: after --, everything; before it, words not
 * starting with - that don't follow an option in `valued` (git clean -e <pattern>).
 */
const operands = (args: string[], valued: string[] = []) => {
  const dashes = args.indexOf("--");
  const before = dashes < 0 ? args : args.slice(0, dashes);
  const after = dashes < 0 ? [] : args.slice(dashes + 1);
  const kept = before.filter((a, k) => !a.startsWith("-") && !valued.includes(before[k - 1] ?? ""));
  return [...kept, ...after];
};

function checkGit(cmd: Command, checkable: boolean): Finding | undefined {
  const { sub, args, dir } = gitParts(cmd);
  const loss = (kind: Loss["kind"], paths: string[], ignored = false): Loss | undefined =>
    checkable && dir !== null ? { kind, dir, paths, ...(ignored ? { ignored } : {}) } : undefined;

  if (sub === "checkout" && args.some((a) => EVERYTHING.has(a))) {
    return hit(
      "git checkout . discards every unstaged change.",
      "Revert specific files: git checkout -- <file>",
      loss("tracked", ["."]),
    );
  }
  if (sub === "restore" && args.some((a) => EVERYTHING.has(a))) {
    const staged = args.includes("--staged") || hasShort(args, "S");
    const worktree = args.includes("--worktree") || hasShort(args, "W");
    if (!staged || worktree) {
      return hit(
        "git restore . discards every unstaged change.",
        "Revert specific files: git restore <file>",
        loss("tracked", ["."]),
      );
    }
  }
  if (sub === "clean") {
    const force = args.includes("--force") || hasShort(args, "f");
    const dryRun = args.includes("--dry-run") || hasShort(args, "n");
    if (force && !dryRun) {
      const ignored = hasShort(args, "x") || hasShort(args, "X");
      return hit(
        "git clean -f deletes untracked files permanently.",
        "Preview with git clean -n. Ask the user first.",
        loss("untracked", operands(args, ["-e", "--exclude"]), ignored),
      );
    }
  }
  if (sub === "reset" && args.includes("--hard")) {
    const target = operands(args).filter((a) => a !== "HEAD" && a !== "@");
    return hit(
      "git reset --hard discards all uncommitted changes, staged and unstaged.",
      "Use git stash or a soft reset to keep the work. Ask the user first.",
      loss(target.length > 0 ? "any" : "tracked", []),
    );
  }
  if (sub === "stash" && (args[0] === "drop" || args[0] === "clear")) {
    return hit(
      "git stash drop/clear destroys stashed work.",
      "Other sessions may have work in the stash. Ask the user first.",
    );
  }
  // --force-with-lease and --force-if-includes are allowed.
  if (
    sub === "push" &&
    (args.includes("--force") ||
      hasShort(args, "f") ||
      args.some((a) => a.startsWith("+") && a.length > 1))
  ) {
    return hit(
      "Force push rewrites remote history.",
      "Ask the user first. If it is needed, use --force-with-lease.",
    );
  }
  return undefined;
}

/** The statements a database client would run: its arguments and any heredoc fed to it. */
function checkSql(cmd: Command): Finding | undefined {
  const chunks = [...cmd.argv.slice(1), ...cmd.stdin];
  const sql = chunks.join("\n");
  if (/drop\s+(table|database|schema)|truncate\s+(table\s+)?[A-Za-z0-9_".]+/i.test(sql)) {
    return hit("DROP or TRUNCATE causes irreversible data loss.", "Ask the user first.");
  }
  const statements = chunks.flatMap((chunk) => chunk.split(";"));
  if (statements.some((stmt) => /^\s*delete\s+from\s+\S+\s*$/i.test(stmt))) {
    return hit(
      "DELETE without a WHERE clause empties the table.",
      "Add a WHERE clause, or ask the user first.",
    );
  }
  return undefined;
}

const publishing = () =>
  hit("Publishing a release is irreversible.", "Releases are user-initiated. Ask the user first.");

function check(cmd: Command, checkable: boolean): Finding | undefined {
  const { argv, quoted } = cmd;
  const args = argv.slice(1);
  const name = basename(argv[0] ?? "");

  if (cmd.opaque) {
    return hit(
      "The command is nested too deeply or expands into too many commands to check.",
      "Split it into simpler commands, or ask the user first.",
    );
  }

  if (cmd.redirects.some((target) => RAW_DISK.test(target))) {
    return hit(
      "Redirecting output to a raw disk device destroys it.",
      "Do not run without explicit confirmation.",
    );
  }

  switch (name) {
    case "rm": {
      if (cmd.viaXargs && (hasShort(args, "r") || hasShort(args, "R"))) {
        return hit(
          "Recursive rm fed by xargs removes whatever the pipeline produces.",
          "Review the pipeline. Ask the user first.",
        );
      }
      const dashes = args.indexOf("--");
      const targets = args
        .map((text, k) => ({ text, quoted: quoted[k + 1] ?? false, k }))
        .filter((t) => !t.text.startsWith("-") || (dashes >= 0 && t.k > dashes));
      if (targets.some((t) => RM_ROOT.test(t.text))) {
        return hit(
          "rm targeting the filesystem root, home, or the working directory.",
          "Name the exact paths to remove. Ask the user first.",
        );
      }
      if (targets.some((t) => t.text === "*" && !t.quoted)) {
        return hit(
          "rm with a bare wildcard.",
          "Be explicit about which files to remove. Ask the user first.",
        );
      }
      return undefined;
    }
    case "find": {
      const deletes =
        args.includes("-delete") ||
        args.some(
          (a, k) =>
            (a === "-exec" || a === "-execdir") &&
            ["rm", "unlink", "shred"].includes(basename(args[k + 1] ?? "")),
        );
      if (!deletes) return undefined;
      // Start paths come after find's own options (-L, -H, -D debug...) and before the first
      // expression word.
      let first = 0;
      while (FIND_OPTIONS.test(args[first] ?? ""))
        first += /^-[Df]$/.test(args[first] ?? "") ? 2 : 1;
      const rest = args.slice(first);
      const firstExpr = rest.findIndex((a) => /^[-(!]/.test(a));
      const roots = firstExpr < 0 ? rest : rest.slice(0, firstExpr);
      // A name or path test narrows the match, unless it is negated or matches everything.
      const filtered = rest.some(
        (a, k) =>
          FIND_FILTERS.has(a) &&
          !/^[*?]*$/.test(rest[k + 1] ?? "") &&
          !["!", "-not"].includes(rest[k - 1] ?? ""),
      );
      // From / or ~ it's too broad either way; from the working directory (the default), only
      // without a filter. A named directory is like rm -rf of it, which is allowed.
      const fromTop = roots.some((r) => /^(\/|~|\$HOME|\$\{HOME\})\/?$/.test(r));
      const fromHere =
        roots.length === 0 ||
        roots.some((r) => /^(\.\.?|\$PWD|\$\{PWD\}|\$\(pwd\)|`pwd`)\/?$/.test(r));
      if (fromTop || (fromHere && !filtered)) {
        return hit(
          "find with -delete or -exec rm from / or ~, or from here with no name or path filter, deletes everything it walks.",
          "Add -name or -path, start from a specific directory, or ask the user first.",
        );
      }
      return undefined;
    }
    case "dd":
      if (args.some((a) => a.startsWith("of=") && RAW_DISK.test(a.slice(3)))) {
        return hit(
          "dd writing to a raw disk device destroys it.",
          "Confirm the of= target. Ask the user first.",
        );
      }
      return undefined;
    case "chmod": {
      const mode = args.find((a) => !a.startsWith("-"));
      if (mode === "777" || mode === "0777") {
        return hit(
          "chmod 777 makes files world-writable.",
          "Use 755 for directories and 644 for files.",
        );
      }
      return undefined;
    }
    case "git":
      return checkGit(cmd, checkable);
    case "kill": {
      // kill -9 -1 (any signal) signals every process you own.
      const pids = args.filter((a, k) => !(k === 0 && a.startsWith("-")) && a !== "--");
      if (pids.includes("-1")) {
        return hit(
          "kill -1 signals every process you own.",
          "Kill a specific PID, or ask the user.",
        );
      }
      return undefined;
    }
    case "docker":
    case "podman":
    case "docker-compose": {
      const down = args.indexOf("down");
      const volumes =
        (args[0] === "volume" && (args[1] === "rm" || args[1] === "prune")) ||
        (args[0] === "system" && args[1] === "prune" && args.includes("--volumes")) ||
        ((name === "docker-compose" || args[0] === "compose") &&
          down >= 0 &&
          (args.includes("--volumes") || hasShort(args.slice(down), "v")));
      if (volumes) {
        return hit(
          "This deletes Docker volumes, which hold database data.",
          "The Docker context may not be local. Ask the user first.",
        );
      }
      return undefined;
    }
    case "gh":
      if ((args[0] === "repo" || args[0] === "release") && args[1] === "delete") {
        return hit("gh repo/release delete is unrecoverable.", "Ask the user first.");
      }
      return undefined;
    case "twine":
      return args[0] === "upload" ? publishing() : undefined;
    case "goreleaser":
      return args[0] === "release" && !args.includes("--snapshot") ? publishing() : undefined;
    default:
      if (/^mkfs(\.[A-Za-z0-9]+)?$/.test(name)) {
        return hit("mkfs reformats a device.", "Do not run without explicit confirmation.");
      }
      if (PUBLISHERS.has(name) && args.includes("publish") && !args.includes("--dry-run")) {
        return publishing();
      }
      if (DB_CLIENTS.has(name)) return checkSql(cmd);
      return undefined;
  }
}

/**
 * Every rule the command line trips, in the order its commands run. A finding with `loss` is only
 * destructive if the tree has something of that kind to lose.
 */
export function findings(line: string): Finding[] {
  const found: Finding[] = [];
  // The tree is checked before the line runs, so that check only holds while every earlier
  // command leaves the tree as it was. After anything else (git stash pop, mv, a build), git's
  // discard rules deny outright.
  let checkable = true;
  for (const cmd of commands(line)) {
    const finding = check(cmd, checkable);
    if (finding) found.push(finding);
    if (!keepsTree(cmd)) checkable = false;
  }
  return found;
}

const READ_ONLY = new Set([
  "cd",
  "pushd",
  "popd",
  "echo",
  "printf",
  "true",
  ":",
  "sleep",
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "grep",
  "wc",
  "test",
  "[",
  "gh",
]);
// Git subcommands that don't change the working tree, or (checkout, switch) carry its changes
// along unchanged.
const GIT_KEEPS_TREE = new Set([
  "status",
  "log",
  "diff",
  "show",
  "fetch",
  "rev-parse",
  "branch",
  "remote",
  "tag",
  "describe",
  "ls-files",
  "merge-base",
  "symbolic-ref",
  "config",
  "checkout",
  "switch",
  "worktree",
]);

function keepsTree(cmd: Command): boolean {
  const name = basename(cmd.argv[0] ?? "");
  if (name === "git") {
    const { sub, args } = gitParts(cmd);
    return sub === undefined || GIT_KEEPS_TREE.has(sub) || (sub === "stash" && args[0] === "list");
  }
  return cmd.argv.length === 0 || READ_ONLY.has(name);
}

/** The first rule the command line trips, without checking the working tree. */
export function isDestructive(line: string): Finding | undefined {
  return findings(line)[0];
}
