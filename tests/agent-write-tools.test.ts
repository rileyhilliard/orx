import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber, Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentShellEnv } from "~/config";
import { FileState } from "~/services/file-state";
import { type PermissionMode, Permissions } from "~/services/permissions";
import { Workspace } from "~/services/workspace";
import { makeOutputBuffer, runBash } from "~/tools/bash";
import { editFile, replaceIn, stripLineNumbers } from "~/tools/edit";
import { readFile } from "~/tools/read";
import { writeFile } from "~/tools/write";
import { ndjson, runCli } from "./helpers/cli";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "orx-write-tools-")));

type Services = Workspace | FileState | Permissions | NodeServices.NodeServices;

const layerFor = (root: string, mode: PermissionMode) =>
  Layer.mergeAll(Workspace.layerTest(root), FileState.layer, Permissions.layerHeadless(mode)).pipe(
    Layer.provideMerge(NodeServices.layer),
  );

/** Runs `effect` in a workspace at `root` (acceptEdits unless given); a tool failure comes back as `{ failure }`. */
const run = <A, E extends { message: string }>(
  root: string,
  effect: Effect.Effect<A, E, Services>,
  mode: PermissionMode = "acceptEdits",
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map((value) => ({ value }) as { value: A; failure?: undefined }),
      Effect.catch((error) =>
        Effect.succeed({ failure: error.message } as { value?: undefined; failure: string }),
      ),
      Effect.provide(layerFor(root, mode)),
    ),
  );

/** Writes `content` to `name` in a new workspace; returns the root. */
const fileIn = (name: string, content: string) => {
  const root = tempDir();
  writeFileSync(join(root, name), content);
  return root;
};

/**
 * Runs `effect` in a workspace at `root` with an interactive Permissions: at the first approval
 * request, runs `meanwhile` (the user changing things while the panel is open), then says yes.
 */
const approveAfter = <A, E extends { message: string }>(
  root: string,
  effect: Effect.Effect<A, E, Services>,
  meanwhile: () => void,
) =>
  run(
    root,
    Effect.gen(function* () {
      const permissions = yield* Permissions;
      const fiber = yield* Effect.forkChild(effect);
      const [event] = yield* Stream.runCollect(Stream.take(permissions.events, 1));
      if (event?.type !== "approval-request") throw new Error("expected an approval request");
      meanwhile();
      yield* permissions.answer(event.id, "yes");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Permissions.layer("default"))),
  );

const readAndEdit = (input: Parameters<typeof editFile>[0]) =>
  Effect.flatMap(readFile({ path: input.path }), () => editFile(input));

