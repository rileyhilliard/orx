import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { listWorkspaceFiles, mentionAttachments, mentionTokens } from "~/core/mentions";
import { FileState } from "~/services/file-state";
import { Permissions } from "~/services/permissions";
import { Workspace } from "~/services/workspace";
import { insertMention, opensMentionPicker, rankPaths } from "~/tui/mentions";

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "orx-mentions-")));

const run = <A, E>(
  root: string,
  effect: Effect.Effect<A, E, Workspace | FileState | Permissions | NodeServices.NodeServices>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Workspace.layerTest(root),
          FileState.layer,
          Permissions.layerHeadless("default"),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );

describe("mentionTokens", () => {
  it("finds @ tokens at the start or after whitespace, once each", () => {
    expect(mentionTokens("@a.ts fix @src/b.ts and @a.ts, mail me@x.com")).toEqual([
      "a.ts",
      "src/b.ts",
      "a.ts,",
    ]);
    expect(mentionTokens("no mentions")).toEqual([]);
  });
});

describe("mentionAttachments", () => {
  it("returns numbered file blocks, without the message, and records the read in FileState", async () => {
    const root = tempDir();
    writeFileSync(join(root, "a.ts"), "one\ntwo\n");
    const { text, fresh } = await run(
      root,
      Effect.gen(function* () {
        const text = yield* mentionAttachments("look at @a.ts.");
        const fresh = yield* (yield* FileState).checkFresh(join(root, "a.ts"));
        return { text, fresh };
      }),
    );
    expect(text).toBe('<file path="a.ts">\n     1\tone\n     2\ttwo\n</file>');
    expect(fresh).toBe("ok");
  });

  it("attaches nothing for tokens outside the workspace or missing", async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "x.txt"), "secret");
    const text = `see @../${outside.split("/").at(-1)}/x.txt @${join(outside, "x.txt")} @missing.ts @`;
    expect(await run(root, mentionAttachments(text))).toBe("");
  });

  it("attaches the first 2000 lines of a long file with a note", async () => {
    const root = tempDir();
    writeFileSync(
      join(root, "long.txt"),
      Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    const text = await run(root, mentionAttachments("@long.txt"));
    expect(text).toContain("  2000\tline 2000");
    expect(text).not.toContain("line 2001");
    expect(text).toContain("showing lines 1-2000 of 2500");
  });

  it("attaches a directory listing", async () => {
    const root = tempDir();
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "a");
    writeFileSync(join(root, "src", "deep", "b.ts"), "b");
    writeFileSync(join(root, "top.ts"), "t");
    const text = await run(root, mentionAttachments("@src/"));
    expect(text).toBe('<directory path="src/">\nsrc/a.ts\nsrc/deep/b.ts\n</directory>');
  });

  it("skips secret-shaped files with a note instead of their content", async () => {
    const root = tempDir();
    writeFileSync(join(root, ".env"), "OPENROUTER_API_KEY=sk-live");
    const { text, stamp } = await run(
      root,
      Effect.gen(function* () {
        const text = yield* mentionAttachments("@.env");
        const stamp = yield* (yield* FileState).get(join(root, ".env"));
        return { text, stamp };
      }),
    );
    expect(text).not.toContain("sk-live");
    expect(text).toContain('<file path=".env">');
    expect(text).toContain("not attached");
    expect(Option.isNone(stamp)).toBe(true);
  });
});

describe("listWorkspaceFiles", () => {
  it("lists files and their directories, root-relative, honoring .gitignore", async () => {
    const root = tempDir();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    writeFileSync(join(root, "src", "a.ts"), "a");
    writeFileSync(join(root, "dist", "out.js"), "o");
    writeFileSync(join(root, "README.md"), "r");
    expect(await run(root, listWorkspaceFiles)).toEqual([
      ".gitignore",
      "README.md",
      "src/",
      "src/a.ts",
    ]);
  });
});

describe("the @ picker's ranking and insertion", () => {
  const paths = [
    "README.md",
    "docs/readme-notes.txt",
    "src/tui/app.tsx",
    "src/tui/",
    "scripts/read.ts",
  ];

  it("ranks basename hits first, then basename subsequences, then path subsequences", () => {
    expect(rankPaths(paths, "READ")).toEqual([
      "README.md",
      "scripts/read.ts",
      "docs/readme-notes.txt",
    ]);
    expect(rankPaths(paths, "stapp")).toEqual(["src/tui/app.tsx"]);
    expect(rankPaths(paths, "zzz")).toEqual([]);
    expect(rankPaths(paths, "")).toEqual(paths);
  });

  it("ranks a contiguous match anywhere above a subsequence, and drops mid-word scatter", () => {
    const repo = [
      "template/vanilla/.claude/hooks/",
      "template/vanilla/src/core/ask.ts",
      "src/packages/index.ts",
      "template/vanilla/package.json",
      "src/pa-ck.ts",
      "src/p/ack.ts",
      "package.json",
    ];
    expect(rankPaths(repo, "pack")).toEqual([
      "package.json",
      "template/vanilla/package.json",
      "src/packages/index.ts",
      "src/pa-ck.ts",
      "src/p/ack.ts",
    ]);
  });

  it("opens on an @ that starts a word, and replaces it with the picked path", () => {
    expect(opensMentionPicker("@")).toBe(true);
    expect(opensMentionPicker("fix @")).toBe(true);
    expect(opensMentionPicker("me@")).toBe(false);
    expect(insertMention("fix @", "src/a.ts")).toBe("fix @src/a.ts ");
    expect(insertMention("fix", "src/a.ts")).toBe("fix @src/a.ts ");
    expect(insertMention("", "src/a.ts")).toBe("@src/a.ts ");
  });
});
