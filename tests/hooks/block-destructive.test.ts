import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { bash, denyReason, GIT_ENV, type GitRepo, makeGitRepo, runHook } from "../helpers/hooks";

// Outside any git repo, so the rules that check the working tree can't find it clean and deny.
const NOT_A_REPO = realpathSync(mkdtempSync(join(tmpdir(), "orx-hook-norepo-")));
afterAll(() => rmSync(NOT_A_REPO, { recursive: true, force: true }));

const run = (command: unknown, cwd = NOT_A_REPO) =>
  runHook("PreToolUse", "block-destructive", { ...bash(command), cwd }, { env: GIT_ENV });

// The start of each rule's reason, so a row fails if a different rule is the one that fired.
const ROOT = "rm targeting the filesystem root, home, or the working directory.";
const WILDCARD = "rm with a bare wildcard.";
const XARGS = "Recursive rm fed by xargs";
const FIND = "find with -delete or -exec rm";
const REDIRECT = "Redirecting output to a raw disk device";
const DD = "dd writing to a raw disk device";
const MKFS = "mkfs reformats a device.";
const CHMOD = "chmod 777 makes files world-writable.";
const CHECKOUT = "git checkout . discards";
const RESTORE = "git restore . discards";
const CLEAN = "git clean -f deletes";
const RESET = "git reset --hard discards";
const STASH = "git stash drop/clear";
const PUSH = "Force push rewrites remote history.";
const DROP = "DROP or TRUNCATE";
const DELETE = "DELETE without a WHERE clause";
const KILL = "kill -1 signals every process";
const DOCKER = "This deletes Docker volumes";
const GH = "gh repo/release delete";
const PUBLISH = "Publishing a release is irreversible.";
const OPAQUE = "nested too deeply or expands into too many commands";

