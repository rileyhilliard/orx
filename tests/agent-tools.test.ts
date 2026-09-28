import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger, Stream } from "effect";
import type { GrepInput } from "~/schemas";
import { FileState } from "~/services/file-state";
import { Permissions } from "~/services/permissions";
import { Workspace } from "~/services/workspace";
import { AgentTools, AgentToolsLive } from "~/tools/agent";
import { globFiles } from "~/tools/glob";
import { grepFiles, hasRipgrep } from "~/tools/grep";
import { GLOB_MAX_RESULTS, READ_MAX_FILE_BYTES } from "~/tools/limits";
import { readFile } from "~/tools/read";
import { restoreEnv, stubEnv } from "./helpers/env";

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "orx-tools-")));

const layerFor = (root: string) =>
  Layer.mergeAll(
    Workspace.layerTest(root),
    FileState.layer,
    Permissions.layerHeadless("default"),
  ).pipe(Layer.provideMerge(BunServices.layer));

/** Runs `effect` against a workspace at `root`; a tool failure comes back as `{ failure }`. */
const run = <A, E extends { message: string }>(
  root: string,
  effect: Effect.Effect<A, E, Workspace | FileState | Permissions | BunServices.BunServices>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map((value) => ({ value }) as { value: A; failure?: undefined }),
      Effect.catch((error) =>
        Effect.succeed({ failure: error.message } as { value?: undefined; failure: string }),
      ),
      Effect.provide(layerFor(root)),
    ),
  );

const lines = (n: number, make = (i: number) => `line ${i}`) =>
  `${Array.from({ length: n }, (_, i) => make(i + 1)).join("\n")}\n`;

describe("read", () => {
  it("numbers lines cat -n style and records the file in FileState", async () => {
    const root = tempDir();
    writeFileSync(join(root, "a.txt"), "alpha\r\nbeta\n");
    const result = await run(
      root,
      Effect.gen(function* () {
        const text = yield* readFile({ path: "a.txt" });
        const fresh = yield* (yield* FileState).checkFresh(join(root, "a.txt"));
        return { text, fresh };
      }),
    );
    expect(result.value).toEqual({ text: "     1\talpha\n     2\tbeta", fresh: "ok" });
  });

  it("stops at 2000 lines with a note, and pages with offset and limit", async () => {
    const root = tempDir();
    writeFileSync(join(root, "big.txt"), lines(2500));
    const first = await run(root, readFile({ path: "big.txt" }));
    const body = first.value?.split("\n") ?? [];
    expect(body).toHaveLength(2001);
    expect(body[1999]).toBe("  2000\tline 2000");
    expect(body[2000]).toBe("(showing lines 1-2000 of 2500; pass offset 2001 to read more)");

    const page = await run(root, readFile({ path: "big.txt", offset: 2499, limit: 10 }));
    expect(page.value).toBe("  2499\tline 2499\n  2500\tline 2500");
  });

  it("cuts lines over 2000 characters", async () => {
    const root = tempDir();
    writeFileSync(join(root, "wide.txt"), `${"x".repeat(2500)}\nshort\n`);
    const result = await run(root, readFile({ path: "wide.txt" }));
    const [wide, short] = result.value?.split("\n") ?? [];
    expect(wide).toBe(`     1\t${"x".repeat(2000)} [line cut at 2000 characters]`);
    expect(short).toBe("     2\tshort");
  });

  it("notes an empty file, a binary file, and an offset past the end", async () => {
    const root = tempDir();
    writeFileSync(join(root, "empty.txt"), "");
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    writeFileSync(join(root, "short.txt"), lines(3));
    expect((await run(root, readFile({ path: "empty.txt" }))).value).toBe("(empty.txt is empty)");
    expect((await run(root, readFile({ path: "bin.dat" }))).value).toBe(
      "(bin.dat is a binary file, 4 bytes; not shown)",
    );
    expect((await run(root, readFile({ path: "short.txt", offset: 10 }))).value).toBe(
      "(offset 10 is past the end of short.txt, which has 3 lines)",
    );
  });

  it("refuses a file over the size cap instead of loading it", async () => {
    const root = tempDir();
    writeFileSync(join(root, "huge.log"), "");
    truncateSync(join(root, "huge.log"), READ_MAX_FILE_BYTES + 1);
    expect((await run(root, readFile({ path: "huge.log" }))).failure).toMatch(
      /^huge\.log: is \d+ bytes, more than read takes .*use grep/,
    );
  });

  it("says why a file can't be read and whether retrying can help", async () => {
    const root = tempDir();
    writeFileSync(join(root, "locked.txt"), "x\n");
    chmodSync(join(root, "locked.txt"), 0o000);
    try {
      expect((await run(root, readFile({ path: "locked.txt" }))).failure).toBe(
        "locked.txt: PermissionDenied; the user running orx can't access it, so retrying won't help",
      );
    } finally {
      chmodSync(join(root, "locked.txt"), 0o644);
    }
  });

  it("fails for a missing file, a directory, a secret-shaped path, and a path outside", async () => {
    const root = tempDir();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".env"), "OPENROUTER_API_KEY=sk-x\n");
    const failures = await Promise.all(
      ["nope.txt", "src", ".env", "../outside.txt"].map(
        async (path) => (await run(root, readFile({ path }))).failure,
      ),
    );
    expect(failures[0]).toBe("nope.txt: no such file");
    expect(failures[1]).toContain("is a directory");
    // A secret-shaped path asks; with no one to ask, that's a denial.
    expect(failures[2]).toContain("Read .env: denied. read needs an interactive session");
    expect(failures[3]).toContain("outside the workspace");
  });
});

