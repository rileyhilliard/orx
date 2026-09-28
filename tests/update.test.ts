import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "~/core/update";
import { runCli, tempRoot } from "./helpers/cli";
import { type StubReleases, startStubReleases } from "./helpers/stub-releases";

let releases: StubReleases;
beforeAll(async () => {
  releases = await startStubReleases();
});
afterAll(() => releases.close());
beforeEach(() => {
  releases.failLatest = undefined;
  releases.latestRequests = 0;
  releases.release = { tag: "v9.0.0", assets: [{ name: "orx-linux-x64", body: "new binary" }] };
});

const env = () => ({ ORX_RELEASES_URL: releases.apiUrl, ORX_RELEASES_REPO: releases.repo });

/** An installed binary in a temp dir, as the running orx. */
const installed = () => {
  const root = tempRoot();
  mkdirSync(join(root, "bin"));
  const execPath = join(root, "bin", "orx");
  writeFileSync(execPath, "old binary", { mode: 0o755 });
  return { root, execPath };
};

describe("compareVersions", () => {
  it("orders x.y.z and pre-releases", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
  });
});

describe("orx update", () => {
  it("--check reports a newer release without downloading", async () => {
    const run = await runCli(["update", "--check", "--json"], { env: env() });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ latest: "9.0.0", newer: true });
    expect(releases.downloads).toEqual([]);
  });

  it("replaces the binary after checking SHA256SUMS", async () => {
    const { root, execPath } = installed();
    const run = await runCli(["update"], { root, env: env(), host: { compiled: true, execPath } });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(execPath, "utf8")).toBe("new binary");
    expect(statSync(execPath).mode & 0o777).toBe(0o755);
  });

  it("changes nothing when the checksum doesn't match", async () => {
    releases.release = { ...releases.release, sums: `${"0".repeat(64)}  orx-linux-x64` };
    const { root, execPath } = installed();
    const run = await runCli(["update"], { root, env: env(), host: { compiled: true, execPath } });
    expect(run.exitCode).toBe(4);
    expect(run.stderr).toContain("SHA256SUMS");
    expect(readFileSync(execPath, "utf8")).toBe("old binary");
  });

  it("refuses to run from source", async () => {
    const run = await runCli(["update"], { env: env() });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("source");
  });

  it("exits 4 when GitHub is unreachable", async () => {
    releases.failLatest = 503;
    const run = await runCli(["update", "--check"], { env: env() });
    expect(run.exitCode).toBe(4);
  });

  it("doesn't retry a 404, and says a retry won't help", async () => {
    releases.failLatest = 404;
    const run = await runCli(["update", "--check", "--json"], { env: env() });
    expect(run.exitCode).toBe(4);
    expect(releases.latestRequests).toBe(1);
    expect(JSON.parse(run.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
      error: { tag: "UpstreamUnavailable", retryable: false },
    });
  });

  it("retries a 5xx before giving up", async () => {
    releases.failLatest = 503;
    await runCli(["update", "--check"], { env: env() });
    expect(releases.latestRequests).toBe(3);
  });

  it("exits 6 when the binary's directory isn't writable, and changes nothing", async () => {
    const { root, execPath } = installed();
    chmodSync(join(root, "bin"), 0o555);
    try {
      const run = await runCli(["update"], {
        root,
        env: env(),
        host: { compiled: true, execPath },
      });
      expect(run.exitCode).toBe(6);
      expect(run.stderr).toContain("permission denied");
      expect(readFileSync(execPath, "utf8")).toBe("old binary");
    } finally {
      chmodSync(join(root, "bin"), 0o755);
    }
  });

  it("works with a broken config file", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "config", "orx"), { recursive: true });
    writeFileSync(join(root, "config", "orx", "config.json"), "{ nope");
    const run = await runCli(["update", "--check"], { root, env: env() });
    expect(run.exitCode).toBe(0);
  });
});
