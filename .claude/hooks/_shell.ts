// A small shell lexer for the Bash guards. It splits a command line into the simple commands bash
// would run, with quotes removed, so a guard can look at a command word and its arguments instead
// of grepping raw text. Text that isn't run as a command doesn't reach the guards: quoted
// arguments (a commit message), heredoc bodies fed to a program that isn't a shell (a Python
// script, a file written with cat), and # comments.
//
// Commands that run other commands are followed: $( ), backticks, <( ), substitutions inside an
// unquoted heredoc, bash/sh -c, eval, su -c, heredocs and pipes into a shell, ssh (and scripts
// named like *ssh*), rr run/exec, xargs, find -exec, docker/kubectl exec and run, and wrappers such as sudo,
// env, timeout, nice. Input fed to a command (heredocs, a pipe from echo or a heredoc) travels with
// it as `stdin`, including through ssh and docker exec, so a guard can read the SQL sent to psql.
//
// It errs toward matching: a quote left open means the line was misread, so it is lexed again with
// quotes as ordinary characters, and a line nested too deep or expanding into too many commands
// yields an `opaque` command, which the guards deny.
import { basename, join } from "node:path";

export type Command = {
  /** From the command word on, quotes removed. Empty for a bare redirect (> file). */
  argv: string[];
  /** Per argv word, whether any part of it was quoted (a quoted * is not a glob). */
  quoted: boolean[];
  /** Assignments before the command word (GIT_DIR=x git ...). */
  env: string[];
  /** Redirect targets (> /dev/sda). */
  redirects: string[];
  /** Text fed to the command's standard input: heredocs, or what's piped in from echo or a heredoc. */
  stdin: string[];
  /** Fed its arguments by xargs, directly or through a shell xargs runs. */
  viaXargs: boolean;
  /** Runs somewhere this machine's state can't be checked (ssh, a container). */
  remote: boolean;
  /** Directory relative to where the line starts (undefined: there), from cd, pushd, popd; null: unknown. */
  dir: string | null | undefined;
  /** Too deeply nested or too long to follow; guards treat it as destructive. */
  opaque?: boolean;
};

type Word = { text: string; quoted: boolean };
type Simple = {
  words: Word[];
  redirects: string[];
  heredocs: string[];
  scope: number;
  pipedFrom?: Simple;
};

const BLANK = new Set([" ", "\t", "\r", "\v", "\f"]);
const WORD_END = new Set([...BLANK, "\n", ";", "&", "|", "<", ">", "(", ")"]);

class Unbalanced extends Error {}

/** Shared by the lex calls for one line: output, whether quotes count, and subshell scopes. */
type Lexing = { raw: boolean; out: Simple[]; parents: Map<number, number> };

const newScope = (lx: Lexing, parent: number) => {
  const id = lx.parents.size + 1;
  lx.parents.set(id, parent);
  return id;
};

/** Index just past the )) closing an arithmetic expression opened at `from` (after its (( ). */
function arithmeticEnd(src: string, from: number): number {
  let depth = 2;
  for (let i = from; i < src.length; i++) {
    const c = src.charAt(i);
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  throw new Unbalanced();
}

/** Lex the command substitutions in an unquoted heredoc body, which bash runs. */
function heredocSubstitutions(lx: Lexing, body: string, scope: number) {
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c === "\\") i++;
    else if (c === "$" && body.startsWith("$((", i)) i = arithmeticEnd(body, i + 3) - 1;
    else if (c === "$" && body.charAt(i + 1) === "(")
      i = lex(lx, body, i + 2, true, newScope(lx, scope)) - 1;
    else if (c === "`") {
      const end = body.indexOf("`", i + 1);
      if (end < 0) throw new Unbalanced();
      lex(lx, body.slice(i + 1, end), 0, false, newScope(lx, scope));
      i = end;
    }
  }
}

/**
 * Lex `src` from `start` into lx.out (substitution bodies first, as they run first), in `scope`.
 * With `stopAtParen` it returns the index just past the ) closing the substitution; otherwise the
 * end.
 */
