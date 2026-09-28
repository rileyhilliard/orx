import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Fixture, makeFixture, runHook } from "../helpers/hooks";

// Each test spawns the hook (and biome, tsc, or git), so it gets more than the default 5 s.
const TIMEOUT = 30_000;

const UGLY = "export const  a=1\n";
const PRETTY = "export const a = 1;\n";

let project: Fixture;
let tmp: string;

beforeEach(() => {
  project = makeFixture();
  writeFileSync(join(project.dir, "biome.json"), "{}\n");
  tmp = mkdtempSync(join(tmpdir(), "orx-hook-tmp-"));
});
afterEach(() => {
  project.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ CLAUDE_PROJECT_DIR: project.dir, TMPDIR: tmp });
const listFile = (session: string) => join(tmp, "orx-hooks", `${session}.files`);

const recordWrite = (filePath: string, session: string) =>
  runHook(
    "PostToolUse",
    "lint-on-write",
    {
      session_id: session,
      tool_name: "Write",
      tool_input: { file_path: filePath },
      cwd: project.dir,
    },
    { env: env() },
  );

const stop = (session?: string) =>
  runHook(
    "Stop",
    "format-changed",
    { session_id: session, hook_event_name: "Stop", cwd: project.dir },
    { env: env() },
  );

describe("format-changed", () => {
  it(
    "formats the files lint-on-write recorded for the session, then clears the list",
    async () => {
      const file = join(project.dir, "ugly.ts");
      writeFileSync(file, UGLY);
      await recordWrite(file, "s1");
      expect(existsSync(listFile("s1"))).toBe(true);

      const result = await stop("s1");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(readFileSync(file, "utf8")).toBe(PRETTY);
      expect(existsSync(listFile("s1"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "leaves a listed file outside the project alone",
    async () => {
      const outside = makeFixture();
      try {
        writeFileSync(join(outside.dir, "biome.json"), "{}\n");
        const file = join(outside.real, "ugly.ts");
        writeFileSync(file, UGLY);
        mkdirSync(join(tmp, "orx-hooks"), { recursive: true });
        writeFileSync(listFile("s2"), `${file}\n`);

        expect((await stop("s2")).code).toBe(0);
        expect(readFileSync(file, "utf8")).toBe(UGLY);
      } finally {
        outside.cleanup();
      }
    },
    TIMEOUT,
  );

  it(
    "does nothing without a session id",
    async () => {
      const file = join(project.dir, "ugly.ts");
      writeFileSync(file, UGLY);
      await recordWrite(file, "s3");

      const result = await stop(undefined);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(readFileSync(file, "utf8")).toBe(UGLY);
      expect(existsSync(listFile("s3"))).toBe(true);
    },
    TIMEOUT,
  );
});
