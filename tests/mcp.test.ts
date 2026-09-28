import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect, Sink, Stdio, Stream } from "effect";
import { drainingStdio } from "~/core/mcp-stdio";
import { ndjson, runCli } from "./helpers/cli";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());

const rpc = (...messages: unknown[]) => `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

describe("orx mcp", () => {
  it("answers initialize and tools/list with only JSON-RPC on stdout", async () => {
    const run = await runCli(["mcp"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
      stdin: rpc(
        initialize,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ),
    });
    expect(run.exitCode).toBe(0);
    const frames = ndjson(run.stdout);
    for (const frame of frames) expect(frame.jsonrpc).toBe("2.0");
    const list = frames.find((f) => f.id === 2) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name).sort()).toEqual(["currentTime", "extractContact"]);
  });

  it("calls a tool", async () => {
    const run = await runCli(["mcp"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
      stdin: rpc(initialize, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "currentTime", arguments: { timeZone: "Asia/Tokyo" } },
      }),
    });
    const call = ndjson(run.stdout).find((f) => f.id === 3) as { result: { isError?: boolean } };
    expect(call.result.isError ?? false).toBe(false);
    expect(JSON.stringify(call.result)).toContain("Asia/Tokyo");
  });

  it("returns an extract failure as a tool error, not a crash", async () => {
    const run = await runCli(["mcp"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl, OPENROUTER_API_KEY: "" },
      stdin: rpc(initialize, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "extractContact", arguments: { text: "Ada" } },
      }),
    });
    expect(run.exitCode).toBe(0);
    const call = ndjson(run.stdout).find((f) => f.id === 4) as { result: { isError?: boolean } };
    expect(call.result.isError).toBe(true);
    expect(JSON.stringify(call.result)).toContain("NotConfigured");
  });
});

describe("drainingStdio", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const drain = (lines: string) =>
    Effect.runPromise(
      Stream.runDrain(
        drainingStdio(
          Stdio.make({
            args: Effect.succeed([]),
            stdin: Stream.make(encode(lines)),
            stdout: () => Sink.drain,
            stderr: () => Sink.drain,
          }),
        ).stdin,
      ).pipe(Effect.timeout("2 seconds")),
    );

  it("stops waiting for a request the client cancelled", async () => {
    await drain(
      rpc(
        { jsonrpc: "2.0", id: 9, method: "tools/call", params: {} },
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } },
      ),
    );
  });

  it("doesn't wait on notifications, which get no response", async () => {
    await drain(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }));
  });
});
