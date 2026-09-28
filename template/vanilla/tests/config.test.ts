import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli, tempRoot } from "./helpers/cli";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());

const withConfigFile = (contents: unknown) => {
  const root = tempRoot();
  mkdirSync(join(root, "config", "orx"), { recursive: true });
  writeFileSync(
    join(root, "config", "orx", "config.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
  return root;
};

const lastRequest = () => stub.chatRequests.at(-1) as Record<string, unknown>;

describe("config file", () => {
  it("supplies defaults the env doesn't set", async () => {
    const root = withConfigFile({ model: "acme/cheap-model", maxOutputTokens: 77 });
    const run = await runCli(["ask", "hi"], {
      root,
      env: { OPENROUTER_BASE_URL: stub.baseUrl, OPENROUTER_MODEL: "" },
    });
    expect(run.exitCode).toBe(0);
    expect(lastRequest()).toMatchObject({ model: "acme/cheap-model", max_tokens: 77 });
  });

  it("loses to the env", async () => {
    const root = withConfigFile({ model: "acme/cheap-model" });
    await runCli(["ask", "hi"], { root, env: { OPENROUTER_BASE_URL: stub.baseUrl } });
    expect(lastRequest()).toMatchObject({ model: "openai/gpt-test" });
  });

  it("rejects an apiKey, so a key in a file never reaches a request", async () => {
    stub.chatRequests.length = 0;
    const root = withConfigFile({ apiKey: "sk-or-from-file" });
    const run = await runCli(["ask", "hi"], {
      root,
      env: { OPENROUTER_BASE_URL: stub.baseUrl, OPENROUTER_API_KEY: "" },
    });
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain("config.json");
    expect(stub.chatRequests).toHaveLength(0);
    expect(JSON.stringify(run.logs)).not.toContain("sk-or-from-file");
  });

  it("names the file and the key when a value is wrong, and exits 3", async () => {
    const root = withConfigFile({ maxOutputTokens: 0 });
    const run = await runCli(["ask", "hi"], { root, env: { OPENROUTER_BASE_URL: stub.baseUrl } });
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain("config.json");
    expect(run.stderr).toContain("maxOutputTokens");
  });

  it("doesn't break --help, --version, or doctor when it's broken", async () => {
    const root = withConfigFile("{ not json");
    expect((await runCli(["--help"], { root })).exitCode).toBe(0);
    expect((await runCli(["--version"], { root })).exitCode).toBe(0);
    const doctor = await runCli(["doctor", "--json"], { root });
    expect(doctor.exitCode).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ configFileExists: true, apiKey: "unknown" });
    expect((JSON.parse(doctor.stdout) as { configError: string }).configError).toContain(
      "config.json",
    );
  });
});

describe("env", () => {
  it("treats an empty value as unset", async () => {
    const run = await runCli(["ask", "hi"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl, OPENROUTER_MODEL: "", MAX_OUTPUT_TOKENS: "" },
    });
    expect(run.exitCode).toBe(0);
    expect(lastRequest()).toMatchObject({ model: "openai/gpt-6-luna", max_tokens: 1024 });
  });

  it("exits 3 on a bad value and names the variable", async () => {
    const run = await runCli(["ask", "hi"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl, MAX_OUTPUT_TOKENS: "lots" },
    });
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain("MAX_OUTPUT_TOKENS");
  });

  it("never logs the key", async () => {
    const run = await runCli(["ask", "hi"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl, OPENROUTER_API_KEY: "sk-or-very-secret" },
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.stringify(run.logs) + run.stderr + run.stdout).not.toContain("sk-or-very-secret");
  });
});
