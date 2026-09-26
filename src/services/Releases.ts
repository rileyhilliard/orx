import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { releasesConfig } from "../config";
import { InvalidConfig, UpstreamUnavailable } from "../errors";

/** A GitHub release as the API returns it (only what `update` uses). A trust boundary: decoded. */
export const Release = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
});
export type Release = typeof Release.Type;

export interface ReleasesShape {
  readonly latest: Effect.Effect<Release, UpstreamUnavailable | InvalidConfig>;
  readonly download: (url: string) => Effect.Effect<Uint8Array, UpstreamUnavailable>;
}

/** The releases API answers in well under this; a binary download gets longer (tens of MB). */
const API_TIMEOUT = Duration.seconds(30);
const DOWNLOAD_TIMEOUT = Duration.minutes(5);
const retrySchedule = Schedule.max([
  Schedule.exponential(Duration.millis(500)).pipe(Schedule.jittered),
  Schedule.recurs(2),
]);

/**
 * Only failures another try can fix are retryable: the network, a 429, a 5xx. A 404 (no
 * release yet, a wrong ORX_RELEASES_REPO) or a response that doesn't decode isn't.
 */
const isRetryable = (cause: unknown): boolean => {
  if (HttpClientError.isHttpClientError(cause)) {
    const status = cause.response?.status;
    return status === undefined || status === 429 || status >= 500;
  }
  return false;
};

const upstream = (message: string) => (cause: unknown) =>
  new UpstreamUnavailable({ message, retryable: isRetryable(cause), detail: String(cause) });

const make = Effect.gen(function* () {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const guard = <A, E>(effect: Effect.Effect<A, E>, message: string, timeout: Duration.Duration) =>
    effect.pipe(
      Effect.mapError(upstream(message)),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new UpstreamUnavailable({ message, retryable: true })),
      }),
      Effect.retry({ schedule: retrySchedule, while: (error) => error.retryable }),
    );
  return {
    latest: Effect.gen(function* () {
      const releases = yield* releasesConfig.pipe(
        Effect.mapError((error) => new InvalidConfig({ message: error.message })),
      );
      const request = HttpClientRequest.get(
        `${releases.apiUrl}/repos/${releases.repo}/releases/latest`,
      ).pipe(HttpClientRequest.setHeader("accept", "application/vnd.github+json"));
      return yield* guard(
        http.execute(request).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(Release)),
        ),
        `Couldn't read the latest release of ${releases.repo}.`,
        API_TIMEOUT,
      );
    }),
    download: (url) =>
      guard(
        http.get(url).pipe(
          Effect.flatMap((response) => response.arrayBuffer),
          Effect.map((buffer) => new Uint8Array(buffer)),
        ),
        `Couldn't download ${url}.`,
        DOWNLOAD_TIMEOUT,
      ),
  } satisfies ReleasesShape;
});

/** GitHub Releases, for `orx update`. */
export class Releases extends Context.Service<Releases, ReleasesShape>()("orx/Releases") {
  static readonly layer = Layer.effect(Releases, make);
}
