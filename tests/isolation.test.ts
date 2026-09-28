import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLEARED } from "./isolation";

// The preload is what keeps a developer's .env out of the tests (bun loads it before any test
// code runs), so it has to cover every variable config reads.
describe("test isolation", () => {
  it("clears or sets every variable src/config.ts reads", () => {
    const source = readFileSync(join(import.meta.dir, "../src/config.ts"), "utf8");
    const read = new Set(source.match(/"[A-Z][A-Z0-9_]{2,}"/g)?.map((name) => name.slice(1, -1)));
    const set = [
      "OPENROUTER_API_KEY",
      "OPENROUTER_BASE_URL",
      "ORX_RELEASES_URL",
      "XDG_CONFIG_HOME",
      "ORX_DATA_DIR",
      "ORX_LOG_FILE",
      "HOME",
    ];
    const covered = new Set<string>([...CLEARED, ...set]);
    expect([...read].filter((name) => !covered.has(name))).toEqual([]);
    expect(read.has("MAX_TOOL_STEPS")).toBe(true);
  });

  it("leaves none of them from the environment the run started with", () => {
    for (const name of CLEARED) expect(process.env[name]).toBeUndefined();
  });
});
