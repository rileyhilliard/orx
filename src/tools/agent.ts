import { Effect, type FileSystem, type Path } from "effect";
import { Toolkit } from "effect/unstable/ai";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { ToolFailure } from "~/schemas";
import type { FileState } from "../services/file-state";
import type { Permissions } from "../services/permissions";
import type { Workspace } from "../services/workspace";
import { Bash, runBash } from "./bash";
import { Edit, editFile } from "./edit";
import { Glob, globFiles } from "./glob";
import { Grep, grepFiles, hasRipgrep } from "./grep";
import { catchToolDefect } from "./permit";
import { Read, readFile } from "./read";
import { Write, writeFile } from "./write";

/** The coding agent's tools. Every one that changes something asks Permissions first. */
export const AgentTools = Toolkit.make(Read, Glob, Grep, Write, Edit, Bash);

const guard = (name: string) => catchToolDefect(name, (message) => new ToolFailure({ message }));

type AgentServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Workspace
  | FileState
  | Permissions;

/** Handlers for AgentTools. Needs the platform services, a Workspace, a FileState, and Permissions. */
export const AgentToolsLive = AgentTools.toLayer(
  Effect.gen(function* () {
    // Handlers can't require services, so the ones the tools need are captured here.
    const context = yield* Effect.context<AgentServices>();
    // Checked on the first grep, not while the layer builds.
    const useRipgrep = yield* Effect.cached(hasRipgrep);
    return {
      read: (input) => readFile(input).pipe(Effect.provideContext(context), guard("read")),
      glob: (input) => globFiles(input).pipe(Effect.provideContext(context), guard("glob")),
      grep: (input) =>
        useRipgrep.pipe(
          Effect.flatMap((rg) => grepFiles(input, rg)),
          Effect.provideContext(context),
          guard("grep"),
        ),
      write: (input) => writeFile(input).pipe(Effect.provideContext(context), guard("write")),
      edit: (input) => editFile(input).pipe(Effect.provideContext(context), guard("edit")),
      bash: (input) => runBash(input).pipe(Effect.provideContext(context), guard("bash")),
    };
  }),
);
