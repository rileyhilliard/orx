import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Permissions } from "~/services/permissions";
import { permit } from "~/tools/permit";
import { printable } from "~/tui/printable";
import { collapseLines, summarizeTool, toolStatus } from "~/tui/tool-summary";

describe("summarizeTool", () => {
  it("says what each agent tool did in one line", () => {
    expect(summarizeTool("read", { path: "src/x.ts" }, "     1\ta\n     2\tb", false)).toEqual({
      summary: "read src/x.ts · 2 lines",
    });
    expect(summarizeTool("bash", { command: "bun test" }, "fail\n(exit code 1)", false)).toEqual({
      summary: "bash bun test · exit 1",
    });
    expect(summarizeTool("glob", { pattern: "**/*.ts" }, "a.ts\nb.ts", false)).toEqual({
      summary: "glob **/*.ts · 2 files",
    });
    expect(
      summarizeTool("write", { path: "a.ts", content: "a\nb\n" }, "Created a.ts (2 lines)", false),
    ).toEqual({ summary: "Created a.ts (2 lines)", diff: "+a\n+b" });
    expect(summarizeTool("edit", { path: "a.ts" }, "-a\n+b", false)).toEqual({
      summary: "edit a.ts",
      diff: "-a\n+b",
    });
  });

  it("shows a failure's message, and leaves other tools alone", () => {
    expect(
      summarizeTool(
        "read",
        { path: "x" },
        { _tag: "ToolFailure", message: "x: no such file" },
        true,
      ),
    ).toEqual({ summary: "read x · x: no such file" });
    expect(summarizeTool("currentTime", { timeZone: "UTC" }, "noon", false)).toBeUndefined();
  });

  it("shows only a failure message's first line", () => {
    const output = { _tag: "ToolFailure", message: "x: no such file\nstack\nmore" };
    expect(summarizeTool("read", { path: "x" }, output, true)).toEqual({
      summary: "read x · x: no such file",
    });
    expect(toolStatus(output, true)).toBe("error");
  });

  it("marks a call Permissions denied, with the reason, apart from a failure", async () => {
    // The real denial: a headless session refuses an edit it would have asked about.
    const failure = await Effect.runPromise(
      permit({ tool: "edit", summary: "Edit a.ts", diff: "-a\n+b", path: "a.ts" }).pipe(
        Effect.flip,
        Effect.provide(Permissions.layerHeadless("default")),
      ),
    );
    expect(toolStatus(failure, true)).toBe("denied");
    const summary = summarizeTool("edit", { path: "a.ts" }, failure, true)?.summary ?? "";
    expect(summary.startsWith("edit a.ts · denied · ")).toBe(true);
    expect(toolStatus("Edited", false)).toBe("ok");
  });

  it("shows no diff for an overwrite, whose output is one line", () => {
    expect(
      summarizeTool("write", { path: "a.ts", content: "b" }, "Overwrote a.ts (1 lines)", false),
    ).toEqual({ summary: "Overwrote a.ts (1 lines)" });
  });

  it("cuts a long bash command to its first line", () => {
    expect(summarizeTool("bash", { command: "echo a\necho b" }, "(exit code 0)", false)).toEqual({
      summary: "bash echo a… · exit 0",
    });
  });
});

describe("collapseLines", () => {
  it("keeps 20 lines and counts the rest", () => {
    const text = Array.from({ length: 25 }, (_, i) => `l${i}`).join("\n");
    expect(collapseLines(text)).toEqual({
      lines: Array.from({ length: 20 }, (_, i) => `l${i}`),
      hidden: 5,
    });
    expect(collapseLines("a\nb\n")).toEqual({ lines: ["a", "b"], hidden: 0 });
  });
});

describe("printable", () => {
  it("drops control characters a model could use to drive the terminal", () => {
    expect(printable("a\u001b[2Jb\u0007c\u009bd")).toBe("a[2Jbcd");
    expect(printable("one\r\ntwo\rthree\tfour")).toBe("one\ntwo\nthree\tfour");
  });
});
