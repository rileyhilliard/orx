import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPty } from "../scripts/lib/pty";
import { type StubOpenRouter, startStubOpenRouter } from "../tests/helpers/stub-openrouter";
import { type StubReleases, sha256, startStubReleases } from "../tests/helpers/stub-releases";

// The compiled binary (`bun run e2e` builds dist/orx first), run the way users run it: as a
// process, with a clean env, against the stub OpenRouter and stub releases. Behavior belongs in
// tests/; this checks what only the real binary can show (the stdout contract through Bun's
// real stdio, the TUI in a real terminal, the embedded native library, install.sh).

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "dist", "orx");

let openRouter: StubOpenRouter;
let releases: StubReleases;
beforeAll(async () => {
  if (!existsSync(BIN))
    throw new Error("dist/orx is missing: run `bun run e2e`, which builds it first");
  openRouter = await startStubOpenRouter();
  releases = await startStubReleases();
});
afterAll(async () => {
  await openRouter.close();
  await releases.close();
});

/** An env built from scratch: nothing from this shell (or a .env) leaks in. */
const cleanEnv = (extra: Record<string, string> = {}) => {
  const home = mkdtempSync(join(tmpdir(), "orx-e2e-"));
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    ORX_DATA_DIR: join(home, "data"),
    OPENROUTER_API_KEY: "sk-or-e2e",
    OPENROUTER_MODEL: "openai/gpt-test",
    OPENROUTER_BASE_URL: openRouter.baseUrl,
    ORX_RELEASES_URL: releases.apiUrl,
    ORX_RELEASES_REPO: releases.repo,
    NO_COLOR: "1",
    ...extra,
  };
};

const run = async (
  args: string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
) => {
  const proc = Bun.spawn([BIN, ...args], {
    env: options.env ?? cleanEnv(),
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

describe("the binary's contract", () => {
  it("prints its version", async () => {
    const { stdout, exitCode } = await run(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^orx v\d+\.\d+\.\d+/);
  });

  it("keeps stdout empty on a usage error and exits 2", async () => {
    const { stdout, stderr, exitCode } = await run(["ask", "--bogus", "--json"]);
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({ error: { tag: "UsageError" } });
  });

  it("exits 3 without a key", async () => {
    const { stdout, exitCode } = await run(["ask", "hi"], {
      env: cleanEnv({ OPENROUTER_API_KEY: "" }),
    });
    expect(exitCode).toBe(3);
    expect(stdout).toBe("");
  });

  it("streams NDJSON for piped stdin", async () => {
    const { stdout, exitCode } = await run(["ask", "--json"], { stdin: "hi from a pipe\n" });
    expect(exitCode).toBe(0);
    const events = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
  });

  it("ignores a .env in the working directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orx-e2e-cwd-"));
    await Bun.write(join(cwd, ".env"), "OPENROUTER_API_KEY=sk-or-from-dotenv\n");
    const proc = Bun.spawn([BIN, "doctor", "--json"], {
      cwd,
      env: cleanEnv({ OPENROUTER_API_KEY: "" }),
      stdout: "pipe",
    });
    const report = JSON.parse(await new Response(proc.stdout).text()) as { apiKey: string };
    expect(report.apiKey).toBe("unset");
  });

  it("loads the embedded OpenTUI native library", async () => {
    const { stdout, exitCode } = await run(["doctor", "--tui", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ compiled: true, tui: { nativeLib: true } });
  });
});

describe("orx (TUI session)", () => {
  it("starts in acceptEdits, streams a reply, shows usage, and quits on Ctrl+C with exit 0", async () => {
    const pty = spawnPty([BIN], { cols: 90, rows: 20, env: cleanEnv() });
    // Edits apply without asking by default; commands and protected paths still ask.
    await pty.waitFor((s) => s.includes("Ctrl+C quit") && /acceptEdits\s*$/m.test(s));
    pty.write("hi");
    await pty.waitFor((s) => /\bhi\b/.test(s));
    pty.write("\r");
    const screen = await pty.waitFor((s) => s.includes("12 in / 5 out"));
    expect(screen).toContain("> hi");
    expect(screen).toContain("Hello from the stub.");
    pty.write("\x03");
    expect(await pty.exited).toBe(0);
    // The terminal is handed back: the alternate screen was left.
    expect(pty.output()).toContain("\x1b[?1049l");
  });
});

describe("install.sh and orx update", () => {
  const assetName = `orx-${process.platform}-${process.arch}`;

  it("installs the release binary after checking SHA256SUMS", async () => {
    releases.release = { tag: "v9.9.9", assets: [{ name: assetName, body: readFileSync(BIN) }] };
    const env = cleanEnv();
    const dir = join(env.HOME, "bin");
    const proc = Bun.spawn(["bash", join(ROOT, "install.sh")], {
      env: { ...env, ORX_INSTALL_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(sha256(readFileSync(join(dir, "orx")))).toBe(sha256(readFileSync(BIN)));
  });

  it("install.sh refuses a checksum mismatch", async () => {
    releases.release = {
      tag: "v9.9.9",
      assets: [{ name: assetName, body: "x" }],
      sums: `${"0".repeat(64)}  ${assetName}`,
    };
    const env = cleanEnv();
    const dir = join(env.HOME, "bin");
    const proc = Bun.spawn(["bash", join(ROOT, "install.sh")], {
      env: { ...env, ORX_INSTALL_DIR: dir },
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    expect(existsSync(join(dir, "orx"))).toBe(false);
  });

  it("update swaps the running binary for the release's, which then runs", async () => {
    releases.release = { tag: "v9.9.9", assets: [{ name: assetName, body: readFileSync(BIN) }] };
    const dir = mkdtempSync(join(tmpdir(), "orx-e2e-update-"));
    const installed = join(dir, "orx");
    copyFileSync(BIN, installed);
    chmodSync(installed, 0o755);
    const before = statSync(installed).ino;
    const proc = Bun.spawn([installed, "update"], { env: cleanEnv(), stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    // Renamed over, not written in place: a new inode, and the new binary starts.
    expect(statSync(installed).ino).not.toBe(before);
    expect(statSync(installed).mode & 0o777).toBe(0o755);
    const version = Bun.spawn([installed, "--version"], { env: cleanEnv(), stdout: "pipe" });
    expect(await version.exited).toBe(0);
  });

  it("update --check sees a newer release", async () => {
    releases.release = { tag: "v9.9.9", assets: [] };
    const { stdout, exitCode } = await run(["update", "--check", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ latest: "9.9.9", newer: true });
  });
});
