import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { AppConfig, Paths } from "~/config";
import { MODELS_FAILURE_TTL, OpenRouterModels } from "~/services/OpenRouterModels";
import { runTest } from "./helpers/effect";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

// The models list service on the TestClock against the stub: what it caches, for how long,
// and which failures it retries.

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());
afterEach(() => {
  stub.modelsRequests = 0;
  stub.failModels = 0;
  stub.failModelsStatus = 500;
});

/** A fresh service (an empty cache) over the stub. */
const fresh = () => {
  const home = mkdtempSync(join(tmpdir(), "orx-models-"));
  const env = ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        OPENROUTER_BASE_URL: stub.baseUrl,
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        ORX_DATA_DIR: join(home, "data"),
      },
    }),
  );
  return Effect.provide(
    OpenRouterModels.layer.pipe(
      Layer.provide(AppConfig.layer),
      Layer.provide(Paths.layer),
      Layer.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
      Layer.provide(env),
    ),
  );
};

const list = Effect.flatMap(OpenRouterModels, (models) => models.list);

/** What the list fails with (UpstreamUnavailable; bad config would be a bug here). */
const failure = list.pipe(Effect.catchTag("InvalidConfig", Effect.die), Effect.flip);

/**
 * Runs `effect` while moving the TestClock in small steps, with real time in between for the
 * stub to answer: the retries' backoff passes, and no request is in flight long enough (in
 * test time) to reach the fetch timeout.
 */
const withClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    while (fiber.pollUnsafe() === undefined) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
      yield* TestClock.adjust("100 millis");
    }
    return yield* Fiber.join(fiber);
  });

describe("OpenRouterModels", () => {
  it("keeps the list for the cache TTL, then fetches it again", () =>
    runTest(
      Effect.gen(function* () {
        yield* list;
        yield* list;
        expect(stub.modelsRequests).toBe(1);
        yield* TestClock.adjust("10 minutes");
        yield* list;
        expect(stub.modelsRequests).toBe(2);
      }).pipe(fresh()),
    ));

  it("keeps a failure for MODELS_FAILURE_TTL, so callers don't each wait on it", () =>
    runTest(
      Effect.gen(function* () {
        stub.failModels = 1;
        stub.failModelsStatus = 404;
        const first = yield* failure;
        expect(first.retryable).toBe(false);
        expect(first.detail).toContain("404");
        const second = yield* failure;
        expect(second).toBe(first);
        expect(stub.modelsRequests).toBe(1);
        yield* TestClock.adjust(MODELS_FAILURE_TTL);
        const models = yield* list;
        expect(models.length).toBeGreaterThan(0);
        expect(stub.modelsRequests).toBe(2);
      }).pipe(fresh()),
    ));

  it("shares one fetch between concurrent callers", () =>
    runTest(
      Effect.gen(function* () {
        const lists = yield* Effect.all([list, list, list], { concurrency: "unbounded" });
        expect(lists[1]).toBe(lists[0]);
        expect(stub.modelsRequests).toBe(1);
      }).pipe(fresh()),
    ));

  it("retries a 5xx and a 429, but not another 4xx", () =>
    runTest(
      Effect.gen(function* () {
        for (const [status, requests] of [
          [500, 3],
          [429, 3],
          [400, 1],
          [404, 1],
        ] as const) {
          stub.modelsRequests = 0;
          stub.failModels = 3;
          stub.failModelsStatus = status;
          const error = yield* withClock(failure.pipe(fresh()));
          expect({ status, retryable: error.retryable }).toEqual({
            status,
            retryable: status >= 500 || status === 429,
          });
          expect({ status, requests: stub.modelsRequests }).toEqual({ status, requests });
        }
      }),
    ));
});
