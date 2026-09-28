import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Permissions } from "~/services/permissions";
import { permit } from "~/tools/permit";
import { printable } from "~/tui/printable";
import {
  collapseLines,
  describeCall,
  summarizeTool,
  toolStatus,
  turnSummary,
} from "~/tui/tool-summary";

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
    expect(
      summarizeTool("write", { path: "a.ts" }, "Overwrote a.ts (1 lines)\n-a\n+b", false),
    ).toEqual({ summary: "Overwrote a.ts (1 lines)", diff: "-a\n+b" });
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

  it("says a grep found nothing instead of counting its message as a line", () => {
    expect(
      summarizeTool("grep", { pattern: "fmtPrice" }, "No matches for fmtPrice", false),
    ).toEqual({
      summary: "grep fmtPrice · no matches",
    });
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

describe("describeCall", () => {
  it("names a running agent tool call by what it touches, and the file an edit or write changes", () => {
    expect(describeCall("edit", { path: "src/a.ts", old_string: "x" })).toEqual({
      target: "edit src/a.ts",
      file: "src/a.ts",
    });
    expect(describeCall("write", { path: "b.ts", content: "" })).toEqual({
      target: "write b.ts",
      file: "b.ts",
    });
    expect(describeCall("read", { path: "c.ts" })).toEqual({ target: "read c.ts" });
    expect(describeCall("bash", { command: "echo a\necho b" })).toEqual({
      target: "bash echo a…",
    });
    // Other tools, and input without the field, keep their `name(input)` line.
    // One file however the model spelled it: `./src/a.ts` or an absolute path in the root.
    expect(describeCall("edit", { path: "./src/a.ts" }, "/w")).toMatchObject({ file: "src/a.ts" });
    expect(describeCall("edit", { path: "/w/src/a.ts" }, "/w")).toMatchObject({ file: "src/a.ts" });
    expect(describeCall("edit", { path: "/elsewhere/a.ts" }, "/w")).toMatchObject({
      file: "/elsewhere/a.ts",
    });
    expect(describeCall("currentTime", { timeZone: "UTC" })).toEqual({});
    expect(describeCall("edit", { old_string: "x" })).toEqual({});
  });
});

describe("turnSummary", () => {
  const call = (name: string, file: string | undefined, status: "ok" | "error" | "denied") => ({
    name,
    input: "{}",
    status,
    ...(file === undefined ? {} : { file }),
  });

  it("lists the files a reply changed, once each, and the commands it ran", () => {
    expect(
      turnSummary([
        call("read", undefined, "ok"),
        call("edit", "src/a.ts", "ok"),
        call("edit", "src/a.ts", "ok"),
        call("write", "b.md", "ok"),
        call("edit", "c.ts", "denied"),
        call("edit", "d.ts", "error"),
        call("bash", undefined, "ok"),
        call("bash", undefined, "denied"),
      ]),
    ).toBe("Done · changed src/a.ts, b.md · ran 1 command");
    // A command can change files orx didn't see, so a reply that ran one never says "no files
    // changed".
    expect(turnSummary([call("bash", undefined, "ok"), call("bash", undefined, "error")])).toBe(
      "Done · ran 2 commands",
    );
  });

  it("says nothing changed after a reply that only looked, and nothing for a plain reply", () => {
    expect(turnSummary([call("grep", undefined, "ok")])).toBe("Done · no files changed");
    expect(turnSummary([])).toBeUndefined();
  });

  it("names the first five files and counts the rest", () => {
    const files = Array.from({ length: 7 }, (_, i) => call("edit", `f${i}.ts`, "ok"));
    expect(turnSummary(files)).toBe("Done · changed f0.ts, f1.ts, f2.ts, f3.ts, f4.ts and 2 more");
  });
});