function lex(lx: Lexing, src: string, start: number, stopAtParen: boolean, scope: number): number {
  const { raw, out } = lx;
  const n = src.length;
  const scopes = [scope];
  const current = () => scopes[scopes.length - 1] as number;
  const fresh = (pipedFrom?: Simple): Simple => ({
    words: [],
    redirects: [],
    heredocs: [],
    scope: current(),
    ...(pipedFrom ? { pipedFrom } : {}),
  });
  let cmd = fresh();
  let word = "";
  let inWord = false;
  let quoted = false;
  let redirectNext = false;
  const pending: { delim: string; strip: boolean; expands: boolean; cmd: Simple }[] = [];

  const add = (text: string, isQuoted = false) => {
    word += text;
    inWord = true;
    if (isQuoted) quoted = true;
  };
  const endWord = () => {
    if (!inWord) return;
    if (redirectNext) cmd.redirects.push(word);
    else cmd.words.push({ text: word, quoted });
    redirectNext = false;
    word = "";
    inWord = false;
    quoted = false;
  };
  const endCmd = (pipe = false) => {
    endWord();
    const done = cmd.words.length > 0 || cmd.redirects.length > 0 ? cmd : undefined;
    if (done) out.push(done);
    cmd = fresh(pipe ? done : undefined);
  };
  const readHeredocs = (from: number) => {
    let i = from;
    for (const doc of pending) {
      const body: string[] = [];
      while (i < n) {
        const nl = src.indexOf("\n", i);
        const end = nl < 0 ? n : nl;
        const line = src.slice(i, end);
        i = end + 1;
        if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
        body.push(line);
      }
      const text = body.join("\n");
      doc.cmd.heredocs.push(text);
      if (doc.expands) heredocSubstitutions(lx, text, doc.cmd.scope);
    }
    pending.length = 0;
    return Math.min(i, n);
  };
  const substitution = (from: number) => lex(lx, src, from, true, newScope(lx, current()));
  const backtick = (from: number) => {
    let j = from;
    while (j < n && src.charAt(j) !== "`") j += src.charAt(j) === "\\" ? 2 : 1;
    if (j >= n) throw new Unbalanced();
    lex(lx, src.slice(from, j), 0, false, newScope(lx, current()));
    return j + 1;
  };

  let i = start;
  while (i < n) {
    const c = src.charAt(i);
    if (c === "\n") {
      endCmd();
      i = readHeredocs(i + 1);
      continue;
    }
    if (!raw && c === "\\") {
      if (src.charAt(i + 1) === "\n") i += 2;
      else {
        add(src.charAt(i + 1), true);
        i += 2;
      }
      continue;
    }
    if (!raw && c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Unbalanced();
      add(src.slice(i + 1, j), true);
      i = j + 1;
      continue;
    }
    if (!raw && c === '"') {
      add("", true);
      i++;
      for (;;) {
        if (i >= n) throw new Unbalanced();
        const d = src.charAt(i);
        if (d === '"') break;
        if (d === "\\" && '$`"\\\n'.includes(src.charAt(i + 1))) {
          if (src.charAt(i + 1) !== "\n") add(src.charAt(i + 1));
          i += 2;
        } else if (src.startsWith("$((", i)) {
          const end = arithmeticEnd(src, i + 3);
          add(src.slice(i, end));
          i = end;
        } else if (d === "$" && src.charAt(i + 1) === "(") {
          const end = substitution(i + 2);
          add(src.slice(i, end));
          i = end;
        } else if (d === "`") {
          const end = backtick(i + 1);
          add(src.slice(i, end));
          i = end;
        } else {
          add(d);
          i++;
        }
      }
      i++;
      continue;
    }
    if (src.startsWith("$((", i) || (!inWord && src.startsWith("((", i))) {
      // Arithmetic: nothing runs, and 1<<2 isn't a heredoc.
      const open = src.startsWith("$((", i) ? 3 : 2;
      const end = arithmeticEnd(src, i + open);
      add(src.slice(i, end));
      i = end;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && src.charAt(i + 1) === "(") {
      // $( ) command substitution, <( ) and >( ) process substitution.
      const end = substitution(i + 2);
      add(src.slice(i, end));
      i = end;
      continue;
    }
    if (!raw && c === "`") {
      const end = backtick(i + 1);
      add(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i < n && src.charAt(i) !== "\n") i++;
      continue;
    }
    if (BLANK.has(c)) {
      endWord();
      i++;
      continue;
    }
    if (c === "(") {
      endCmd();
      scopes.push(newScope(lx, current()));
      cmd = fresh();
      i++;
      continue;
    }
    if (c === ")") {
      endCmd();
      i++;
      if (scopes.length === 1) {
        if (stopAtParen) return i;
        continue;
      }
      scopes.pop();
      cmd = fresh();
      continue;
    }
    if (c === "|") {
      // | and |& pipe into the next command; || doesn't.
      const or = src.charAt(i + 1) === "|";
      endCmd(!or);
      i += or || src.charAt(i + 1) === "&" ? 2 : 1;
      continue;
    }
    if (c === ";" || (c === "&" && src.charAt(i + 1) !== ">")) {
      endCmd();
      i++;
      continue;
    }
    if (c === "&" || c === "<" || c === ">") {
      // A word of digits right before the operator is a file descriptor (2>&1), not an argument.
      if (inWord && !quoted && /^[0-9]+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      if (src.startsWith("<<<", i)) {
        i += 3; // A here-string: the next word is an ordinary argument.
        continue;
      }
      if (src.startsWith("<<", i)) {
        i += 2;
        const strip = src.charAt(i) === "-";
        if (strip) i++;
        while (BLANK.has(src.charAt(i))) i++;
        let delim = "";
        let delimQuoted = false;
        while (i < n && !WORD_END.has(src.charAt(i))) {
          const d = src.charAt(i);
          if (d === "'" || d === '"' || d === "\\") delimQuoted = true;
          else if (!(d === "$" && "'\"".includes(src.charAt(i + 1)))) delim += d;
          i++;
        }
        if (delim) pending.push({ delim, strip, expands: !delimQuoted, cmd });
        continue;
      }
      // > >> >& <& >| <> &> &>>
      i++;
      while (i < n && ">&|".includes(src.charAt(i))) i++;
      redirectNext = true;
      continue;
    }
    add(c);
    i++;
  }
  if (!raw && stopAtParen) throw new Unbalanced();
  endCmd();
  return n;
}

function simples(src: string): { list: Simple[]; parents: Map<number, number> } {
  const lx: Lexing = { raw: false, out: [], parents: new Map() };
  try {
    lex(lx, src, 0, false, 0);
    return { list: lx.out, parents: lx.parents };
  } catch (error) {
    if (!(error instanceof Unbalanced)) throw error;
  }
  const rawLx: Lexing = { raw: true, out: [], parents: new Map() };
  try {
    lex(rawLx, src, 0, false, 0);
  } catch (error) {
    if (!(error instanceof Unbalanced)) throw error;
    // Even without quotes the parentheses don't close: read each line as one command.
    return {
      list: src.split("\n").map((line) => ({
        words: line.split(/[ \t]+/).map((text) => ({ text, quoted: false })),
        redirects: [],
        heredocs: [],
        scope: 0,
      })),
      parents: new Map(),
    };
  }
  return { list: rawLx.out, parents: rawLx.parents };
}

const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "{",
  "}",
  "time",
]);
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "exec",
  "command",
  "builtin",
  "nohup",
  "time",
  "nice",
  "ionice",
  "timeout",
  "stdbuf",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Every position the command word could be at, after assignments, keywords, and wrappers with
 * their options (sudo -u root, timeout 5, nice -n 10). A wrapper's option may or may not take the
 * next word as its value, so both readings are kept; each (position, state) is visited once.
 */
