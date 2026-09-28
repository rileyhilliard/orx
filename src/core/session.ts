import { Effect, Layer, Option } from "effect";
import { Toolkit } from "effect/unstable/ai";
import { DEFAULT_SYSTEM_PROMPT, loadConfig } from "../config";
import { FileState } from "../services/file-state";
import { type PermissionMode, Permissions } from "../services/permissions";
import { Workspace } from "../services/workspace";
import { AgentTools, AgentToolsLive } from "../tools/agent";
import { SkillTools, skillToolLayer } from "../tools/skill";
import { listWorkspaceFiles, mentionAttachments } from "./mentions";
import { buildSystemPrompt, gatherEnv, loadMemory } from "./prompt";
import { loadSkills } from "./skills";

/** The agent's tools: the file and shell tools plus `skill`. */
export const SessionTools = Toolkit.merge(AgentTools, SkillTools);

/**
 * Everything a coding session needs, built once: the workspace root (`--cwd`, or the cwd),
 * the system prompt with memory and skill descriptions, and the layer with the tools'
 * handlers and the per-session Workspace, FileState, and Permissions. Skill directories become extra
 * read-only roots, so `read` can open a skill's supporting files.
 */
export const prepareSession = (
  cwd: Option.Option<string>,
  permissions: { readonly mode: PermissionMode; readonly headless: boolean } = {
    mode: "default",
    headless: false,
  },
) =>
  Effect.gen(function* () {
    const root = yield* Workspace.resolveRoot(Option.getOrUndefined(cwd), Option.isSome(cwd));
    const config = yield* loadConfig;
    const skills = (yield* loadSkills(root)).items;
    const systemPrompt = buildSystemPrompt({
      // SYSTEM_PROMPT replaces the base prompt only when the user set one.
      ...(config.systemPrompt !== DEFAULT_SYSTEM_PROMPT ? { base: config.systemPrompt } : {}),
      env: yield* gatherEnv(root),
      memory: yield* loadMemory(root),
      skills: skills.map((s) => ({ name: s.name, description: s.description })),
    });
    const state = Layer.mergeAll(
      Workspace.layer(root),
      FileState.layer,
      // Headless (`ask --agent`), anything that would ask is denied instead.
      permissions.headless
        ? Permissions.layerHeadless(permissions.mode)
        : Permissions.layer(permissions.mode),
    );
    const readRoots = Layer.effectDiscard(
      Effect.gen(function* () {
        const ws = yield* Workspace;
        yield* Effect.forEach(skills, (s) => Effect.ignore(ws.addReadRoot(s.dir)), {
          discard: true,
        });
      }),
    );
    const layer = Layer.mergeAll(AgentToolsLive, skillToolLayer(skills), readRoots).pipe(
      Layer.provideMerge(state),
    );
    return {
      root,
      systemPrompt,
      toolkit: SessionTools,
      layer,
      // The `@` file picker's list and the attachments sent with a message.
      listFiles: listWorkspaceFiles,
      attachFiles: mentionAttachments,
    } as const;
  });