describe.concurrent("block-destructive denies", () => {
  it.each([
    ["rm -rf /", ROOT],
    ["rm -rf ~", ROOT],
    ["rm -rf .", ROOT],
    ["rm -rf ..", ROOT],
    ["rm -rf $HOME", ROOT],
    [`rm -rf $${"{"}PWD}`, ROOT],
    ["rm -rf /*", ROOT],
    ["rm -rf ~/", ROOT],
    ['rm -rf "$HOME"', ROOT],
    ["rm -r -f /", ROOT],
    ["rm -rf -- ~", ROOT],
    ["rm\t-rf\t~", ROOT],
    ["sudo -u root rm -rf ~", ROOT],
    ["sudo -n rm -rf /", ROOT],
    ["sudo -E rm -rf /", ROOT],
    ["timeout 5 rm -rf .", ROOT],
    ["env X=1 rm -rf $HOME", ROOT],
    ["FOO=bar rm -rf ~", ROOT],
    ["/bin/rm -rf /", ROOT],
    ["\\rm -rf ~", ROOT],
    ["$(rm -rf .)", ROOT],
    ["x=`rm -rf ~`", ROOT],
    ["(rm -rf ~)", ROOT],
    ["{ rm -rf ~; }", ROOT],
    ["cd /tmp && rm -rf ~", ROOT],
    ["if true; then rm -rf ~; fi", ROOT],
    ["echo hi\nrm -rf ~", ROOT],
    ["rm -f *", WILDCARD],
    ["bash -c 'rm -rf /'", ROOT],
    ['sh -c "cd /tmp; rm -rf ~"', ROOT],
    ["zsh -lc 'rm -rf ~'", ROOT],
    ['bash -c "echo \\"x\\"; rm -rf /"', ROOT],
    ["echo start\nbash -c 'rm -rf /'", ROOT],
    ["bash <<EOF\nrm -rf ~\nEOF", ROOT],
    ["eval 'rm -rf ~'", ROOT],
    ["ssh host rm -rf /", ROOT],
    ["ssh -p 2222 host 'cd /srv && rm -rf ~'", ROOT],
    // An unclosed quote means the quoting was misread: quotes are ignored (fail closed).
    ["echo 'oops; rm -rf ~", ROOT],
    ["find . -delete", FIND],
    ["find / -name '*.log' -delete", FIND],
    ["find ~ -name cache -exec rm -rf {} +", FIND],
    ["find -exec rm {} \\;", FIND],
    ["ls | xargs rm -rf", XARGS],
    ["git ls-files | xargs -0 rm -r", XARGS],
    ["cat image > /dev/disk2", REDIRECT],
    ["dd if=image of=/dev/sda", DD],
    ["mkfs.ext4 /dev/sdb1", MKFS],
    ['./scripts/prod-ssh.sh "mkfs.btrfs -f /dev/sdb1"', MKFS],
    ["chmod -R 777 .", CHMOD],
    ["git checkout .", CHECKOUT],
    ["git checkout -- .", CHECKOUT],
    ["git checkout -q HEAD -- .", CHECKOUT],
    ["git restore .", RESTORE],
    ["git restore --staged --worktree .", RESTORE],
    ["git clean -fd", CLEAN],
    ["git clean --force", CLEAN],
    ["git reset --hard HEAD~1", RESET],
    ["git -C /tmp reset -q --hard", RESET],
    ["x=$(git reset --hard)", RESET],
    ["git stash drop", STASH],
    ["git stash clear", STASH],
    ["git push -f", PUSH],
    ["git push -uf origin main", PUSH],
    ["git push origin main --force", PUSH],
    ["git push origin +main", PUSH],
    ["psql -c 'DROP TABLE users'", DROP],
    ['mysql -e "truncate table logs"', DROP],
    ["docker exec db psql -c 'DROP TABLE users'", DROP],
    ['sqlite3 app.db "DELETE FROM users;"', DELETE],
    // A heredoc fed to a database client is read as SQL.
    ["psql <<'SQL'\nDELETE FROM users;\nSQL", DELETE],
    ["kill -9 -1", KILL],
    ["kill -- -1", KILL],
    ["docker volume rm data", DOCKER],
    ["docker volume prune -f", DOCKER],
    ["docker system prune -a --volumes", DOCKER],
    ["docker compose down -v", DOCKER],
    ["docker compose -f dev.yml down --volumes", DOCKER],
    ["docker-compose down -v", DOCKER],
    ["ssh host 'docker volume prune -f'", DOCKER],
    ["gh repo delete me/x --yes", GH],
    ["gh release delete v1", GH],
    ["npm publish", PUBLISH],
    ["bun publish --access public", PUBLISH],
    ["twine upload dist/*", PUBLISH],
    ["goreleaser release --clean", PUBLISH],
    // Input fed to a database client or shell, through a pipe, ssh, or a container.
    ["docker exec -i db psql <<'SQL'\nDROP TABLE users;\nSQL", DROP],
    ["ssh host psql <<'SQL'\nDROP TABLE users;\nSQL", DROP],
    ["kubectl exec -i db -- psql <<SQL\nDROP TABLE users;\nSQL", DROP],
    ["echo 'DROP TABLE users;' | psql", DROP],
    ["cat <<SQL | psql\nDROP TABLE users;\nSQL", DROP],
    ["cat <<EOF | bash\nrm -rf ~\nEOF", ROOT],
    ["docker exec --detach-keys x db psql -c 'DROP TABLE t'", DROP],
    ["docker compose run --rm db psql -c 'DROP TABLE users'", DROP],
    // An unquoted heredoc runs its substitutions.
    ["cat <<EOF\n$(rm -rf ~)\nEOF", ROOT],
    ["cat > f <<EOF\n`git reset --hard`\nEOF", RESET],
    ["ls | xargs -J % rm -rf %", XARGS],
    ["ls | xargs --max-args 1 rm -rf", XARGS],
    ["find . | xargs -I{} sh -c 'rm -rf {}'", XARGS],
    ["find . -exec bash -c 'rm -rf /' \\;", ROOT],
    ["find -L / -name '*.log' -delete", FIND],
    ["find . -name '*' -delete", FIND],
    ["find . -not -name keep -delete", FIND],
    ['find "$PWD" -delete', FIND],
    ["(( x = 1<<2 ))\nrm -rf ~", ROOT],
    ["cat <<$'EOF'\nhi\nEOF\nrm -rf ~", ROOT],
    ["/usr/bin/env rm -rf /", ROOT],
    ["bash -O extglob -c 'rm -rf ~'", ROOT],
    ["eval eval eval eval eval eval eval eval eval eval rm -rf /", OPAQUE],
    // A carriage return separates words, as other blanks do.
    ["git reset\r--hard", RESET],
    ["docker compose down\r-v", DOCKER],
  ])("%j", async (command, reason) => {
    expect(denyReason(await run(command))).toContain(reason);
  });
});

