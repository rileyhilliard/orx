import { Clock, Effect, FileSystem, Option, Path } from "effect";
import { Paths } from "../config";
import { Host } from "../services/Host";

/** The agent's base prompt. SYSTEM_PROMPT replaces it; the environment and memory still follow. */
export const DEFAULT_AGENT_PROMPT = [
  "You are orx, a coding agent working in the user's project from a terminal.",
  "Do what the user asks, keep replies short, and say what you changed when you're done.",
  "",
  "Tools:",
  "- Read a file before you edit it, and prefer editing a file over rewriting it with write.",
  "- Search with glob (file names) and grep (contents), not with bash find, grep, or ls.",
  "- bash has no persistent shell: each call starts in the workspace root with a fresh",
  "  environment, so cd and exported variables don't carry over to the next call.",
  "- Stay in the workspace. File tools refuse paths outside it; don't use bash to get around that.",
  "- If a tool fails, read the message and adjust instead of repeating the same call.",
].join("\n");

/** Memory (AGENTS.md files) past this many characters is cut, with a note. */
export const MEMORY_MAX_CHARS = 32 * 1024;

export interface PromptEnv {
  readonly root: string;
  readonly platform: string;
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly isGitRepo: boolean;
  /** The checked-out branch, or a short commit hash when HEAD is detached. */
  readonly branch?: string | undefined;
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
}

export interface SystemPromptInput {
  /** Replaces DEFAULT_AGENT_PROMPT (SYSTEM_PROMPT). */
  readonly base?: string | undefined;
  readonly env: PromptEnv;
  /** From `loadMemory`, in order. */
  readonly memory: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<SkillSummary>;
}

/**
 * The agent's system prompt: the base prompt, the environment, the skills the model can load,
 * then memory. Built once per session so the prefix stays the same across turns.
 */
export const buildSystemPrompt = ({ base, env, memory, skills }: SystemPromptInput): string => {
  const git = env.isGitRepo
    ? `yes${env.branch === undefined ? "" : ` (branch ${env.branch})`}`
    : "no";
  const sections = [
    base ?? DEFAULT_AGENT_PROMPT,
    [
      "<env>",
      `Workspace root: ${env.root}`,
      `Platform: ${env.platform}`,
      `Date: ${env.date}`,
      `Git repository: ${git}`,
      "</env>",
    ].join("\n"),
  ];
  if (skills.length > 0) {
    sections.push(
      [
        "Skills (load one with the skill tool when the task matches its description):",
        ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join("\n"),
    );
  }
  if (memory.length > 0) {
    sections.push(
      ["Project and user instructions (AGENTS.md). Follow them:", ...memory].join("\n\n"),
    );
  }
  return sections.join("\n\n");
};

/** The nearest directory at or above `dir` that holds `.git` (a directory, or a worktree's file). */
const findGitRoot = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (let current = dir; ; current = path.dirname(current)) {
      if (yield* fs.exists(path.join(current, ".git")).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(current);
      }
      if (path.dirname(current) === current) return Option.none<string>();
    }
  });

/** The branch HEAD points at, or a short hash when detached. Reads files; never runs git. */
const readBranch = (gitRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotGit = path.join(gitRoot, ".git");
    const info = yield* fs.stat(dotGit);
    let gitDir = dotGit;
    if (info.type === "File") {
      // A worktree or submodule: `.git` is a file saying `gitdir: <path>`.
      const pointer = (yield* fs.readFileString(dotGit)).match(/^gitdir:\s*(.+)$/m)?.[1];
      if (pointer === undefined) return undefined;
      gitDir = path.resolve(gitRoot, pointer.trim());
    }
    const head = (yield* fs.readFileString(path.join(gitDir, "HEAD"))).trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1];
    return ref ?? head.slice(0, 7);
  }).pipe(Effect.orElseSucceed(() => undefined));

/** The environment block's facts for a workspace root. */
export const gatherEnv = (root: string) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const now = yield* Clock.currentTimeMillis;
    const gitRoot = yield* findGitRoot(root);
    return {
      root,
      platform: host.platform,
      date: new Date(now).toISOString().slice(0, 10),
      isGitRepo: Option.isSome(gitRoot),
      branch: Option.isSome(gitRoot) ? yield* readBranch(gitRoot.value) : undefined,
    } satisfies PromptEnv;
  });

/**
 * Memory for the system prompt: the user's `$XDG_CONFIG_HOME/orx/AGENTS.md` (~/.config/orx),
 * then each directory's AGENTS.md (CLAUDE.md where there's none) from the git root, or the
 * workspace root outside git, down to the workspace root. Each entry names its file. Capped at
 * MEMORY_MAX_CHARS with a truncation note.
 */
export const loadMemory = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { configFile } = yield* Paths;
    const readIfExists = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.map((text) => Option.some(text.trim())),
        Effect.orElseSucceed(() => Option.none<string>()),
      );

    const top = Option.getOrElse(yield* findGitRoot(root), () => root);
    const dirs = [root];
    for (let dir = root; dir !== top; ) {
      dir = path.dirname(dir);
      dirs.unshift(dir);
    }

    const entries: Array<string> = [];
    const userFile = path.join(path.dirname(configFile), "AGENTS.md");
    const user = yield* readIfExists(userFile);
    if (Option.isSome(user)) entries.push(`Contents of ${userFile}:\n\n${user.value}`);
    for (const dir of dirs) {
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        const file = path.join(dir, name);
        const text = yield* readIfExists(file);
        if (Option.isSome(text)) {
          entries.push(`Contents of ${file}:\n\n${text.value}`);
          break;
        }
      }
    }
    return capMemory(entries);
  });

const capMemory = (entries: ReadonlyArray<string>): Array<string> => {
  const kept: Array<string> = [];
  let used = 0;
  for (const entry of entries) {
    if (used + entry.length > MEMORY_MAX_CHARS) {
      const room = MEMORY_MAX_CHARS - used;
      if (room > 0) kept.push(entry.slice(0, room));
      kept.push(`[memory truncated at ${MEMORY_MAX_CHARS / 1024} KiB; the rest was left out]`);
      break;
    }
    kept.push(entry);
    used += entry.length;
  }
  return kept;
};