function commandStarts(words: Word[]): number[] {
  const starts: number[] = [];
  const seen = new Set<string>();
  const queue: [number, "top" | "args"][] = [];
  const push = (k: number, state: "top" | "args") => {
    const key = `${k}:${state}`;
    if (k > words.length || seen.has(key)) return;
    seen.add(key);
    queue.push([k, state]);
  };
  push(0, "top");
  for (let next = queue.pop(); next; next = queue.pop()) {
    const [k, state] = next;
    const text = words[k]?.text;
    if (state === "args") {
      push(k, "top");
      if (text === undefined) continue;
      if (text.startsWith("-")) {
        push(k + 1, "args");
        const value = words[k + 1]?.text;
        if (value !== undefined && !value.startsWith("-")) push(k + 2, "args");
      } else if (/^[0-9]/.test(text) || ASSIGNMENT.test(text)) {
        push(k + 1, "args");
      }
      continue;
    }
    if (text === undefined) continue;
    starts.push(k);
    if (KEYWORDS.has(text) || ASSIGNMENT.test(text)) push(k + 1, "top");
    if (WRAPPERS.has(basename(text))) push(k + 1, "args");
  }
  return starts.length > 0 ? starts : [0];
}

type Context = { remote: boolean; dir: string | null | undefined; viaXargs: boolean };
/** How much expansion is left for one line; past it, the rest is opaque. */
type Budget = { commands: number };

const MAX_DEPTH = 8;

