import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { GrepInput } from "~/schemas";
import { FileState } from "~/services/file-state";
import { Permissions } from "~/services/permissions";
import { Workspace } from "~/services/workspace";
import { AgentTools, AgentToolsLive } from "~/tools/agent";
import { globFiles } from "~/tools/glob";
import { grepFiles, hasRipgrep } from "~/tools/grep";
import { GLOB_MAX_RESULTS } from "~/tools/limits";
import { readFile } from "~/tools/read";

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "orx-tools-")));

const layerFor = (root: string) =>
  Layer.mergeAll(
    Workspace.layerTest(root),
    FileState.layer,
    Permissions.layerHeadless("default"),
  ).pipe(Layer.provideMerge(NodeServices.layer));

/** Runs `effect` against a workspace at `root`; a tool failure comes back as `{ failure }`. */
const run = <A, E extends { message: string }>(
  root: string,
  effect: Effect.Effect<A, E, Workspace | FileState | Permissions | NodeServices.NodeServices>,
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

  it("refuses a directory outside the workspace", async () => {
    const root = tempDir();
    expect((await run(root, globFiles({ pattern: "*", path: "/" }))).failure).toContain(
      "outside the workspace",
    );
  });
});

const rgInstalled = await Effect.runPromise(hasRipgrep.pipe(Effect.provide(NodeServices.layer)));

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

  it("offers the file tools, bash, and currentTime", () => {
    expect(Object.keys(AgentTools.tools).sort()).toEqual([
      "bash",
      "currentTime",
      "edit",
      "glob",
      "grep",
      "read",
      "write",
    ]);
  });
});
