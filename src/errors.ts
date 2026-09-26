import { Cause, Exit, Schema } from "effect";
import { CliError } from "effect/unstable/cli";
import type { ErrorBody } from "~/schemas";

/** OPENROUTER_API_KEY is unset: commands that call the model can't run. Exit 3. */
export class NotConfigured extends Schema.TaggedError<NotConfigured>()("NotConfigured", {
  message: Schema.String,
}) {}

/** An env var or the config file has a bad value. The message names it. Exit 3. */
export class InvalidConfig extends Schema.TaggedError<InvalidConfig>()("InvalidConfig", {
  message: Schema.String,
}) {}

/** An argument, flag value, or stdin failed to decode (after the CLI parser accepted it). Exit 2. */
export class BadInput extends Schema.TaggedError<BadInput>()("BadInput", {
  message: Schema.String,
}) {}

/** The chat the command names doesn't exist. Exit 2. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

/** The requested model id isn't in OpenRouter's models list. Exit 2. */
export class UnknownModel extends Schema.TaggedError<UnknownModel>()("UnknownModel", {
  message: Schema.String,
  model: Schema.String,
}) {}

/** An interactive command (`orx chat`) ran without a terminal. Exit 2. */
export class NotInteractive extends Schema.TaggedError<NotInteractive>()("NotInteractive", {
  message: Schema.String,
}) {}

/**
 * OpenRouter (or GitHub, for `update`) failed or timed out. Exit 4. `retryable` is false for
 * failures a retry can't fix (bad key, a rejected request). `detail` (the upstream status and
 * reason) is for logs and evals; the user sees `message`.
 */
export class UpstreamUnavailable extends Schema.TaggedError<UpstreamUnavailable>()(
  "UpstreamUnavailable",
  { message: Schema.String, retryable: Schema.Boolean, detail: Schema.optional(Schema.String) },
) {}

/** The model's structured output didn't decode against its schema. Exit 5. */
export class InvalidModelOutput extends Schema.TaggedError<InvalidModelOutput>()(
  "InvalidModelOutput",
  { message: Schema.String },
) {}

/** A file orx must write isn't writable (a root-owned install dir for `update`). Exit 6. */
export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()("PermissionDenied", {
  message: Schema.String,
}) {}

/**
 * The terminal UI can't start here: OpenTUI's native library didn't load (a build or platform
 * problem `orx doctor --tui` reports). An install problem, like missing config: exit 3.
 */
export class TuiUnavailable extends Schema.TaggedError<TuiUnavailable>()("TuiUnavailable", {
  message: Schema.String,
}) {}

export type AppError =
  | NotConfigured
  | InvalidConfig
  | BadInput
  | NotFound
  | UnknownModel
  | NotInteractive
  | UpstreamUnavailable
  | InvalidModelOutput
  | PermissionDenied
  | TuiUnavailable;

const APP_ERROR_TAGS: ReadonlySet<string> = new Set<AppError["_tag"]>([
  "NotConfigured",
  "InvalidConfig",
  "BadInput",
  "NotFound",
  "UnknownModel",
  "NotInteractive",
  "UpstreamUnavailable",
  "InvalidModelOutput",
  "PermissionDenied",
  "TuiUnavailable",
]);

export const isAppError = (u: unknown): u is AppError =>
  typeof u === "object" &&
  u !== null &&
  "_tag" in u &&
  typeof u._tag === "string" &&
  APP_ERROR_TAGS.has(u._tag);

/** The documented exit codes (README, Commands). Exhaustive: a new error forces a decision. */
export const exitCodeFor = (error: AppError): number => {
  switch (error._tag) {
    case "BadInput":
    case "NotFound":
    case "UnknownModel":
    case "NotInteractive":
      return 2;
    case "NotConfigured":
    case "InvalidConfig":
    case "TuiUnavailable":
      return 3;
    case "UpstreamUnavailable":
      return 4;
    case "InvalidModelOutput":
      return 5;
    case "PermissionDenied":
      return 6;
  }
};

/** Whether running the same command again can succeed. Exhaustive, like exitCodeFor. */
export const retryableFor = (error: AppError): boolean => {
  switch (error._tag) {
    case "NotConfigured":
    case "InvalidConfig":
    case "BadInput":
    case "NotFound":
    case "UnknownModel":
    case "NotInteractive":
    case "PermissionDenied":
    case "TuiUnavailable":
      return false;
    // The model may return valid output on another try.
    case "InvalidModelOutput":
      return true;
    case "UpstreamUnavailable":
      return error.retryable;
  }
};

export const errorBody = (error: AppError): ErrorBody => ({
  tag: error._tag,
  message: error.message,
  retryable: retryableFor(error),
});

/**
 * stdout's reader went away (`orx models | head -1`). Output dies with this so the run stops
 * writing; outcomeOf reads it as a quiet success, not a bug or a Ctrl+C.
 */
export class BrokenPipe extends Error {
  override readonly name = "BrokenPipe";
}

/**
 * What a finished run means for the process: its exit code, and what to tell the user.
 * `help` is a ShowHelp without errors (`orx` with no subcommand): the help already went to
 * stdout, so there's nothing more to say. Parse errors exit 2 like BadInput; defects exit 1.
 */
export type Outcome =
  | { readonly kind: "ok" }
  | { readonly kind: "help" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "closed" }
  | { readonly kind: "usage"; readonly body: ErrorBody }
  | { readonly kind: "failed"; readonly error: AppError; readonly body: ErrorBody }
  | { readonly kind: "defect"; readonly cause: Cause.Cause<unknown>; readonly body: ErrorBody };

const INTERNAL: ErrorBody = {
  tag: "InternalError",
  message: "Something went wrong inside orx. The log has the details (see README, Logs).",
  retryable: true,
};

export const outcomeOf = (exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { kind: "ok" };
  const cause = exit.cause;
  if (Cause.hasInterruptsOnly(cause)) return { kind: "interrupted" };
  if (cause.reasons.some((r) => Cause.isDieReason(r) && r.defect instanceof BrokenPipe)) {
    return { kind: "closed" };
  }
  const failure = cause.reasons.find(Cause.isFailReason)?.error;
  if (failure !== undefined && CliError.isCliError(failure)) {
    if (failure._tag === "ShowHelp") {
      if (failure.errors.length === 0) return { kind: "help" };
      const message = failure.errors.map((e) => e.message).join("\n");
      return { kind: "usage", body: { tag: "UsageError", message, retryable: false } };
    }
    return {
      kind: "usage",
      body: { tag: "UsageError", message: failure.message, retryable: false },
    };
  }
  if (isAppError(failure)) return { kind: "failed", error: failure, body: errorBody(failure) };
  return { kind: "defect", cause, body: INTERNAL };
};

export const exitCodeForOutcome = (outcome: Outcome): number => {
  switch (outcome.kind) {
    case "ok":
    case "help":
    case "closed":
      return 0;
    case "interrupted":
      return 130;
    case "usage":
      return 2;
    case "failed":
      return exitCodeFor(outcome.error);
    case "defect":
      return 1;
  }
};
