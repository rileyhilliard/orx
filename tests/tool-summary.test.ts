import { describe, expect, it } from "vitest";
import { collapseLines, summarizeTool } from "~/tui/tool-summary";

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
    expect(summarizeTool("write", { path: "a.ts" }, "Created a.ts (3 lines)", false)).toEqual({
      summary: "Created a.ts (3 lines)",
    });
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
