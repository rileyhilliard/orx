import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect } from "effect";
import {
  type LogEntry,
  type LogRecord,
  makeLoggerLayer,
  TerminalLogging,
  toConsoleLine,
  toJsonLine,
  toRecord,
} from "~/logging";

const entry = (
  message: unknown,
  annotations: Record<string, unknown> = {},
  cause: Cause.Cause<unknown> = Cause.empty,
): LogEntry => ({
  logLevel: "Warn",
  message,
  cause,
  annotations,
  date: new Date("2026-09-24T21:13:29.815Z"),
});

describe("toRecord (the JSON line shape)", () => {
  it("puts time, level, msg first and annotations as sorted top-level keys", () => {
    const record = toRecord(entry("llm call", { zeta: 1, alpha: "a", cost: null }));
    expect(Object.keys(record)).toEqual(["time", "level", "msg", "alpha", "cost", "zeta"]);
    expect(record).toMatchObject({ time: "2026-09-24T21:13:29.815Z", level: "warn", cost: null });
  });

  it("keeps an Error's name, message, status and stack, and nothing else it carries", () => {
    const error = Object.assign(new Error("upstream said no"), {
      statusCode: 502,
      requestBodyValues: { messages: ["secret prompt"] },
    });
    const record = toRecord(entry(["Model call failed", error]));
    expect(record.msg).toBe("Model call failed");
    expect(record.detail).toMatchObject({
      name: "Error",
      message: "upstream said no",
      statusCode: 502,
    });
    expect(toJsonLine(record)).not.toContain("secret prompt");
  });

  it("renders a cause as a pretty `error` string", () => {
    const record = toRecord(entry(["defect"], {}, Cause.die(new Error("boom"))));
    expect(record.error).toMatch(/boom/);
  });

  it("renames an annotation that would overwrite a record field", () => {
    const record = toRecord(entry("real message", { msg: "annotation", level: "x" }));
    expect(record).toMatchObject({
      msg: "real message",
      level: "warn",
      msg_: "annotation",
      level_: "x",
    });
  });

  it("serializes to one line of JSON", () => {
    const line = toJsonLine(toRecord(entry("x", { text: "a\nb" })));
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({ msg: "x", text: "a\nb" });
  });
});

describe("toConsoleLine (the terminal)", () => {
  const record = (fields: Record<string, unknown>): LogRecord => ({
    time: "2026-09-24T21:13:29.815Z",
    level: "info",
    msg: "command",
    ...fields,
  });

  it("reads a command as orx <command> exit N duration, then the other fields", () => {
    const line = toConsoleLine(
      record({ command: "ask", exitCode: 2, durationMs: 14, runId: "ab12cd34" }),
      false,
    );
    expect(line).toMatch(/^\d\d:\d\d:\d\d\.815 INFO {2}orx ask exit 2 14ms runId=ab12cd34$/);
  });

  it("leaves out null fields, quotes values with spaces, and indents multi-line values", () => {
    const line = toConsoleLine(
      { ...record({ provider: null, reason: "two words", tree: "a\nb" }), msg: "other" },
      false,
    );
    const [head, ...rest] = line.split("\n");
    expect(head).toMatch(/INFO {2}other reason="two words"$/);
    expect(rest).toEqual(["    tree:", "    a", "    b"]);
  });

  it("adds ANSI colors only when asked", () => {
    const rec = record({ command: "models", exitCode: 0, durationMs: 1 });
    expect(toConsoleLine(rec, true)).toContain("\x1b[");
    expect(toConsoleLine(rec, false)).not.toContain("\x1b[");
  });
});

describe("makeLoggerLayer", () => {
  let dir: string;
  let stderr: string[];
  let stdout: ReturnType<typeof spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orx-logs-"));
    stderr = [];
    spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    mock.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  const readRecords = (file: string) =>
    readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as LogRecord);

  it("writes to stderr, never stdout", async () => {
    await Effect.runPromise(
      Effect.logWarning("careful").pipe(
        Effect.provide(makeLoggerLayer({ format: "json", color: false, minimumLevel: "Info" })),
      ),
    );
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(stderr.join(""))).toMatchObject({ level: "warn", msg: "careful" });
  });

  it("stops terminal lines while TerminalLogging is off (the TUI), and keeps the file", async () => {
    const file = join(dir, "orx.jsonl");
    await Effect.runPromise(
      Effect.logInfo("under the tui").pipe(
        Effect.provideService(TerminalLogging, false),
        Effect.provide(
          makeLoggerLayer({ format: "json", color: false, minimumLevel: "Info", file }),
        ),
      ),
    );
    expect(stderr).toEqual([]);
    expect(readRecords(file).map((r) => r.msg)).toEqual(["under the tui"]);
  });

  it("appends one parseable JSON line per record, creating the directory", async () => {
    const file = join(dir, "nested", "orx.jsonl");
    await Effect.runPromise(
      Effect.all([
        Effect.logInfo("first").pipe(Effect.annotateLogs({ runId: "r1" })),
        Effect.logError("second", Cause.fail("nope")),
        Effect.logDebug("below the minimum level"),
      ]).pipe(
        Effect.provide(
          makeLoggerLayer({ format: "json", color: false, minimumLevel: "Info", file }),
        ),
      ),
    );
    const records = readRecords(file);
    expect(records.map((r) => [r.level, r.msg])).toEqual([
      ["info", "first"],
      ["error", "second"],
    ]);
    expect(records[0]?.runId).toBe("r1");
    expect(records[1]?.error).toMatch(/nope/);
  });

  it("never fails the program when the file can't be written", async () => {
    const result = await Effect.runPromise(
      Effect.logInfo("x").pipe(
        Effect.as("done"),
        Effect.provide(
          makeLoggerLayer({ format: "json", color: false, minimumLevel: "Info", file: dir }),
        ),
      ),
    );
    expect(result).toBe("done");
    expect(stderr.join("")).toContain("file logging is off");
  });
});