describe("glob", () => {
  it("skips .git and .gitignored paths, including nested .gitignore files", async () => {
    const root = tempDir();
    for (const dir of [".git", "node_modules/pkg", "src/gen", ".github"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\n");
    writeFileSync(join(root, "src", ".gitignore"), "gen/\n");
    for (const file of [
      ".git/config",
      "node_modules/pkg/index.js",
      "src/gen/out.js",
      "src/app.js",
      "debug.log",
      ".github/ci.js",
      "top.js",
    ]) {
      writeFileSync(join(root, file), "x");
    }
    const all = await run(root, globFiles({ pattern: "**/*" }));
    expect(all.value?.split("\n").sort()).toEqual([
      ".github/ci.js",
      ".gitignore",
      "src/.gitignore",
      "src/app.js",
      "top.js",
    ]);
    // Searching a subdirectory still applies the root's .gitignore.
    expect((await run(root, globFiles({ pattern: "*.js", path: "src" }))).value).toBe("src/app.js");
    expect((await run(root, globFiles({ pattern: "**/*.rs" }))).value).toBe(
      "No files match **/*.rs",
    );
  });

  it("sorts newest first and caps the list with a note", async () => {
    const root = tempDir();
    const total = GLOB_MAX_RESULTS + 5;
    for (let i = 0; i < total; i++) {
      const file = join(root, `f${i}.ts`);
      writeFileSync(file, "x");
      const time = new Date(2020, 0, 1, 0, 0, i);
      utimesSync(file, time, time);
    }
    const result = (await run(root, globFiles({ pattern: "*.ts" }))).value?.split("\n") ?? [];
    expect(result).toHaveLength(GLOB_MAX_RESULTS + 1);
    expect(result[0]).toBe(`f${total - 1}.ts`);
    expect(result.at(-1)).toBe(
      `(showing ${GLOB_MAX_RESULTS} of ${total} matches; narrow the pattern or path)`,
    );
  });

  it("fails with a message, not a defect, for a pattern picomatch rejects", async () => {
    const root = tempDir();
    expect((await run(root, globFiles({ pattern: "" }))).failure).toMatch(/^invalid glob: /);
    expect((await run(root, grepFiles({ pattern: "x", glob: "" }, false))).failure).toMatch(
      /^invalid glob: /,
    );
  });

  it("refuses a directory outside the workspace", async () => {
    const root = tempDir();
    expect((await run(root, globFiles({ pattern: "*", path: "/" }))).failure).toContain(
      "outside the workspace",
    );
  });

  it("skips a file symlink that leads outside the workspace", async () => {
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "x");
    const root = tempDir();
    writeFileSync(join(root, "a.txt"), "x");
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
    symlinkSync("a.txt", join(root, "alias.txt"));
    const all = await run(root, globFiles({ pattern: "*.txt" }));
    expect(all.value?.split("\n").sort()).toEqual(["a.txt", "alias.txt"]);
  });
});

const rgInstalled = await Effect.runPromise(hasRipgrep.pipe(Effect.provide(BunServices.layer)));
// Locally the rg tests skip without rg; in CI (ci.yml and release.yml install it) a missing rg fails,
// or the rg path of grep would go untested without anyone noticing.
if (process.env.CI && !rgInstalled) {
  throw new Error("ripgrep (rg) isn't on PATH; CI must install it to test grep's rg path");
}

const grepFixture = () => {
  const root = tempDir();
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "ignored"));
  writeFileSync(join(root, ".gitignore"), "ignored/\n");
  writeFileSync(join(root, "src", "a.ts"), "const needle = 1;\nconst other = 2;\nneedle();\n");
  writeFileSync(join(root, "src", "b.md"), "a needle in docs\n");
  writeFileSync(join(root, "ignored", "c.ts"), "needle\n");
  writeFileSync(
    join(root, "src", "bin.dat"),
    Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]),
  );
  const old = new Date(2020, 0, 1);
  utimesSync(join(root, "src", "b.md"), old, old);
  return root;
};

