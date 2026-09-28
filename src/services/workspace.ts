import { Context, Effect, FileSystem, Layer, Option, Path, Ref } from "effect";
import { ToolFailure } from "~/schemas";
import { Paths } from "../config";
import { BadInput } from "../errors";

export interface WorkspaceShape {
  /** The workspace root, realpathed. */
  readonly root: string;
  /**
   * A path the file tools may touch: absolute or root-relative, realpathed through its nearest
   * existing ancestor, and inside the root (symlinks included). Anything else is a ToolFailure.
   */
  readonly resolve: (path: string) => Effect.Effect<string, ToolFailure>;
  /** Like `resolve`, but also accepts paths under an extra read-only root (a skill's directory). */
  readonly resolveReadable: (path: string) => Effect.Effect<string, ToolFailure>;
  /** Lets `read` (not write or edit) reach files under `dir`, for a loaded skill's supporting files. */
  readonly addReadRoot: (dir: string) => Effect.Effect<void, ToolFailure>;
  /** A resolved path as the model should see it: root-relative when inside the root. */
  readonly display: (path: string) => string;
  /** `.env*`, `*.pem`, `*.key`, `id_*`: files that likely hold credentials. */
  readonly isSecretPath: (path: string) => boolean;
}

/** True when `child` is `parent` or under it. Both must be absolute and normalized. */
const isWithin = (path: Path.Path, parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

const makeWorkspace = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const readRoots = yield* Ref.make<ReadonlyArray<string>>([]);

    /**
     * The real path of `input`: realpath of its nearest existing ancestor plus the missing tail.
     * A dangling symlink on the way fails, since a later write through it would land wherever
     * it points.
     */
    const realPathOf = (input: string) =>
      Effect.gen(function* () {
        let current = path.isAbsolute(input) ? path.normalize(input) : path.resolve(root, input);
        const tail: Array<string> = [];
        while (true) {
          const real = yield* Effect.option(fs.realPath(current));
          if (Option.isSome(real)) return path.join(real.value, ...tail.reverse());
          if (Option.isSome(yield* Effect.option(fs.readLink(current)))) {
            return yield* new ToolFailure({
              message: `${input} goes through a symlink whose target doesn't exist`,
            });
          }
          const parent = path.dirname(current);
          if (parent === current) return path.join(current, ...tail.reverse());
          tail.push(path.basename(current));
          current = parent;
        }
      });

    const outside = (input: string) =>
      new ToolFailure({ message: `${input} is outside the workspace (${root})` });

    const resolve = (input: string) =>
      Effect.flatMap(realPathOf(input), (real) =>
        isWithin(path, root, real) ? Effect.succeed(real) : Effect.fail(outside(input)),
      );

    return {
      root,
      resolve,
      resolveReadable: (input) =>
        Effect.gen(function* () {
          const real = yield* realPathOf(input);
          const extra = yield* Ref.get(readRoots);
          if ([root, ...extra].some((dir) => isWithin(path, dir, real))) return real;
          return yield* outside(input);
        }),
      addReadRoot: (dir) =>
        Effect.flatMap(realPathOf(dir), (real) =>
          Ref.update(readRoots, (roots) => (roots.includes(real) ? roots : [...roots, real])),
        ),
      display: (resolved) =>
        isWithin(path, root, resolved) ? path.relative(root, resolved) || "." : resolved,
      isSecretPath: (input) => {
        const name = path.basename(input);
        return (
          name.startsWith(".env") ||
          name.endsWith(".pem") ||
          name.endsWith(".key") ||
          name.startsWith("id_")
        );
      },
    } satisfies WorkspaceShape;
  });

export class Workspace extends Context.Service<Workspace, WorkspaceShape>()("orx/Workspace") {
  /** A workspace at `root`, which must already be realpathed (`Workspace.resolveRoot`). */
  static readonly layer = (root: string) => Layer.effect(Workspace, makeWorkspace(root));

  /** A workspace at `root` (realpathed here, without the $HOME and / check), for tests. */
  static readonly layerTest = (root: string) =>
    Layer.effect(
      Workspace,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* makeWorkspace(yield* Effect.orDie(fs.realPath(root)));
      }),
    );

  /**
   * The agent's root: `dir` (the cwd when undefined), realpathed. A missing directory is
   * BadInput, and so is $HOME or `/` unless the user named it explicitly (`--cwd`), since the
   * agent would then read and run commands across everything the user owns.
   */
  static readonly resolveRoot = (dir: string | undefined, explicit: boolean) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home } = yield* Paths;
      const target = path.resolve(dir ?? ".");
      const root = yield* fs
        .realPath(target)
        .pipe(
          Effect.mapError(() => new BadInput({ message: `No such directory: ${dir ?? target}` })),
        );
      const info = yield* fs
        .stat(root)
        .pipe(Effect.mapError(() => new BadInput({ message: `Can't read ${root}` })));
      if (info.type !== "Directory") {
        return yield* new BadInput({ message: `Not a directory: ${dir ?? target}` });
      }
      if (explicit) return root;
      const realHome = yield* Option.match(home, {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: (h) => Effect.option(fs.realPath(h)),
      });
      if (root === path.parse(root).root || Option.contains(realHome, root)) {
        return yield* new BadInput({
          message: `Refusing to use ${root} as the workspace: it holds everything you own. Start orx in a project directory, or pass --cwd ${root} to use it anyway.`,
        });
      }
      return root;
    });
}
