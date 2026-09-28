import { Schema } from "effect";

/**
 * Frontmatter of a custom command (`.orx/commands/**.md`). Open: unknown keys (Claude Code's
 * `allowed-tools`, `argument-hint`) are ignored and grant nothing.
 */
export const CommandFrontmatter = Schema.Struct({
  description: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});
export type CommandFrontmatter = typeof CommandFrontmatter.Type;

/** A skill's name: what `/name` and the `skill` tool take. No spaces, slashes, or colons. */
export const SkillName = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      /^[A-Za-z0-9][\w.-]*$/.test(value) ||
      `Expected letters, digits, ".", "-", or "_", got "${value}"`,
  ),
);

/** Frontmatter of a `SKILL.md`. Open, like CommandFrontmatter: `allowed-tools` grants nothing. */
export const SkillFrontmatter = Schema.Struct({
  name: Schema.optional(SkillName),
  description: Schema.String,
});
export type SkillFrontmatter = typeof SkillFrontmatter.Type;