function joinDir(dir: string | null | undefined, target: string | undefined): string | null {
  if (dir === null || target === undefined || /[$~`]/.test(target) || target === "-") return null;
  if (target.startsWith("/")) return target;
  return join(dir ?? ".", target);
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const SSH_VALUE_OPTIONS = "BbcDEeFIiJLlmOoPpQRSWw";
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const RR_VALUE_OPTIONS = new Set([
  "--host",
  "--tag",
  "--cwd",
  "--tail",
  "--repeat",
  "--probe-timeout",
  "--pull",
  "--pull-dest",
  "--config",
]);

function opaque(ctx: Context): Command {
  return {
    argv: [],
    quoted: [],
    env: [],
    redirects: [],
    stdin: [],
    viaXargs: ctx.viaXargs,
    remote: ctx.remote,
    dir: null,
    opaque: true,
  };
}

/**
 * Lex `src` and push its commands (and the ones they run) onto `out`. `stdin` is input the caller
 * feeds this command line (an ssh command's heredoc), given to each of its commands.
 */
function expand(
  src: string,
  ctx: Context,
  depth: number,
  budget: Budget,
  out: Command[],
  stdin: string[] = [],
): void {
  if (depth > MAX_DEPTH) {
    out.push(opaque(ctx));
    return;
  }
  const { list, parents } = simples(src);
  // cd, pushd, and popd per subshell scope; a scope starts from its parent's directory.
  const dirs = new Map<number, { dir: string | null | undefined; stack: (string | null)[] }>();
  const scopeOf = (id: number): { dir: string | null | undefined; stack: (string | null)[] } => {
    let entry = dirs.get(id);
    if (!entry) {
      const parent = parents.get(id);
      entry = { dir: parent === undefined ? ctx.dir : scopeOf(parent).dir, stack: [] };
      dirs.set(id, entry);
    }
    return entry;
  };
  for (const simple of list) {
    const scope = scopeOf(simple.scope);
    const input = [...simple.heredocs, ...stdin, ...pipedInput(simple.pipedFrom)];
    for (const start of commandStarts(simple.words)) {
      if (--budget.commands < 0) {
        out.push(opaque(ctx));
        return;
      }
      const words = simple.words.slice(start);
      const cmd: Command = {
        argv: words.map((w) => w.text),
        quoted: words.map((w) => w.quoted),
        env: simple.words
          .slice(0, start)
          .map((w) => w.text)
          .filter((t) => ASSIGNMENT.test(t)),
        redirects: simple.redirects,
        stdin: input,
        viaXargs: ctx.viaXargs,
        remote: ctx.remote,
        dir: scope.dir,
      };
      out.push(cmd);
      follow(cmd, depth, budget, out);
    }
    const [first, target] = simple.words.map((w) => w.text);
    if (first === "cd" || first === "pushd") {
      if (first === "pushd") scope.stack.push(scope.dir ?? null);
      scope.dir = joinDir(scope.dir, target);
    } else if (first === "popd") {
      scope.dir = scope.stack.length > 0 ? (scope.stack.pop() as string | null) : null;
    }
  }
}

/** What a command piped into another feeds it: a heredoc, or the text echo or printf prints. */
function pipedInput(from: Simple | undefined): string[] {
  if (!from) return [];
  const [first, ...rest] = from.words.map((w) => w.text);
  const printed = first === "echo" || first === "printf" ? [rest.join(" ")] : [];
  return [...from.heredocs, ...printed];
}

/** Commands that `cmd` runs: a shell's -c script or stdin, an ssh remote command, xargs'... */
function follow(cmd: Command, depth: number, budget: Budget, out: Command[]): void {
  const { argv } = cmd;
  const name = basename(argv[0] ?? "");
  const same: Context = { remote: cmd.remote, dir: cmd.dir, viaXargs: cmd.viaXargs };
  const remote: Context = { remote: true, dir: null, viaXargs: cmd.viaXargs };
  const run = (src: string, ctx: Context, stdin: string[] = []) =>
    expand(src, ctx, depth + 1, budget, out, stdin);
  // A command made of argv[from..], fed this command's stdin (docker exec -i, xargs).
  const sub = (from: number, extra: Partial<Command>) => {
    if (from >= argv.length) return;
    if (--budget.commands < 0 || depth + 1 > MAX_DEPTH) {
      out.push(opaque(same));
      return;
    }
    const next: Command = {
      ...cmd,
      argv: argv.slice(from),
      quoted: cmd.quoted.slice(from),
      env: [],
      ...extra,
    };
    out.push(next);
    follow(next, depth + 1, budget, out);
  };
  // Every position after `from` a command could start at, since options with values vary.
  const subsAfterOperand = (from: number, extra: Partial<Command>) => {
    for (let k = from; k < argv.length; k++) {
      if (!(argv[k] as string).startsWith("-")) sub(k + 1, extra);
    }
  };

  if (SHELLS.has(name)) {
    let i = 1;
    let script = false;
    while (i < argv.length && /^[-+]/.test(argv[i] as string)) {
      const opt = argv[i] as string;
      if (/^-[A-Za-z]*c/.test(opt)) script = true;
      i += ["-o", "+o", "-O", "+O"].includes(opt) ? 2 : 1;
    }
    if (script && argv[i] !== undefined) run(argv[i] as string, same);
    else if (argv[i] === undefined || argv[i] === "-s")
      for (const text of cmd.stdin) run(text, same);
  } else if (name === "eval") {
    run(argv.slice(1).join(" "), same);
  } else if (name === "su") {
    const c = argv.findIndex((a) => a === "-c" || a === "--command");
    if (c > 0 && argv[c + 1] !== undefined) run(argv[c + 1] as string, remote);
  } else if (name === "ssh" || (name.includes("ssh") && !name.startsWith("ssh-"))) {
    // ssh [options] host [command], or a wrapper script such as scripts/prod-ssh.sh "<command>".
    let i = 1;
    if (name === "ssh") {
      while (i < argv.length && (argv[i] as string).startsWith("-")) {
        const opt = argv[i] as string;
        i += opt.length === 2 && SSH_VALUE_OPTIONS.includes(opt.charAt(1)) ? 2 : 1;
      }
      i++; // the host
    }
    const remoteCommand = argv.slice(i).join(" ");
    if (remoteCommand.trim()) run(remoteCommand, remote, cmd.stdin);
    else for (const text of cmd.stdin) run(text, remote);
  } else if (name === "xargs") {
    // xargs [options] command...: the command is a non-option word, or follows an option's value.
    for (let k = 1; k < argv.length; k++) {
      if (!(argv[k] as string).startsWith("-")) sub(k, { viaXargs: true });
    }
  } else if (name === "find") {
    argv.forEach((a, k) => {
      if (!FIND_EXEC.has(a)) return;
      const end = argv.findIndex((b, j) => j > k && (b === ";" || b === "+"));
      const inner = argv.slice(k + 1, end < 0 ? undefined : end);
      if (inner.length > 0) run(inner.map(quoteWord).join(" "), same);
    });
  } else if (
    (name === "docker" || name === "podman" || name === "docker-compose") &&
    argv.some((a) => a === "exec" || a === "run")
  ) {
    // docker [compose] exec|run [options] <container|service|image> <command>...
    const at = argv.findIndex((a) => a === "exec" || a === "run");
    subsAfterOperand(at + 1, { remote: true, dir: null });
  } else if (name === "kubectl" && argv.includes("exec") && argv.includes("--")) {
    sub(argv.indexOf("--") + 1, { remote: true, dir: null });
  } else if (name === "rr") {
    // rr [global options] run|exec [options] "<command>": runs the command on a remote host, or
    // here with --local. Global options (-q, --config <file>) may come before the subcommand.
    let at = 1;
    while (at < argv.length && (argv[at] as string).startsWith("-")) {
      at += RR_VALUE_OPTIONS.has(argv[at] as string) ? 2 : 1;
    }
    if (argv[at] !== "run" && argv[at] !== "exec") return;
    const words: string[] = [];
    for (let k = at + 1; k < argv.length; k++) {
      const a = argv[k] as string;
      if (!a.startsWith("-")) words.push(a);
      else if (RR_VALUE_OPTIONS.has(a)) k++;
    }
    const local = argv.some(
      (a) => a === "--local" || (a.startsWith("--local=") && a !== "--local=false"),
    );
    if (words.length > 0) run(words.join(" "), local ? same : remote);
  }
}

/** A word quoted for re-lexing (find -exec's words are already unquoted). */
const quoteWord = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/** The simple commands in a Bash tool command line, including the ones it runs indirectly. */
export function commands(line: string): Command[] {
  const out: Command[] = [];
  expand(line, { remote: false, dir: undefined, viaXargs: false }, 0, { commands: 2000 }, out);
  return out;
}
