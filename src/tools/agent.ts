import { Effect, type FileSystem, Layer, type Path } from "effect";
import { Toolkit } from "effect/unstable/ai";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { FileState } from "../services/file-state";
import type { Permissions } from "../services/permissions";
import type { Workspace } from "../services/workspace";
import { Bash, runBash } from "./bash";
import { Edit, editFile } from "./edit";
import { Glob, globFiles } from "./glob";
import { Grep, grepFiles, hasRipgrep } from "./grep";
import { ChatToolsLive, CurrentTime } from "./index";
import { Read, readFile } from "./read";
import { Write, writeFile } from "./write";

/**
 * The coding agent's tools. Separate from ChatTools on purpose: `orx mcp` serves ChatTools,
 * and file and shell tools over MCP would bypass the agent's approval gate.
 */
export const AgentTools = Toolkit.make(Read, Glob, Grep, Write, Edit, Bash, CurrentTime);

type AgentServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Workspace
  | FileState
  | Permissions;

const FileToolsLive = Toolkit.make(Read, Glob, Grep, Write, Edit, Bash).toLayer(
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
      write: (input) => writeFile(input).pipe(Effect.provideContext(context)),
      edit: (input) => editFile(input).pipe(Effect.provideContext(context)),
      bash: (input) => runBash(input).pipe(Effect.provideContext(context)),
    };
  }),
);

/** Handlers for AgentTools. Needs the platform services, a Workspace, a FileState, and Permissions. */
export const AgentToolsLive = Layer.mergeAll(ChatToolsLive, FileToolsLive);
