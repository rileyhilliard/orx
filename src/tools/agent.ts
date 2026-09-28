import { Effect, type FileSystem, Layer, type Path } from "effect";
import { Toolkit } from "effect/unstable/ai";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { FileState } from "../services/file-state";
import type { Workspace } from "../services/workspace";
import { Glob, globFiles } from "./glob";
import { Grep, grepFiles, hasRipgrep } from "./grep";
import { ChatToolsLive, CurrentTime } from "./index";
import { Read, readFile } from "./read";

/**
 * The coding agent's tools. Separate from ChatTools on purpose: `orx mcp` serves ChatTools,
 * and file and shell tools over MCP would bypass the agent's approval gate.
 */
export const AgentTools = Toolkit.make(Read, Glob, Grep, CurrentTime);

type AgentServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Workspace
  | FileState;

const FileToolsLive = Toolkit.make(Read, Glob, Grep).toLayer(
  Effect.gen(function* () {
    // Handlers can't require services, so the ones the tools need are captured here.
    const context = yield* Effect.context<AgentServices>();
    // Checked on the first grep, not while the layer builds.
    const useRipgrep = yield* Effect.cached(hasRipgrep);
    return {
      read: (input) => readFile(input).pipe(Effect.provideContext(context)),
      glob: (input) => globFiles(input).pipe(Effect.provideContext(context)),
      grep: (input) =>
        useRipgrep.pipe(
          Effect.flatMap((rg) => grepFiles(input, rg)),
          Effect.provideContext(context),
        ),
    };
  }),
);

/** Handlers for AgentTools. Needs the platform services, a Workspace, and a FileState. */
export const AgentToolsLive = Layer.mergeAll(ChatToolsLive, FileToolsLive);
