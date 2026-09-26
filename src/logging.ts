import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  Cause,
  Context,
  Formatter,
  Inspectable,
  Layer,
  Logger,
  type LogLevel,
  References,
} from "effect";

/**
 * One log record, flat, so `jq 'select(.level == "error")'` works without digging:
 * `time`, `level` (debug, info, warn, error, fatal), `msg`, then the annotations as
 * top-level keys, `detail` for extra log arguments, and `error` (a pretty cause) when
 * there is one. Written as JSON lines to ORX_LOG_FILE, and to stderr with ORX_LOG_FORMAT=json.
 */
export type LogRecord = Record<string, unknown> & {
  readonly time: string;
  readonly level: string;
  readonly msg: string;
};

/** Record keys an annotation can't take; one that tries is written as `<key>_`. */
const RECORD_KEYS = new Set(["time", "level", "msg", "detail", "error"]);

/** Errors don't survive JSON.stringify; keep what helps debugging (never request bodies). */
const serialize = (value: unknown): unknown => {
  if (value instanceof Error) {
    const statusCode = (value as { statusCode?: unknown }).statusCode;
    return {
      name: value.name,
      message: value.message,
      ...(typeof statusCode === "number" ? { statusCode } : {}),
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  return value;
};

/** What a logger receives, minus the fiber: the log annotations are passed in explicitly. */
export interface LogEntry {
  readonly message: unknown;
  readonly logLevel: LogLevel.LogLevel;
  readonly cause: Cause.Cause<unknown>;
  readonly date: Date;
  readonly annotations: Readonly<Record<string, unknown>>;
}

/** A logger's options as a LogEntry, reading the annotations from the logging fiber. */
export const toEntry = (options: Logger.Options<unknown>): LogEntry => ({
  message: options.message,
  logLevel: options.logLevel,
  cause: options.cause,
  date: options.date,
  annotations: options.fiber.getRef(References.CurrentLogAnnotations),
});

export const toRecord = (entry: LogEntry): LogRecord => {
  const parts = Array.isArray(entry.message) ? entry.message : [entry.message];
  const [first, ...rest] = parts;
  const record: Record<string, unknown> = {
    time: entry.date.toISOString(),
    level: entry.logLevel.toLowerCase(),
    msg: typeof first === "string" ? first : Inspectable.toStringUnknown(first),
  };
  // Sorted, so the same kind of line always has the same field order.
  const annotations = Object.entries(entry.annotations).sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of annotations) {
    record[RECORD_KEYS.has(key) ? `${key}_` : key] = serialize(value);
  }
  if (rest.length > 0) {
    record.detail = rest.length === 1 ? serialize(rest[0]) : rest.map(serialize);
  }
  if (entry.cause.reasons.length > 0) {
    record.error = Cause.pretty(entry.cause);
  }
  return record as LogRecord;
};

export const toJsonLine = (record: LogRecord): string => Formatter.formatJson(record);

const ansi = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const dim = ansi("2");
const bold = ansi("1");
const levelColor: Record<string, (text: string) => string> = {
  trace: dim,
  debug: dim,
  info: ansi("32"),
  warn: ansi("33"),
  error: ansi("31"),
  fatal: ansi("41;97"),
};
const plain = (text: string) => text;

const RESERVED = new Set(["time", "level", "msg", "error"]);
/** Fields a `command` line (see bin.ts) folds into its headline. */
const COMMAND_FIELDS = new Set(["command", "exitCode", "durationMs"]);

const exitColor = (code: number) =>
  code === 0 ? ansi("32") : code === 130 ? ansi("33") : ansi("31");

const renderValue = (value: unknown): string => {
  if (typeof value === "string") return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  if (value && typeof value === "object" && "message" in value && "name" in value) {
    const status = "statusCode" in value ? ` (${String(value.statusCode)})` : "";
    return JSON.stringify(`${String(value.name)}${status}: ${String(value.message)}`);
  }
  return Formatter.formatJson(value);
};

/**
 * The terminal format, for people: one line per record,
 * `12:01:02.345 INFO  msg key=value ...`, and command lines read as
 * `12:01:02.345 INFO  orx ask exit 0 812ms runId=...`. Null and undefined fields
 * are left out (the JSON file keeps them). Multi-line values and the error cause print
 * indented under the line.
 */
export const toConsoleLine = (record: LogRecord, color: boolean): string => {
  const paint = (fn: (text: string) => string) => (color ? fn : plain);
  // Local time, like Vite's own lines; the JSON keeps UTC ISO.
  const date = new Date(record.time);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  const label = record.level.toUpperCase().padEnd(5);
  const { command, exitCode, durationMs } = record;
  const isCommand =
    record.msg === "command" && typeof exitCode === "number" && typeof command === "string";
  const headline = isCommand
    ? [
        paint(bold)(`orx ${command}`),
        paint(exitColor(exitCode))(`exit ${exitCode}`),
        paint(dim)(`${String(durationMs)}ms`),
      ].join(" ")
    : paint(bold)(record.msg);
  const fields: string[] = [];
  const blocks: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED.has(key) || value === null || value === undefined) continue;
    if (isCommand && COMMAND_FIELDS.has(key)) continue;
    if (typeof value === "string" && value.includes("\n")) {
      blocks.push(`${key}:\n${value}`);
      continue;
    }
    fields.push(`${paint(dim)(`${key}=`)}${renderValue(value)}`);
  }
  if (typeof record.error === "string") blocks.push(record.error);
  const head = [
    paint(dim)(time),
    paint(levelColor[record.level] ?? plain)(label),
    headline,
    ...fields,
  ].join(" ");
  const indent = (text: string) =>
    text
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
  return [head, ...blocks.map((block) => paint(dim)(indent(block)))].join("\n");
};

