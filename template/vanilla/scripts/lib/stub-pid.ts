// logs/stub.pid holds "<pid> <openrouter port> <releases port>" while scripts/stub-server.ts
// runs. Paths are relative to the repo root, which the scripts chdir to.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const STUB_PID_FILE = "logs/stub.pid";
export const STUB_REPO = "stub/orx";

export interface RunningStub {
  readonly pid: number;
  readonly openRouterPort: number;
  readonly releasesPort: number;
}

/** The running stub, if the pid file names a live scripts/stub-server.ts (not a reused pid). */
export const runningStub = (): RunningStub | undefined => {
  let text: string;
  try {
    text = readFileSync(STUB_PID_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const [pid, openRouterPort, releasesPort] = text.trim().split(/\s+/).map(Number);
  if (!pid || !openRouterPort || !releasesPort) return undefined;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return ps.stdout.includes("scripts/stub-server.ts")
    ? { pid, openRouterPort, releasesPort }
    : undefined;
};

/**
 * The env that points orx at the stub (no real key, no spend). The data and install dirs stay
 * inside this checkout (.orx/), so `./dist/orx` and install.sh driven through the stub never
 * touch the user's real data or ~/.local/bin/orx.
 */
export const stubEnv = (stub: RunningStub) => ({
  ORX_DATA_DIR: resolve(".orx/data"),
  ORX_INSTALL_DIR: resolve(".orx/bin"),
  OPENROUTER_API_KEY: "sk-or-stub",
  OPENROUTER_BASE_URL: `http://127.0.0.1:${stub.openRouterPort}/api/v1`,
  OPENROUTER_MODEL: "openai/gpt-test",
  ORX_RELEASES_URL: `http://127.0.0.1:${stub.releasesPort}`,
  ORX_RELEASES_REPO: STUB_REPO,
});
