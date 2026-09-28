import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { type Skill, skillToolResult } from "../core/skills";

/**
 * Loads a skill's instructions into the conversation. The system prompt lists the skills'
 * names and descriptions; this returns one body, with its directory so the model can read the
 * supporting files it mentions. `failureMode: "return"`: an unknown name goes back to the
 * model as the result, with the names it can use.
 */
export const SkillTool = Tool.make("skill", {
  description:
    "Load a skill's instructions by name. Call it when a listed skill fits the task, before doing the task.",
  parameters: Schema.Struct({
    name: Schema.String.annotate({ description: "The skill's name, as listed" }),
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
});

export const SkillTools = Toolkit.make(SkillTool);

/** The `skill` handler over the skills loaded for this session. */
export const skillToolLayer = (skills: ReadonlyArray<Skill>) =>
  SkillTools.toLayer({
    skill: ({ name }) => {
      const skill = skills.find((s) => s.name === name);
      if (skill) return Effect.succeed(skillToolResult(skill));
      const names = skills.map((s) => s.name).join(", ");
      return Effect.fail(
        names === ""
          ? `Unknown skill "${name}": no skills are installed.`
          : `Unknown skill "${name}". Skills: ${names}.`,
      );
    },
  });
