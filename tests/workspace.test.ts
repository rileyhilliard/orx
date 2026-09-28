import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { Paths } from "~/config";
import { FileState } from "~/services/file-state";
import { Workspace } from "~/services/workspace";

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "orx-ws-")));

const run = <A, E>(root: string, effect: Effect.Effect<A, E, Workspace | FileState>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(Workspace.layerTest(root), FileState.layer).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

const resolve = (root: string, path: string) =>
  run(
    root,
    Effect.flatMap(Workspace, (ws) => Effect.result(ws.resolve(path))),
  );

describe("Workspace.resolve", () => {
  it("accepts root-relative and absolute paths inside the root, existing or not", async () => {
    const root = tempDir();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    for (const [input, expected] of [
      ["src/a.ts", join(root, "src", "a.ts")],
      [join(root, "src", "a.ts"), join(root, "src", "a.ts")],
      ["src/new/deep/file.ts", join(root, "src", "new", "deep", "file.ts")],
      [".", root],
      ["src/../src/a.ts", join(root, "src", "a.ts")],
    ] as const) {
      const result = await resolve(root, input);
      expect(result._tag === "Success" && result.success).toBe(expected);
    }
  });

  it("rejects .., outside absolute paths, and symlink escapes with a tool failure", async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "x");
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    symlinkSync(join(outside, "missing.txt"), join(root, "dangling.txt"));
    for (const input of [
      "..",
      "../x",
      join(outside, "secret.txt"),
      "/etc/passwd",
      "escape/secret.txt",
      "escape/new.txt",
      "link.txt",
      "dangling.txt",
    ]) {
      const result = await resolve(root, input);
      expect(result._tag, input).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure._tag).toBe("ToolFailure");
    }
  });

  it("allows a file named ..something at the root", async () => {
    const root = tempDir();
    const result = await resolve(root, "..notes");
    expect(result._tag).toBe("Success");
  });

  it("lets resolveReadable, and only it, reach an extra read root", async () => {
    const root = tempDir();
    const skills = tempDir();
    writeFileSync(join(skills, "ref.md"), "x");
    const [before, readable, writable] = await run(
      root,
      Effect.gen(function* () {
        const ws = yield* Workspace;
        const before = yield* Effect.result(ws.resolveReadable(join(skills, "ref.md")));
        yield* ws.addReadRoot(skills);
        return [
          before,
          yield* Effect.result(ws.resolveReadable(join(skills, "ref.md"))),
          yield* Effect.result(ws.resolve(join(skills, "ref.md"))),
        ] as const;
      }),
    );
    expect(before._tag).toBe("Failure");
    expect(readable._tag === "Success" && readable.success).toBe(join(skills, "ref.md"));
    expect(writable._tag).toBe("Failure");
  });

  it("flags secret-shaped paths", async () => {
    const root = tempDir();
    const secret = await run(
      root,
      Effect.map(Workspace, (ws) => ws.isSecretPath),
    );
    for (const path of [
      ".env",
      ".env.local",
      "certs/server.pem",
      "tls.key",
      "/home/u/.ssh/id_ed25519",
    ]) {
      expect(secret(path), path).toBe(true);
    }
    for (const path of ["src/env.ts", "keys.ts", "README.md", "environment/x.ts"]) {
      expect(secret(path), path).toBe(false);
    }
  });
});

describe("Workspace.resolveRoot", () => {
  const resolveRoot = (dir: string | undefined, explicit: boolean, home: string) =>
    Effect.runPromise(
      Effect.result(Workspace.resolveRoot(dir, explicit)).pipe(
        Effect.provide(
          Layer.succeed(Paths, {
            home: Option.some(home),
            configFile: join(home, ".config", "orx", "config.json"),
            dataDir: join(home, "data"),
            logFile: Option.none(),
          }),
        ),
        Effect.provide(NodeServices.layer),
      ),
    );

  it("realpaths a project directory", async () => {
    const home = tempDir();
    const project = join(home, "project");
    mkdirSync(project);
    symlinkSync(project, join(home, "alias"));
    const result = await resolveRoot(join(home, "alias"), false, home);
    expect(result._tag === "Success" && result.success).toBe(project);
  });

  it("refuses $HOME and / unless named explicitly", async () => {
    const home = tempDir();
    for (const dir of [home, "/"]) {
      const refused = await resolveRoot(dir, false, home);
      expect(refused._tag, dir).toBe("Failure");
      if (refused._tag === "Failure") {
        expect(refused.failure._tag).toBe("BadInput");
        expect(refused.failure.message).toContain("--cwd");
      }
      const allowed = await resolveRoot(dir, true, home);
      expect(allowed._tag, dir).toBe("Success");
    }
  });

  it("fails with BadInput for a missing directory or a file", async () => {
    const home = tempDir();
    writeFileSync(join(home, "file.txt"), "x");
    for (const dir of [join(home, "nope"), join(home, "file.txt")]) {
      const result = await resolveRoot(dir, true, home);
      expect(result._tag === "Failure" && result.failure._tag).toBe("BadInput");
    }
  });
});

describe("FileState", () => {
  it("reports not-read, ok, a touch without a change as ok, and a change as stale", async () => {
    const root = tempDir();
    const file = join(root, "a.txt");
    writeFileSync(file, "one");
    const states = await run(
      root,
      Effect.gen(function* () {
        const state = yield* FileState;
        const notRead = yield* state.checkFresh(file);
        yield* state.record(file, new TextEncoder().encode("one"));
        const fresh = yield* state.checkFresh(file);
        const future = new Date(Date.now() + 60_000);
        utimesSync(file, future, future);
        const touched = yield* state.checkFresh(file);
        writeFileSync(file, "two");
        const changed = yield* state.checkFresh(file);
        return { notRead, fresh, touched, changed, stamp: yield* state.get(file) };
      }),
    );
    expect(states).toMatchObject({
      notRead: "not-read",
      fresh: "ok",
      touched: "ok",
      changed: "stale",
    });
    expect(Option.getOrThrow(states.stamp).size).toBe(3);
  });

  it("starts empty on every build", async () => {
    const root = tempDir();
    const file = join(root, "a.txt");
    writeFileSync(file, "one");
    await run(
      root,
      Effect.flatMap(FileState, (state) => state.record(file, new TextEncoder().encode("one"))),
    );
    expect(
      await run(
        root,
        Effect.flatMap(FileState, (state) => state.checkFresh(file)),
      ),
    ).toBe("not-read");
  });
});
