import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  decide,
  isCompoundCommand,
  isProtectedPath,
  type PermissionMode,
  type PermissionRequest,
  Permissions,
} from "~/services/permissions";

const edit = (path: string): PermissionRequest => ({ tool: "edit", summary: `Edit ${path}`, path });
const bash = (command: string): PermissionRequest => ({ tool: "bash", summary: command, command });
const read = (path: string): PermissionRequest => ({ tool: "read", summary: `Read ${path}`, path });
const none = new Set<string>();

describe("permission rules", () => {
  it("decides write, edit, and bash by mode", () => {
    const table = (mode: PermissionMode) => ({
      edit: decide(mode, edit("src/a.ts"), none),
      write: decide(mode, { ...edit("src/a.ts"), tool: "write" }, none),
      bash: decide(mode, bash("bun test"), none),
    });
    expect(table("default")).toEqual({ edit: "ask", write: "ask", bash: "ask" });
    expect(table("acceptEdits")).toEqual({ edit: "allow", write: "allow", bash: "ask" });
    const plan = { deny: "plan mode: describe the change instead" };
    expect(table("plan")).toEqual({ edit: plan, write: plan, bash: plan });
    expect(table("yolo")).toEqual({ edit: "allow", write: "allow", bash: "allow" });
  });

  it("asks for protected paths even in acceptEdits", () => {
    for (const path of [
      ".git/hooks/pre-commit",
      "package.json",
      "packages/x/package.json",
      "lefthook.yml",
      "AGENTS.md",
      "CLAUDE.md",
      ".orx/commands/deploy.md",
    ]) {
      expect(isProtectedPath(path), path).toBe(true);
      expect(decide("acceptEdits", edit(path), none), path).toBe("ask");
    }
    expect(isProtectedPath("src/package.ts")).toBe(false);
    expect(isProtectedPath(".orx/data/x.json")).toBe(false);
  });

  it("allows reads, except secret-shaped paths, which ask in every mode but yolo", () => {
    expect(decide("default", read("src/a.ts"), none)).toBe("allow");
    expect(decide("plan", read("src/a.ts"), none)).toBe("allow");
    for (const path of [".env", ".env.local", "certs/server.pem", "tls.key", "id_ed25519"]) {
      for (const mode of ["default", "acceptEdits", "plan"] as const) {
        expect(decide(mode, read(path), none), `${mode} ${path}`).toBe("ask");
      }
    }
    expect(decide("acceptEdits", edit(".env"), none)).toBe("ask");
  });

  it("allows a bash command the session always-allowed, exactly", () => {
    const allowed = new Set(["bun run test"]);
    expect(decide("default", bash("bun run test"), allowed)).toBe("allow");
    expect(decide("default", bash("bun run test "), allowed)).toBe("ask");
    expect(decide("plan", bash("bun run test"), allowed)).toEqual({
      deny: "plan mode: describe the change instead",
    });
  });

  it("treats chaining, pipes, substitution, and redirects as compound", () => {
    for (const command of ["a; b", "a && b", "a | b", "echo $HOME", "echo `x`", "a > f", "a < f"]) {
      expect(isCompoundCommand(command), command).toBe(true);
    }
    expect(isCompoundCommand("bun run test -- tests/a.test.ts")).toBe(false);
  });
});

/** Runs `check` in the background, answers the request it publishes, and returns both. */
const askAndAnswer = (
  request: PermissionRequest,
  answer: "yes" | "always" | { no: string },
  mode: PermissionMode = "default",
) =>
  Effect.gen(function* () {
    const permissions = yield* Permissions;
    const fiber = yield* Effect.forkChild(permissions.check(request));
    const [event] = yield* Stream.runCollect(Stream.take(permissions.events, 1));
    if (event?.type !== "approval-request") throw new Error("expected an approval request");
    yield* permissions.answer(event.id, answer);
    const result = yield* Fiber.join(fiber);
    return { event, result, permissions };
  }).pipe(Effect.provide(Permissions.layer(mode)));

describe("Permissions", () => {
  it("publishes a request with the diff and waits for the answer", async () => {
    const { event, result } = await Effect.runPromise(
      askAndAnswer({ ...edit("a.ts"), diff: "--- a.ts\n+++ a.ts" }, "yes"),
    );
    expect(event).toMatchObject({
      type: "approval-request",
      tool: "edit",
      summary: "Edit a.ts",
      diff: "--- a.ts\n+++ a.ts",
      canAlways: true,
    });
    expect(result).toBe("allow");
  });

  it("returns a no with the user's note", async () => {
    const { result } = await Effect.runPromise(
      askAndAnswer(bash("rm -rf dist"), { no: "keep it" }),
    );
    expect(result).toEqual({ deny: "The user said no: keep it" });
  });

  it("switches to acceptEdits on 'always' for an edit", async () => {
    const mode = await Effect.runPromise(
      Effect.gen(function* () {
        const { permissions } = yield* askAndAnswer(edit("a.ts"), "always");
        return yield* permissions.mode;
      }),
    );
    expect(mode).toBe("acceptEdits");
  });

  it("remembers the exact command on 'always' for bash, and refuses it for compound commands", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const permissions = yield* Permissions;
        const answer = (request: PermissionRequest) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(permissions.check(request));
            const [event] = yield* Stream.runCollect(Stream.take(permissions.events, 1));
            if (event?.type !== "approval-request") throw new Error("expected a request");
            yield* permissions.answer(event.id, "always");
            yield* Fiber.join(fiber);
            return event.canAlways;
          });
        const simpleOffered = yield* answer(bash("bun run test"));
        const again = yield* permissions.check(bash("bun run test"));
        const compoundOffered = yield* answer(bash("bun run test && rm -rf /"));
        // "always" on a compound command counted as yes once: it still asks next time.
        const compoundAgain = yield* Effect.forkChild(
          permissions.check(bash("bun run test && rm -rf /")),
        );
        const [asked] = yield* Stream.runCollect(Stream.take(permissions.events, 1));
        yield* Fiber.interrupt(compoundAgain);
        return { simpleOffered, again, compoundOffered, askedAgain: asked?.type };
      }).pipe(Effect.provide(Permissions.layer("default"))),
    );
    expect(outcome).toEqual({
      simpleOffered: true,
      again: "allow",
      compoundOffered: false,
      askedAgain: "approval-request",
    });
  });

  it("cancelAll denies open requests and publishes their cancellation", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const permissions = yield* Permissions;
        const fiber = yield* Effect.forkChild(permissions.check(bash("make")));
        const [request] = yield* Stream.runCollect(Stream.take(permissions.events, 1));
        const ids = yield* permissions.cancelAll;
        const [cancelled] = yield* Stream.runCollect(Stream.take(permissions.events, 1));
        return { request, ids, cancelled, result: yield* Fiber.join(fiber) };
      }).pipe(Effect.provide(Permissions.layer("default"))),
    );
    expect(outcome.ids).toEqual([
      outcome.request?.type === "approval-request" && outcome.request.id,
    ]);
    expect(outcome.cancelled).toEqual({ type: "approval-cancelled", id: outcome.ids[0] });
    expect(outcome.result).toEqual({ deny: "The user said no: interrupted" });
  });

  it("denies what would ask when headless, and allows the rest", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const permissions = yield* Permissions;
        return [yield* permissions.check(bash("ls")), yield* permissions.check(read("src/a.ts"))];
      }).pipe(Effect.provide(Permissions.layerHeadless("default"))),
    );
    expect(results[0]).toEqual({
      deny: expect.stringContaining("bash needs an interactive session"),
    });
    expect(results[1]).toBe("allow");
  });
});
