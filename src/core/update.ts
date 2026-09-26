import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { Effect, FileSystem, type PlatformError } from "effect";
import { BadInput, PermissionDenied, UpstreamUnavailable } from "../errors";
import { Host } from "../services/Host";
import { type Release, Releases } from "../services/Releases";
import { VERSION } from "../version";

/** -1, 0, or 1 for `a` older, equal, or newer than `b` (plain x.y.z; a pre-release sorts first). */
export const compareVersions = (a: string, b: string): number => {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
};

/** The release asset for this platform, as build.ts names it. */
export const assetName = (platform: string, arch: string) => `orx-${platform}-${arch}`;

export interface UpdateCheck {
  readonly current: string;
  readonly latest: string;
  readonly newer: boolean;
}

export const checkForUpdate = Effect.gen(function* () {
  const release = yield* (yield* Releases).latest;
  const latest = release.tag_name.replace(/^v/, "");
  const check: UpdateCheck = {
    current: VERSION,
    latest,
    newer: compareVersions(latest, VERSION) > 0,
  };
  return { check, release };
});

/** The expected SHA-256 for `name` from a SHA256SUMS file (`<hex>  <name>` lines). */
export const checksumFor = (sums: string, name: string): string | undefined =>
  sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file?.replace(/^\*/, "") === name)?.[0];

const denied = (target: string) => (error: PlatformError.PlatformError) =>
  error.reason._tag === "PermissionDenied"
    ? new PermissionDenied({
        message: `Can't replace ${target}: permission denied. Reinstall into a directory you own (install.sh defaults to ~/.local/bin), or run the update with the permissions that installed it.`,
      })
    : error;

/**
 * Replaces the running binary with the release's: downloads the asset for this platform,
 * checks it against SHA256SUMS, writes it next to the binary (a rename across filesystems
 * fails), and renames it over the old one. Never written in place: macOS kills a signed binary
 * that changes under it, and a running binary keeps its inode through a rename.
 */
export const applyUpdate = (release: Release) =>
  Effect.gen(function* () {
    const host = yield* Host;
    if (!host.compiled) {
      return yield* new BadInput({
        message: "orx is running from source; update the checkout (git pull) instead.",
      });
    }
    const releases = yield* Releases;
    const fs = yield* FileSystem.FileSystem;
    const name = assetName(host.platform, host.arch);
    const asset = release.assets.find((a) => a.name === name);
    const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS");
    if (!asset || !sumsAsset) {
      return yield* new UpstreamUnavailable({
        message: `Release ${release.tag_name} has no ${asset ? "SHA256SUMS" : name} asset.`,
        retryable: false,
      });
    }
    const sums = new TextDecoder().decode(yield* releases.download(sumsAsset.browser_download_url));
    const expected = checksumFor(sums, name);
    const bytes = yield* releases.download(asset.browser_download_url);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (expected === undefined || expected !== actual) {
      return yield* new UpstreamUnavailable({
        message: `The downloaded ${name} doesn't match SHA256SUMS; nothing was changed.`,
        retryable: true,
        detail: `expected ${expected ?? "(missing)"}, got ${actual}`,
      });
    }
    const target = host.execPath;
    const temp = join(dirname(target), `.${basename(target)}.update-${process.pid}`);
    yield* fs.writeFile(temp, bytes).pipe(Effect.mapError(denied(target)));
    yield* fs.chmod(temp, 0o755).pipe(
      Effect.andThen(fs.rename(temp, target)),
      Effect.mapError(denied(target)),
      Effect.onError(() => fs.remove(temp).pipe(Effect.ignore)),
    );
    yield* Effect.logInfo("updated", { from: VERSION, to: release.tag_name, path: target });
  }).pipe(
    Effect.catchIf(
      (error): error is PlatformError.PlatformError => error._tag === "PlatformError",
      (error) => Effect.die(error),
    ),
  );