describe.concurrent("block-destructive allows", () => {
  it.each([
    "rm -f out.txt && cd ..",
    "rm build.log; ls /",
    "echo 'a;rm -rf ~'",
    "rm -rf node_modules",
    "rm -rf ./build",
    "ssh host -c aes128-ctr ls",
    "git checkout -- src/file.ts",
    "git restore --staged .",
    "git push --force-with-lease",
    "git push origin HEAD:main && git branch -f main HEAD",
    "git push -q && gh api repos/x/y/pulls/1/comments -f body=ok",
    "git commit -m 'DROP TABLE users is scary'",
    'git commit -m "first line\n\nthen; rm -rf ~ in prose"',
    "git commit -F - <<'MSG'\nfix: stop using git reset --hard\nMSG",
    "git commit -m \"$(cat <<'EOF'\nfix: don't run git reset --hard here\nEOF\n)\"",
    // Text that isn't run: a heredoc fed to Python or written to a file, a comment, a quoted name.
    "python3 - <<'EOF'\nprint('rm -rf ~')\nprint('git push --force')\nEOF",
    "cat > notes.md <<'EOF'\nkillall node\nrm -rf /\nEOF",
    "# git reset --hard would lose this\necho hi",
    "printf ' bash -c \"rm -rf /\"\\n'",
    'bun run test tests/hooks -t "git reset --hard"',
    "psql -c 'DELETE FROM t WHERE id = 1'",
    "npm publish --dry-run",
    "kill 1234",
    "kill -1 1234",
    "killall node",
    'pkill -9 -f "Google Chrome"',
    "lsof -ti :3000 | xargs kill; rm -rf dist",
    "ls *.orig | xargs rm -f",
    "chmod 755 bin/tool",
    "docker compose down",
    "docker system prune -a -f",
    "docker image prune -f",
    "docker rmi app:old",
    "which mkfs.ext4",
    "find . -name '*.ts'",
    "find . -name '*.log' -delete",
    "find scripts -name __pycache__ -type d -exec rm -rf {} +",
    "find build -delete",
    "git stash list",
    "git clean -n",
    "git clean -fdn",
    "bun run test",
  ])("%j", async (command) => {
    const result = await run(command);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  // Long option runs used to backtrack exponentially in the rm rule. Past the hook timeout in
  // settings.json, Claude Code lets the command run.
  it("answers quickly for long runs of wrapper options", async () => {
    const slow = `timeout ${"-a 1 ".repeat(30)}farm`;
    const started = performance.now();
    const allowed = await run(slow);
    const denied = await run(`${`${slow}; `.repeat(5)}rm -rf ~`);
    expect(allowed.stdout).toBe("");
    expect(denyReason(denied)).toContain(ROOT);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("gives up on a line that expands into too many commands, quickly and closed", async () => {
    const started = performance.now();
    const result = await run(`${"sudo -a eval ".repeat(30)}true`);
    expect(denyReason(result)).toContain(OPAQUE);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

// reset --hard, checkout ., restore ., and clean -f are denied only when they would discard
// something, so they stay usable on a clean tree.
describe("block-destructive checks the working tree before discarding", () => {
  let repo: GitRepo;
  const inRepo = (command: string) => run(command, repo.dir);
  const denied = async (command: string) => denyReason(await inRepo(command));

  beforeEach(() => {
    repo = makeGitRepo();
    repo.put("a.txt", "1\n");
    repo.put("sub/b.txt", "1\n");
    repo.put(".gitignore", "ignored.log\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "init");
  });
  afterEach(() => repo.cleanup());

  it("allows every discard on a clean tree", async () => {
    for (const command of [
      "git reset --hard",
      "git reset --hard HEAD",
      "git checkout .",
      "git restore .",
      "git clean -fd",
    ]) {
      expect(await denied(command), command).toBeUndefined();
    }
  });

  it("denies discarding unstaged or staged changes", async () => {
    repo.put("a.txt", "2\n");
    expect(await denied("git reset --hard")).toContain(RESET);
    expect(await denied("git checkout .")).toContain(CHECKOUT);
    expect(await denied("git restore .")).toContain(RESTORE);
    repo.git("add", "a.txt");
    expect(await denied("git reset --hard")).toContain(RESET);
  });

  it("denies cleaning untracked files but not a reset that keeps them", async () => {
    repo.put("new.txt", "x\n");
    expect(await denied("git clean -fd")).toContain(CLEAN);
    expect(await denied("git reset --hard")).toBeUndefined();
  });

  it("counts ignored files only when clean removes them", async () => {
    repo.put("ignored.log", "x\n");
    expect(await denied("git clean -fd")).toBeUndefined();
    expect(await denied("git clean -fdx")).toContain(CLEAN);
  });

  it("checks only the paths clean is given", async () => {
    repo.put("keep/new.txt", "x\n");
    expect(await denied("git clean -fd build/")).toBeUndefined();
    expect(await denied("git clean -fd keep/")).toContain(CLEAN);
  });

  it("checks the paths clean is given, not the patterns it excludes", async () => {
    repo.put("new.txt", "x\n");
    expect(await denied("git clean -fd -e node_modules")).toContain(CLEAN);
    expect(await denied("git clean -fd --exclude '*.log'")).toContain(CLEAN);
  });

  it("counts untracked files for a reset to another commit, which can overwrite them", async () => {
    repo.put("new.txt", "x\n");
    expect(await denied("git reset --hard HEAD")).toBeUndefined();
    expect(await denied("git reset --hard origin/main")).toContain(RESET);
  });

  describe("with changes here and a clean repo elsewhere", () => {
    let other: GitRepo;
    beforeEach(() => {
      other = makeGitRepo();
      other.put("c.txt", "1\n");
      other.git("add", "-A");
      other.git("commit", "-q", "-m", "init");
      repo.put("a.txt", "2\n");
    });
    afterEach(() => other.cleanup());

    it("follows cd, pushd, and -C to the tree the command acts on", async () => {
      expect(await denied(`cd ${other.dir} && git reset --hard`)).toBeUndefined();
      expect(await denied(`pushd ${other.dir} && git checkout .`)).toBeUndefined();
      expect(await denied(`git -C ${other.dir} reset --hard`)).toBeUndefined();
      expect(await denied("git reset --hard")).toContain(RESET);
    });

    it("keeps a cd inside a subshell or substitution out of the commands after it", async () => {
      for (const command of [
        `(cd ${other.dir} && git status) && git reset --hard`,
        `X=$(cd ${other.dir} && pwd); git checkout .`,
        `pushd ${other.dir} && popd && git reset --hard`,
      ]) {
        expect(await denied(command), command).toBeDefined();
      }
    });
  });

  it("denies when it can't tell which tree or what it will hold", async () => {
    for (const command of [
      "cd $SOMEWHERE && git reset --hard",
      "ssh host git reset --hard",
      // An earlier command can change the tree before the reset runs.
      "git stash pop && git reset --hard",
      "mv a.txt b.txt && git reset --hard",
      "GIT_DIR=/elsewhere/.git git reset --hard",
      "git -c core.worktree=/elsewhere reset --hard",
      `git -C ${NOT_A_REPO} reset --hard`,
    ]) {
      expect(await denied(command), command).toContain(RESET);
    }
  });
});

describe("block-destructive contract", () => {
  it("returns a PreToolUse deny with the reason and the suggestion", async () => {
    const result = await run("git reset --hard");
    expect(result.code).toBe(0);
    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "BLOCKED: git reset --hard discards all uncommitted changes, staged and unstaged.\n\nUse git stash or a soft reset to keep the work. Ask the user first.",
      },
    });
  });

  it.each([
    ["malformed JSON", "not json"],
    ["an empty payload", ""],
    ["no tool_input", { tool_name: "Bash" }],
    ["an empty command", bash("")],
    ["a non-string command", bash(42)],
  ])("says nothing for %s", async (_, payload) => {
    const result = await runHook("PreToolUse", "block-destructive", payload, { tool: "Bash" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });
});