export interface LoggerOptions {
  /** `pretty`: one colored line per record for a terminal. `json`: JSON lines. Both on stderr. */
  readonly format: "pretty" | "json";
  readonly color: boolean;
  readonly minimumLevel: LogLevel.LogLevel;
  /** Also append JSON lines to this file (created with its directory). */
  readonly file?: string;
}

/**
 * Whether log lines may go to the terminal (stderr). The TUI turns it off while it owns the
 * screen, so a log line can't draw over it; the file sink keeps writing.
 */
export const TerminalLogging = Context.Reference<boolean>("orx/TerminalLogging", {
  defaultValue: () => true,
});

/** Every log line goes to stderr: stdout carries only results (and MCP frames in `orx mcp`). */
const write = (line: string) => {
  process.stderr.write(`${line}\n`);
};

/**
 * Sync appends keep lines whole and ordered and need no cleanup across hot reloads. A
 * logger that throws fails the effect that logged, so this never throws: it creates the
 * directory on first use (and again if `bun run clean` deleted it), and otherwise warns
 * once on stderr and drops the line.
 */
const makeAppender = (file: string) => {
  let warned = false;
  const attempt = (line: string, retry: boolean): void => {
    try {
      appendFileSync(file, line);
    } catch (cause) {
      if (retry && (cause as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          mkdirSync(dirname(file), { recursive: true });
        } catch {
          // Reported below, by the retry's own failure.
        }
        attempt(line, false);
        return;
      }
      if (!warned) {
        warned = true;
        process.stderr.write(`Can't write ${file}, so file logging is off: ${String(cause)}\n`);
      }
    }
  };
  return (line: string) => attempt(line, true);
};

/** Replaces Effect's default logger with the stderr logger, plus the file sink. */
export const makeLoggerLayer = (options: LoggerOptions): Layer.Layer<never> => {
  const terminalLogger = Logger.make<unknown, void>((entry) => {
    if (!entry.fiber.getRef(TerminalLogging)) return;
    const record = toRecord(toEntry(entry));
    write(options.format === "json" ? toJsonLine(record) : toConsoleLine(record, options.color));
  });
  const loggers = [terminalLogger];
  if (options.file) {
    const append = makeAppender(options.file);
    loggers.push(
      Logger.make<unknown, void>((entry) => append(`${toJsonLine(toRecord(toEntry(entry)))}\n`)),
    );
  }
  return Layer.mergeAll(
    Logger.layer(loggers),
    Layer.succeed(References.MinimumLogLevel, options.minimumLevel),
    // For anything that logs before this layer is in place (Effect's default logger).
    Layer.succeed(Logger.LogToStderr, true),
  );
};
