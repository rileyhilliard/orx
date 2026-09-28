import {
  Context,
  Deferred,
  Effect,
  Layer,
  Queue,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { isSecretPath } from "./workspace";

/**
 * How much the agent may do without asking. `default` asks for every write, edit, and bash;
 * `acceptEdits` allows writes and edits (except protected paths); `plan` denies them; `yolo`
 * allows everything.
 */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "yolo";
export const PERMISSION_MODES: ReadonlyArray<PermissionMode> = [
  "default",
  "acceptEdits",
  "plan",
  "yolo",
];

/** One tool call that may need the user's approval. */
export interface PermissionRequest {
  /** The tool: read, glob, grep, write, edit, or bash. */
  readonly tool: string;
  /** One line for the approval panel, e.g. "Edit src/app.ts" or the command. */
  readonly summary: string;
  /** The unified diff a write or edit would apply. */
  readonly diff?: string;
  /** bash only: the exact command, matched by an "always" answer. */
  readonly command?: string;
  /** The file, root-relative (Workspace.display), for secret and protected path rules. */
  readonly path?: string;
}

export type PermissionResult = "allow" | { readonly deny: string };

/** The user's answer to an approval request. `no` carries an optional note for the model. */
export type ApprovalDecision = "yes" | "always" | { readonly no: string };

/** What the UI shows: an open approval request, or one that was cancelled (the turn stopped). */
export type ApprovalEvent =
  | {
      readonly type: "approval-request";
      readonly id: string;
      readonly tool: string;
      readonly summary: string;
      readonly diff?: string;
      /** Whether "always" is on offer (not for compound bash commands). */
      readonly canAlways: boolean;
    }
  | { readonly type: "approval-cancelled"; readonly id: string };

export interface PermissionsShape {
  readonly mode: Effect.Effect<PermissionMode>;
  readonly setMode: (mode: PermissionMode) => Effect.Effect<void>;
  /** The mode now and every change after (Shift+Tab, or an "always" answer to an edit). */
  readonly modeChanges: Stream.Stream<PermissionMode>;
  /** Allow, deny, or ask the user (waiting for `answer`). */
  readonly check: (request: PermissionRequest) => Effect.Effect<PermissionResult>;
  /** Approval requests and cancellations, for one consumer (the turn merges them in). */
  readonly events: Stream.Stream<ApprovalEvent>;
  /** Answers an open request. An unknown id (already answered or cancelled) is ignored. */
  readonly answer: (id: string, decision: ApprovalDecision) => Effect.Effect<void>;
  /** Denies every open request (the turn was interrupted). Returns their ids. */
  readonly cancelAll: Effect.Effect<ReadonlyArray<string>>;
}

/**
 * Paths a later approved command would run or load, so even acceptEdits asks before writing
 * them. Compared case-insensitively: on macOS and Windows, `.GIT/config` is `.git/config`.
 */
export const isProtectedPath = (relative: string): boolean => {
  const parts = relative.toLowerCase().split(/[\\/]/);
  const name = parts.at(-1) ?? "";
  if (parts.includes(".git")) return true;
  if (["package.json", "lefthook.yml", "agents.md", "claude.md"].includes(name)) return true;
  return parts.some(
    (part, i) => part === ".orx" && (parts[i + 1] === "commands" || parts[i + 1] === "skills"),
  );
};

/**
 * "always" isn't offered for a command that chains, pipes, substitutes, or redirects, or runs
 * a second line.
 */
export const isCompoundCommand = (command: string) => /[;&|$`<>\n\r]/.test(command);

const PLAN_DENIAL = "plan mode: describe the change instead";
const HEADLESS_DENIAL =
  "needs an interactive session: the user wasn't asked (run orx, or pass --permission-mode acceptEdits or yolo)";

type Verdict = PermissionResult | "ask";

/** The rules, before asking: what the mode and the session's "always" answers decide. */
export const decide = (
  mode: PermissionMode,
  request: PermissionRequest,
  allowedCommands: ReadonlySet<string>,
): Verdict => {
  if (mode === "yolo") return "allow";
  const secret = request.path !== undefined && isSecretPath(request.path);
  switch (request.tool) {
    case "write":
    case "edit":
      if (mode === "plan") return { deny: PLAN_DENIAL };
      if (secret) return "ask";
      if (mode === "acceptEdits") {
        return request.path !== undefined && isProtectedPath(request.path) ? "ask" : "allow";
      }
      return "ask";
    case "bash":
      if (mode === "plan") return { deny: PLAN_DENIAL };
      return request.command !== undefined && allowedCommands.has(request.command)
        ? "allow"
        : "ask";
    case "read":
    case "glob":
    case "grep":
      // Allowed inside the workspace, except credential-shaped files.
      return secret ? "ask" : "allow";
    default:
      // A tool without a rule here fails closed: it asks, and plan mode denies it.
      return mode === "plan" ? { deny: PLAN_DENIAL } : "ask";
  }
};

/**
 * Whether "always" is on offer. Not for a read (it would allow nothing more), a tool without a
 * rule in `decide` (there's nothing for "always" to remember), a compound
 * command, or a secret or protected path: "always" on an edit switches to acceptEdits, which
 * would still ask for those, so the answer would promise more than it does.
 */
const canAlwaysFor = (request: PermissionRequest) => {
  if (request.path !== undefined && (isSecretPath(request.path) || isProtectedPath(request.path))) {
    return false;
  }
  switch (request.tool) {
    case "write":
    case "edit":
      return true;
    case "bash":
      return request.command !== undefined && !isCompoundCommand(request.command);
    default:
      return false;
  }
};

const make = (initial: PermissionMode, interactive: boolean) =>
  Effect.gen(function* () {
    const modeRef = yield* SubscriptionRef.make(initial);
    const allowedCommands = new Set<string>();
    const pending = new Map<string, Deferred.Deferred<ApprovalDecision>>();
    const queue = yield* Queue.unbounded<ApprovalEvent>();
    // One approval panel at a time: parallel tool calls wait their turn to ask.
    const asking = yield* Semaphore.make(1);
    let nextId = 0;

    const verdictFor = (request: PermissionRequest) =>
      Effect.map(SubscriptionRef.get(modeRef), (mode) => decide(mode, request, allowedCommands));

    const ask = (request: PermissionRequest) =>
      Effect.gen(function* () {
        const id = `approval-${++nextId}`;
        const deferred = yield* Deferred.make<ApprovalDecision>();
        const canAlways = canAlwaysFor(request);
        pending.set(id, deferred);
        yield* Queue.offer(queue, {
          type: "approval-request",
          id,
          tool: request.tool,
          summary: request.summary,
          ...(request.diff === undefined ? {} : { diff: request.diff }),
          canAlways,
        });
        const decision = yield* Deferred.await(deferred).pipe(
          Effect.onInterrupt(() =>
            Queue.offer(queue, { type: "approval-cancelled", id }).pipe(Effect.asVoid),
          ),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        );
        if (typeof decision === "object") {
          const note = decision.no.trim();
          return { deny: note === "" ? "The user said no." : `The user said no: ${note}` };
        }
        if (decision === "always" && canAlways) {
          if (request.tool === "bash" && request.command !== undefined) {
            allowedCommands.add(request.command);
          } else if (request.tool === "write" || request.tool === "edit") {
            const mode = yield* SubscriptionRef.get(modeRef);
            if (mode === "default") yield* SubscriptionRef.set(modeRef, "acceptEdits");
          }
        }
        return "allow" as const;
      });

    return {
      mode: SubscriptionRef.get(modeRef),
      setMode: (mode) => SubscriptionRef.set(modeRef, mode),
      modeChanges: SubscriptionRef.changes(modeRef),
      check: (request) =>
        Effect.gen(function* () {
          const verdict = yield* verdictFor(request);
          if (verdict !== "ask") return verdict;
          if (!interactive) return { deny: `${request.tool} ${HEADLESS_DENIAL}` };
          // While this call waited for the panel, an earlier answer ("always") or a mode switch
          // may have settled it: decide again before asking.
          return yield* Effect.gen(function* () {
            const now = yield* verdictFor(request);
            return now === "ask" ? yield* ask(request) : now;
          }).pipe(Semaphore.withPermit(asking));
        }),
      events: Stream.fromQueue(queue),
      answer: (id, decision) =>
        Effect.suspend(() => {
          const deferred = pending.get(id);
          return deferred === undefined
            ? Effect.void
            : Deferred.succeed(deferred, decision).pipe(Effect.asVoid);
        }),
      cancelAll: Effect.gen(function* () {
        const open = [...pending];
        for (const [id, deferred] of open) {
          pending.delete(id);
          yield* Deferred.succeed(deferred, { no: "interrupted" });
          yield* Queue.offer(queue, { type: "approval-cancelled", id });
        }
        return open.map(([id]) => id);
      }),
    } satisfies PermissionsShape;
  });

/** Decides whether a tool call runs, and asks the user through `events`/`answer` when needed. */
export class Permissions extends Context.Service<Permissions, PermissionsShape>()(
  "orx/Permissions",
) {
  /** An interactive session (the TUI): asks go out on `events` and wait for `answer`. */
  static readonly layer = (mode: PermissionMode = "default") =>
    Layer.effect(Permissions, make(mode, true));
  /** No one to ask (`orx ask --agent`): anything that would ask is denied with a note. */
  static readonly layerHeadless = (mode: PermissionMode = "default") =>
    Layer.effect(Permissions, make(mode, false));
}