describe.each([
  { name: "rg", useRipgrep: true },
  { name: "the JS fallback", useRipgrep: false },
])("grep with $name", ({ useRipgrep }) => {
  const skip = useRipgrep && !rgInstalled;
  const grep = (root: string, input: GrepInput) => run(root, grepFiles(input, useRipgrep));

  it.skipIf(skip)(
    "lists matching files newest first by default, skipping ignored ones",
    async () => {
      const root = grepFixture();
      expect((await grep(root, { pattern: "needle" })).value).toBe("src/a.ts\nsrc/b.md");
    },
  );

  it.skipIf(skip)("shows matching lines in content mode and counts in count mode", async () => {
    const root = grepFixture();
    expect(
      (await grep(root, { pattern: "needle", output_mode: "content", glob: "*.ts" })).value,
    ).toBe("src/a.ts:1:const needle = 1;\nsrc/a.ts:3:needle();");
    expect((await grep(root, { pattern: "needle", output_mode: "count" })).value).toBe(
      "src/a.ts:2\nsrc/b.md:1",
    );
  });

  it.skipIf(skip)("caps results at head_limit with a note", async () => {
    const root = grepFixture();
    const content = await grep(root, { pattern: "needle", output_mode: "content", head_limit: 1 });
    expect(content.value).toBe(
      "src/a.ts:1:const needle = 1;\n(showing the first 1 matching lines; narrow the search or raise head_limit)",
    );
    const files = await grep(root, { pattern: "needle", head_limit: 1 });
    expect(files.value).toBe(
      "src/a.ts\n(showing 1 of 2 files; narrow the search or raise head_limit)",
    );
  });

  it.skipIf(skip)("doesn't search secret-shaped files, and says how many it skipped", async () => {
    const root = grepFixture();
    mkdirSync(join(root, "keys"));
    writeFileSync(join(root, ".env"), "needle=hunter2\n");
    writeFileSync(join(root, ".env.local"), "needle=hunter2\n");
    writeFileSync(join(root, "keys", "server.pem"), "needle\n");
    writeFileSync(join(root, "keys", "api.key"), "needle\n");
    writeFileSync(join(root, "keys", "id_ed25519"), "needle\n");
    const note = (n: number) =>
      `(${n} secret-shaped ${n === 1 ? "file" : "files"} (.env*, *.pem, *.key, id_*) not searched; read one by path if you need it)`;

    const files = await grep(root, { pattern: "needle" });
    expect(files.value).toBe(`src/a.ts\nsrc/b.md\n${note(5)}`);
    const content = await grep(root, { pattern: "hunter2", output_mode: "content" });
    expect(content.value).toBe(`No matches for hunter2\n${note(5)}`);
    // A glob narrows what's counted; the exclusions still win over it.
    expect((await grep(root, { pattern: "needle", glob: "*.pem" })).value).toBe(
      `No matches for needle\n${note(1)}`,
    );
    // Named directly, a secret file is still not searched.
    expect((await grep(root, { pattern: "needle", path: ".env" })).value).toBe(
      `No matches for needle\n${note(1)}`,
    );
    // No secret files in scope, no note.
    expect((await grep(root, { pattern: "needle", path: "src" })).value).toBe("src/a.ts\nsrc/b.md");
  });

  it.skipIf(skip)(
    "doesn't follow a file symlink outside the workspace or into a secret",
    async () => {
      const outside = tempDir();
      writeFileSync(join(outside, "leak.txt"), "needle outside\n");
      const root = tempDir();
      writeFileSync(join(root, "a.txt"), "needle\n");
      writeFileSync(join(root, ".env"), "needle=hunter2\n");
      symlinkSync(join(outside, "leak.txt"), join(root, "escape.txt"));
      symlinkSync(".env", join(root, "notes.txt"));
      const content = await grep(root, { pattern: "needle", output_mode: "content" });
      expect(content.value).not.toContain("outside");
      expect(content.value).not.toContain("hunter2");
      expect(content.value?.split("\n")[0]).toBe("a.txt:1:needle");
    },
  );

  it.skipIf(skip)("searches one file, reports no matches, and fails on a bad regex", async () => {
    const root = grepFixture();
    expect((await grep(root, { pattern: "needle", path: "src/b.md" })).value).toBe("src/b.md");
    expect((await grep(root, { pattern: "haystack" })).value).toBe("No matches for haystack");
    expect((await grep(root, { pattern: "(unclosed" })).failure).toMatch(/^grep failed: /);
    expect((await grep(root, { pattern: "x", path: "../" })).failure).toContain(
      "outside the workspace",
    );
  });
});