describe("edit", () => {
  it("replaces a unique exact match, returns the diff, and keeps FileState fresh", async () => {
    const root = fileIn("a.ts", "const a = 1;\nconst b = 2;\n");
    const result = await run(
      root,
      Effect.gen(function* () {
        const diff = yield* readAndEdit({
          path: "a.ts",
          old_string: "const b = 2;",
          new_string: "const b = 3;",
        });
        // A second edit works without a re-read: the first one recorded what it wrote.
        yield* editFile({ path: "a.ts", old_string: "const a = 1;", new_string: "const a = 0;" });
        return diff;
      }),
    );
    expect(result.value).toContain("--- a.ts\n+++ a.ts\n@@ -1,2 +1,2 @@");
    expect(result.value).toContain("-const b = 2;\n+const b = 3;");
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("const a = 0;\nconst b = 3;\n");
  });

  it("strips the line-number prefixes read shows from a pasted old_string", async () => {
    const root = fileIn("a.ts", "one\ntwo\nthree\n");
    const result = await run(
      root,
      readAndEdit({ path: "a.ts", old_string: "     2\ttwo\n     3\tthree", new_string: "2\n3" }),
    );
    expect(result.failure).toBeUndefined();
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("one\n2\n3\n");
  });

  it("matches a CRLF file with LF old_string and writes CRLF back", async () => {
    const root = fileIn("win.txt", "alpha\r\nbeta\r\ngamma\r\n");
    await run(
      root,
      readAndEdit({ path: "win.txt", old_string: "beta\ngamma", new_string: "B\nG" }),
    );
    expect(readFileSync(join(root, "win.txt"), "utf8")).toBe("alpha\r\nB\r\nG\r\n");
  });

  it("leaves a mixed-line-ending file's other lines alone, so the write is the approved diff", async () => {
    const root = fileIn("mixed.txt", "alpha\r\nbeta\ngamma\r\n");
    const result = await run(
      root,
      readAndEdit({ path: "mixed.txt", old_string: "beta", new_string: "B" }),
    );
    expect(result.failure).toBeUndefined();
    expect(readFileSync(join(root, "mixed.txt"), "utf8")).toBe("alpha\r\nB\ngamma\r\n");
  });

  it("keeps a byte order mark, and refuses a file that isn't UTF-8", async () => {
    const root = fileIn("bom.txt", "\uFEFFhello\n");
    writeFileSync(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const bom = await run(
      root,
      readAndEdit({ path: "bom.txt", old_string: "hello", new_string: "hi" }),
    );
    expect(bom.failure).toBeUndefined();
    expect([...readFileSync(join(root, "bom.txt"))]).toEqual([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]);
    const latin1 = await run(
      root,
      readAndEdit({ path: "latin1.txt", old_string: "caf", new_string: "tea" }),
    );
    expect(latin1.failure).toContain("latin1.txt: not UTF-8 text");
    expect([...readFileSync(join(root, "latin1.txt"))]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  });

  it("refuses to write through a symlink swapped in while the approval was open", async () => {
    const outside = tempDir();
    writeFileSync(join(outside, "a.txt"), "hello\n");
    const root = fileIn("a.txt", "hello\n");
    const result = await approveAfter(
      root,
      readAndEdit({ path: "a.txt", old_string: "hello", new_string: "hi" }),
      () => {
        renameSync(join(root, "a.txt"), join(root, "moved.txt"));
        symlinkSync(join(outside, "a.txt"), join(root, "a.txt"));
      },
    );
    expect(result.failure).toContain("outside the workspace");
    expect(readFileSync(join(outside, "a.txt"), "utf8")).toBe("hello\n");
  });

  it("falls back to indentation-insensitive matching and re-indents new_string", async () => {
    const root = fileIn("f.py", "def f():\n    if x:\n        return 1  \n    return 2\n");
    const result = await run(
      root,
      readAndEdit({
        path: "f.py",
        old_string: "if x:\n    return 1",
        new_string: "if x:\n    y = 1\n    return y",
      }),
    );
    expect(result.failure).toBeUndefined();
    expect(readFileSync(join(root, "f.py"), "utf8")).toBe(
      "def f():\n    if x:\n        y = 1\n        return y\n    return 2\n",
    );
  });

  it("fails with the count for an ambiguous match, unless replace_all", async () => {
    const root = fileIn("a.txt", "x = 1\nx = 1\n");
    const ambiguous = await run(
      root,
      readAndEdit({ path: "a.txt", old_string: "x = 1", new_string: "x = 2" }),
    );
    expect(ambiguous.failure).toBe(
      "a.txt: old_string matches 2 places; add surrounding lines to make it unique, or set replace_all",
    );
    await run(
      root,
      readAndEdit({ path: "a.txt", old_string: "x = 1", new_string: "x = 2", replace_all: true }),
    );
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("x = 2\nx = 2\n");
  });

  it("fails with 0 matches for text that isn't there", async () => {
    const root = fileIn("a.txt", "hello\n");
    const result = await run(
      root,
      readAndEdit({ path: "a.txt", old_string: "goodbye", new_string: "x" }),
    );
    expect(result.failure).toContain("old_string not found (0 matches");
  });

  it("refuses a file that wasn't read, or changed since it was read", async () => {
    const root = fileIn("a.txt", "hello\n");
    const notRead = await run(
      root,
      editFile({ path: "a.txt", old_string: "hello", new_string: "hi" }),
    );
    expect(notRead.failure).toContain("a.txt: read it first");

    const stale = await run(
      root,
      Effect.gen(function* () {
        yield* readFile({ path: "a.txt" });
        yield* Effect.sync(() => writeFileSync(join(root, "a.txt"), "hello there\n"));
        return yield* editFile({ path: "a.txt", old_string: "hello", new_string: "hi" });
      }),
    );
    expect(stale.failure).toContain("a.txt changed since you read it");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello there\n");
  });

  it("is denied in plan mode and asks (denied headless) in default mode", async () => {
    const root = fileIn("a.txt", "hello\n");
    const input = { path: "a.txt", old_string: "hello", new_string: "hi" };
    expect((await run(root, readAndEdit(input), "plan")).failure).toBe(
      "Edit a.txt: denied. plan mode: describe the change instead",
    );
    expect((await run(root, readAndEdit(input), "default")).failure).toContain(
      "edit needs an interactive session",
    );
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello\n");
  });

  it("puts the diff in the approval request and writes only after yes", async () => {
    const root = fileIn("a.txt", "hello\n");
    const layer = Layer.mergeAll(
      Workspace.layerTest(root),
      FileState.layer,
      Permissions.layer("default"),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const permissions = yield* Permissions;
        yield* readFile({ path: "a.txt" });
        const fiber = yield* Effect.forkChild(
          editFile({ path: "a.txt", old_string: "hello", new_string: "hi" }),
        );
        const [event] = yield* Stream.runCollect(Stream.take(permissions.events, 1));
        const before = readFileSync(join(root, "a.txt"), "utf8");
        if (event?.type === "approval-request") yield* permissions.answer(event.id, "yes");
        return { event, before, result: yield* Fiber.join(fiber) };
      }).pipe(Effect.provide(layer)),
    );
    expect(outcome.event).toMatchObject({ tool: "edit", summary: "Edit a.txt" });
    expect(outcome.event?.type === "approval-request" && outcome.event.diff).toContain("+hi");
    expect(outcome.before).toBe("hello\n");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hi\n");
  });
});

