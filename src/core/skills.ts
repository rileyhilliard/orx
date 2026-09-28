import { Effect, FileSystem, Path } from "effect";
import { SkillFrontmatter } from "../schemas";
import {
  byName,
  type CustomCommand,
  decodeFrontmatter,
  isDirectory,
  type Loaded,
  loadCommands,
  logWarnings,
  parseMarkdown,
  readText,
  slashDirs,
  withArguments,
} from "./commands";

/**
 * Skills: a directory with a `SKILL.md` (frontmatter `name` and `description`, then Markdown),
 * from `<root>/.orx/skills/*` and `~/.config/orx/skills/*`. A workspace skill wins a name clash.
 * Loading reads files and nothing else; a skill never runs anything.
 */
export interface Skill {
  readonly name: string;
  readonly description: string;
  /** The skill's directory (absolute): its supporting files are relative to it. */
  readonly dir: string;
  readonly body: string;
}

/** Past these a skill still loads, with a warning: it costs context every time it's used. */
export const MAX_SKILL_LINES = 500;
export const MAX_DESCRIPTION_CHARS = 1024;

const loadSkillDir = (dir: string, warnings: Array<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* isDirectory(dir))) return [];
    const entries = yield* fs.readDirectory(dir).pipe(
      Effect.catch((error) => {
        warnings.push(`Can't list ${dir}: ${error.message}`);
        return Effect.succeed([] as Array<string>);
      }),
    );
    const skills: Array<Skill> = [];
    for (const entry of [...entries].sort()) {
      const skillDir = path.join(dir, entry);
      const file = path.join(skillDir, "SKILL.md");
      if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) continue;
      const loaded = yield* Effect.result(
        Effect.gen(function* () {
          const { fields, body } = parseMarkdown(yield* readText(file));
          const meta = yield* decodeFrontmatter(SkillFrontmatter)({ name: entry, ...fields }, file);
          const skill: Skill = {
            name: meta.name ?? entry,
            description: meta.description.trim(),
            dir: path.resolve(skillDir),
            body,
          };
          return skill;
        }),
      );
      if (loaded._tag === "Failure") {
        warnings.push(loaded.failure);
        continue;
      }
      const skill = loaded.success;
      const lines = skill.body.split("\n").length;
      if (lines > MAX_SKILL_LINES) {
        warnings.push(
          `${file}: ${lines} lines (over ${MAX_SKILL_LINES}); move detail into supporting files`,
        );
      }
      if (skill.description.length > MAX_DESCRIPTION_CHARS) {
        warnings.push(
          `${file}: description is ${skill.description.length} characters (over ${MAX_DESCRIPTION_CHARS})`,
        );
      }
      skills.push(skill);
    }
    return skills;
  });

/** Every skill, the workspace's winning over the user's. */
export const loadSkills = (root: string) =>
  Effect.gen(function* () {
    const warnings: Array<string> = [];
    const lists: Array<ReadonlyArray<Skill>> = [];
    for (const dir of yield* slashDirs(root, "skills")) {
      lists.push(yield* loadSkillDir(dir, warnings));
    }
    yield* logWarnings(warnings);
    return { items: byName(lists), warnings } satisfies Loaded<Skill>;
  });

/**
 * Commands and skills for the `/` menu. A skill named like a command stays loaded (the `skill`
 * tool can still reach it) but `/name` runs the command, with a warning.
 */
export const loadSlash = (root: string) =>
  Effect.gen(function* () {
    const commands = yield* loadCommands(root);
    const skills = yield* loadSkills(root);
    const names = new Set(commands.items.map((c) => c.name));
    const clashes = skills.items
      .filter((s) => names.has(s.name))
      .map((s) => `Skill "${s.name}" has a command's name; /${s.name} runs the command`);
    yield* logWarnings(clashes);
    return {
      commands: commands.items,
      skills: skills.items,
      warnings: [...commands.warnings, ...skills.warnings, ...clashes],
    } satisfies {
      readonly commands: ReadonlyArray<CustomCommand>;
      readonly skills: ReadonlyArray<Skill>;
      readonly warnings: ReadonlyArray<string>;
    };
  });

/** The user message `/skill args` sends: the body, with `ARGUMENTS: …` appended when given. */
export const expandSkill = (skill: Skill, args: string): string => withArguments(skill.body, args);

/** What the `skill` tool returns: where the skill lives, then its body. */
export const skillToolResult = (skill: Skill): string =>
  `Skill "${skill.name}" (directory: ${skill.dir}; its supporting files are relative to it)\n\n${skill.body}`;
