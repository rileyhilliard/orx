import { Schema } from "effect";
import { ChatId, Usage } from "./chat";
import { ErrorBody } from "./errors";

/**
 * One line of `orx ask --json` output (NDJSON on stdout), in order: text deltas and tool
 * events as they happen, then exactly one `done` or `error`. This is a public contract for
 * scripts and agents: add fields, don't rename or remove them.
 */
export const AskEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), delta: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool-call"),
    /** The call's id; its `tool-result` carries the same one. */
    id: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("tool-result"),
    id: Schema.String,
    name: Schema.String,
    output: Schema.Unknown,
    isFailure: Schema.Boolean,
  }),
  /**
   * A tool call Permissions refused (with `--agent`, whatever would ask the user; see
   * `--permission-mode`). `id` is the call's; its `tool-result` follows with the same message.
   */
  Schema.Struct({
    type: Schema.Literal("permission-denied"),
    id: Schema.String,
    tool: Schema.String,
    message: Schema.String,
  }),
  /** Why a turn ended early without failing (the step cap, a repeated tool call). */
  Schema.Struct({ type: Schema.Literal("note"), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("done"),
    chatId: ChatId,
    model: Schema.optional(Schema.String),
    provider: Schema.optional(Schema.String),
    finishReason: Schema.String,
    usage: Usage,
  }),
  Schema.Struct({ type: Schema.Literal("error"), error: ErrorBody }),
]);
export type AskEvent = typeof AskEvent.Type;