describe("edit helpers", () => {
  it("strips line numbers only when every non-empty line has one", () => {
    expect(stripLineNumbers("    12\tfoo\n    13\tbar")).toBe("foo\nbar");
    expect(stripLineNumbers("    12\tfoo\nbar")).toBe("    12\tfoo\nbar");
  });

  it("counts fallback matches too", () => {
    expect(replaceIn("  a\n  b\n    a\n    b\n", "a\nb", "c", false)).toEqual({
      ok: false,
      message: expect.stringContaining("matches 2 places (ignoring indentation)"),
    });
  });
});

describe("write", () => {
  it("creates a new file and its parent directories", async () => {
    const root = tempDir();
    const result = await run(root, writeFile({ path: "src/deep/new.ts", content: "a\nb\n" }));
    expect(result.value).toBe("Created src/deep/new.ts (2 lines)");
    expect(readFileSync(join(root, "src/deep/new.ts"), "utf8")).toBe("a\nb\n");
  });

  it("overwrites a file that was read and hasn't changed", async () => {
    const root = fileIn("a.txt", "old\n");
    const result = await run(
      root,
      Effect.flatMap(readFile({ path: "a.txt" }), () =>
        writeFile({ path: "a.txt", content: "new\n" }),
      ),
    );
    expect(result.value).toBe("Overwrote a.txt (1 lines)");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new\n");
  });

  it("refuses to overwrite a file that wasn't read or went stale", async () => {
    const root = fileIn("a.txt", "old\n");
    expect((await run(root, writeFile({ path: "a.txt", content: "x" }))).failure).toContain(
      "read it first",
    );
    const stale = await run(
      root,
      Effect.gen(function* () {
        yield* readFile({ path: "a.txt" });
        yield* Effect.sync(() => writeFileSync(join(root, "a.txt"), "changed\n"));
        return yield* writeFile({ path: "a.txt", content: "x" });
      }),
    );
    expect(stale.failure).toContain("changed since you read it");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("changed\n");
  });

  it("keeps an existing file's byte order mark, and refuses one that isn't UTF-8", async () => {
    const root = fileIn("bom.txt", "\uFEFFold\n");
    writeFileSync(join(root, "latin1.txt"), Buffer.from([0xe9, 0x0a]));
    const overwrite = (path: string) =>
      run(
        root,
        Effect.flatMap(readFile({ path }), () => writeFile({ path, content: "new\n" })),
      );
    expect((await overwrite("bom.txt")).failure).toBeUndefined();
    expect(readFileSync(join(root, "bom.txt"), "utf8")).toBe("\uFEFFnew\n");
    expect((await overwrite("latin1.txt")).failure).toContain("latin1.txt: not UTF-8 text");
    expect([...readFileSync(join(root, "latin1.txt"))]).toEqual([0xe9, 0x0a]);
  });

  it("refuses to create a file that appeared while the approval was open", async () => {
    const root = tempDir();
    const result = await approveAfter(root, writeFile({ path: "new.txt", content: "mine\n" }), () =>
      writeFileSync(join(root, "new.txt"), "theirs\n"),
    );
    expect(result.failure).toContain("new.txt: was created since you started");
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("theirs\n");
  });

  it("refuses to write through a symlink swapped in while the approval was open", async () => {
    const outside = tempDir();
    const root = tempDir();
    const result = await approveAfter(root, writeFile({ path: "new.txt", content: "x\n" }), () =>
      symlinkSync(join(outside, "new.txt"), join(root, "new.txt")),
    );
    expect(result.failure).toContain("new.txt");
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
  });

  it("stays inside the workspace", async () => {
    const root = tempDir();
    expect((await run(root, writeFile({ path: "../x.txt", content: "x" }))).failure).toContain(
      "outside the workspace",
    );
  });
});