describe("grep with rg", () => {
  afterEach(() => {
    restoreEnv();
  });

  it.skipIf(!rgInstalled)("keeps its matches and says which files it couldn't search", async () => {
    const root = tempDir();
    writeFileSync(join(root, "a.txt"), "needle\n");
    writeFileSync(join(root, "locked.txt"), "needle\n");
    chmodSync(join(root, "locked.txt"), 0o000);
    try {
      const result = await run(root, grepFiles({ pattern: "needle" }, true));
      expect(result.value).toMatch(
        /^a\.txt\n\(some files couldn't be searched: .*locked\.txt.*[Pp]ermission denied.*\)$/,
      );
    } finally {
      chmodSync(join(root, "locked.txt"), 0o644);
    }
  });

  it.skipIf(!rgInstalled)("ignores RIPGREP_CONFIG_PATH, which could turn on --follow", async () => {
    const outside = tempDir();
    writeFileSync(join(outside, "leak.txt"), "needle outside\n");
    writeFileSync(join(outside, "ripgreprc"), "--follow\n");
    const root = tempDir();
    writeFileSync(join(root, "a.txt"), "needle\n");
    symlinkSync(join(outside, "leak.txt"), join(root, "escape.txt"));
    stubEnv("RIPGREP_CONFIG_PATH", join(outside, "ripgreprc"));
    expect((await run(root, grepFiles({ pattern: "needle" }, true))).value).toBe("a.txt");
  });
});

describe("AgentTools", () => {
  it("returns a tool failure to the model instead of failing the turn", async () => {
    const root = tempDir();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const toolkit = yield* AgentTools;
        const ok = yield* Stream.runCollect(yield* toolkit.handle("read", { path: "a.txt" }));
        const bad = yield* Stream.runCollect(yield* toolkit.handle("read", { path: "/etc/hosts" }));
        // Models send null for a parameter they leave out; it counts as absent.
        const nulls = yield* Stream.runCollect(
          yield* toolkit.handle("read", { path: "a.txt", offset: null, limit: null }),
        );
        return [...ok, ...bad, ...nulls].map(({ isFailure, encodedResult }) => ({
          isFailure,
          encodedResult,
        }));
      }).pipe(Effect.provide(AgentToolsLive), Effect.provide(layerFor(root))),
    );
    expect(results).toEqual([
      { isFailure: false, encodedResult: "     1\thello" },
      {
        isFailure: true,
        encodedResult: {
          _tag: "ToolFailure",
          message: `/etc/hosts is outside the workspace (${root})`,
        },
      },
      { isFailure: false, encodedResult: "     1\thello" },
    ]);
  });

  const handleAll = (
    root: string,
    calls: ReadonlyArray<readonly [string, Record<string, unknown>]>,
    workspace: Layer.Layer<Workspace, never, BunServices.BunServices> = Workspace.layerTest(root),
  ) => {
    const logs: Array<{ level: string; message: unknown }> = [];
    const services = Layer.mergeAll(
      workspace,
      FileState.layer,
      Permissions.layerHeadless("default"),
    ).pipe(Layer.provideMerge(BunServices.layer));
    return Effect.runPromise(
      Effect.gen(function* () {
        const toolkit = yield* AgentTools;
        const results = [];
        for (const [name, params] of calls) {
          // The table names tools dynamically; the handler decodes the params either way.
          const stream = yield* toolkit.handle(name as "read", params as never);
          results.push(...(yield* Stream.runCollect(stream)));
        }
        return results.map(({ isFailure, encodedResult }) => ({ isFailure, encodedResult }));
      }).pipe(
        Effect.provide(AgentToolsLive),
        Effect.provide(services),
        Effect.provide(
          Logger.layer([
            Logger.make(({ logLevel, message }) => {
              logs.push({ level: logLevel, message });
            }),
          ]),
        ),
      ),
    ).then((results) => ({ results, logs }));
  };

  it("returns an empty glob or grep pattern to the model instead of failing the turn", async () => {
    const root = tempDir();
    const { results } = await handleAll(root, [
      ["glob", { pattern: "" }],
      ["grep", { pattern: "" }],
      ["grep", { pattern: "x", glob: "" }],
    ]);
    expect(results.map((r) => r.isFailure)).toEqual([true, true, true]);
    for (const { encodedResult } of results) {
      expect(JSON.stringify(encodedResult)).toMatch(/must not be empty/);
    }
  });

  it("logs a tool's defect once and returns a failure the model can act on", async () => {
    const root = tempDir();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const broken = Layer.effect(
      Workspace,
      Effect.map(Workspace, (workspace) => ({
        ...workspace,
        display: (): string => {
          throw new Error("boom");
        },
      })),
    ).pipe(Layer.provide(Workspace.layerTest(root)));
    const { results, logs } = await handleAll(root, [["read", { path: "a.txt" }]], broken);
    expect(results).toEqual([
      {
        isFailure: true,
        encodedResult: {
          _tag: "ToolFailure",
          message: "read failed unexpectedly; try a different approach",
        },
      },
    ]);
    const errors = logs.filter((log) => log.level === "Error");
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0]?.message)).toContain("read");
  });

  it("offers the file tools and bash", () => {
    expect(Object.keys(AgentTools.tools).sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "read",
      "write",
    ]);
  });
});
