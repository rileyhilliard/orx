import { Cause, Effect, Fiber, Layer, Stdio } from "effect";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { Command } from "effect/unstable/cli";
import { drainingStdio } from "../core/mcp-stdio";
import { McpTools, McpToolsLive } from "../tools/mcp";
import { VERSION } from "../version";

const serve = Layer.launch(
  McpServer.toolkit(McpTools).pipe(
    Layer.provide(McpToolsLive),
    Layer.provide(
      McpServer.layerStdio({
        name: "orx",
        version: VERSION,
        protocols: [
          McpProtocol.v2025_11_25,
          McpProtocol.v2025_06_18,
          McpProtocol.v2025_03_26,
          McpProtocol.v2024_11_05,
        ],
      }),
    ),
  ),
);

/**
 * An MCP server on stdin/stdout for agents (Claude Code: `claude mcp add orx -- orx mcp`).
 * stdout carries only JSON-RPC frames; logs go to stderr. Ends when stdin closes.
 */
export const mcp = Command.make("mcp", {}, () =>
  serve.pipe(
    Effect.provideServiceEffect(Stdio.Stdio, Effect.map(Stdio.Stdio, drainingStdio)),
    // The stdio transport interrupts the fiber that started it when stdin closes, so it runs
    // in a child fiber: a closed stdin is the normal end of a session (exit 0), not Ctrl+C.
    Effect.forkChild,
    Effect.flatMap(Fiber.await),
    Effect.flatMap((exit) =>
      exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)
        ? Effect.failCause(exit.cause)
        : Effect.logDebug("mcp stdin closed"),
    ),
  ),
).pipe(Command.withDescription("Serve orx's tools over MCP (stdio)"));