describe("bash", () => {
  it("runs in the workspace root and reports the exit code", async () => {
    const root = tempDir();
    const result = await run(root, runBash({ command: "pwd; echo oops >&2; exit 3" }), "yolo");
    expect(result.value).toBe(`${root}\noops\n(exit code 3)`);
  });

  it("keeps the head and tail of long output", async () => {
    const root = tempDir();
    const result = await run(
      root,
      runBash({ command: "echo START; head -c 100000 /dev/zero | tr '\\0' x; echo; echo END" }),
      "yolo",
    );
    const text = result.value ?? "";
    expect(text.startsWith("START\n")).toBe(true);
    expect(text).toMatch(/\[\.\.\. \d+ characters cut \.\.\.\]/);
    expect(text.endsWith("END\n(exit code 0)")).toBe(true);
    expect(text.length).toBeLessThan(31_000);
  });

  it("kills a command that runs past its timeout", async () => {
    const root = tempDir();
    const started = Date.now();
    const result = await run(
      root,
      runBash({ command: "echo before; sleep 30", timeout_ms: 300 }),
      "yolo",
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.failure).toBe("before\n(timed out after 0.3 s; the command was killed)");
  });

  it("runs with orx's secrets removed and git and pagers made non-interactive", async () => {
    const env = agentShellEnv({
      PATH: "/usr/bin",
      OPENROUTER_API_KEY: "sk-or-secret",
      ORX_DATA_DIR: "/data",
      HOME: "/home/me",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      GIT_EDITOR: "true",
      GIT_TERMINAL_PROMPT: "0",
      PAGER: "cat",
    });

    process.env.OPENROUTER_API_KEY = "sk-or-leak-test";
    try {
      const root = tempDir();
      const result = await run(
        root,
        runBash({ command: 'echo "key=$OPENROUTER_API_KEY pager=$PAGER"' }),
        "yolo",
      );
      expect(result.value).toBe("key= pager=cat\n(exit code 0)");
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("asks before running, so headless default mode denies it", async () => {
    const root = tempDir();
    const result = await run(root, runBash({ command: "touch made" }), "default");
    expect(result.failure).toContain("bash needs an interactive session");
  });

  it("buffers output as head and tail", () => {
    const buffer = makeOutputBuffer(10);
    for (const chunk of ["abc", "defgh", "ijklmnop", "qrst"]) buffer.add(chunk);
    expect(buffer.text()).toBe("abcde\n[... 10 characters cut ...]\npqrst");
  });
});

describe("parallel edits in one step", () => {
  let stub: StubOpenRouter;
  beforeAll(async () => {
    stub = await startStubOpenRouter();
  });
  afterAll(() => stub.close());

  it("applies two edits to one file from a single response, one after the other", async () => {
    const root = fileIn("math.js", "export const add = (a, b) => a + b;\nexport const one = 1;\n");
    const edit = (old_string: string, new_string: string) => ({
      name: "edit",
      arguments: JSON.stringify({ path: "math.js", old_string, new_string }),
    });
    stub.steps = [
      { toolCalls: [{ name: "read", arguments: JSON.stringify({ path: "math.js" }) }] },
      {
        text: "Editing both lines.",
        toolCalls: [edit("a + b", "a + b + 0"), edit("one = 1", "one = 2")],
      },
      { text: "Done." },
    ];
    const run = await runCli(
      ["ask", "fix it", "--agent", "--cwd", root, "--permission-mode", "acceptEdits", "--json"],
      { env: { OPENROUTER_BASE_URL: stub.baseUrl } },
    );
    expect(run.exitCode).toBe(0);
    // Without the lock, the second edit would see the file changed under it (stale) or write
    // over the first one's change.
    expect(readFileSync(join(root, "math.js"), "utf8")).toBe(
      "export const add = (a, b) => a + b + 0;\nexport const one = 2;\n",
    );
    const events = ndjson(run.stdout);
    const results = events.filter((e) => e.type === "tool-result");
    expect(results.map((r) => [r.name, r.isFailure])).toEqual([
      ["read", false],
      ["edit", false],
      ["edit", false],
    ]);
    // The step's text and both calls came from one request; the next request answers both ids.
    expect(stub.chatRequests).toHaveLength(3);
    const third = stub.chatRequests[2] as {
      messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
    };
    const answered = third.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    // The step's calls run concurrently and their results arrive in completion order, so which
    // edit took the file's lock first varies.
    expect(answered.sort()).toEqual(["call_stub_1", "call_stub_2", "call_stub_2_1"]);
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.delta)
        .join(""),
    ).toBe("Editing both lines.Done.");
  });
});
