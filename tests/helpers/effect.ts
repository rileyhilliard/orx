// Running an Effect test body under bun test, the way @effect/vitest's `it.effect` did.
import { Effect, Layer, type Scope } from "effect";
import { TestClock, TestConsole } from "effect/testing";

/**
 * Runs `effect` with a fresh Scope, the TestClock (it starts at 0 and moves only on
 * `TestClock.adjust`), and the TestConsole (the default logger prints nothing). Resolves with the
 * result; a failure or a thrown `expect` rejects, which fails the test.
 */
export const runTest = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(TestConsole.layer, TestClock.layer())),
    ),
  );
