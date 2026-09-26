---
description: Add an Effect AI tool the chat model can call (and orx mcp serves), with its schema and tests
argument-hint: "<what the tool does>"
---

Add a tool: $ARGUMENTS

Follow `.claude/rules/src/effect-ai.md`. Look at `CurrentTime` in `src/tools/index.ts` first and match its shape; `ExtractContact` in `src/tools/mcp.ts` shows a tool whose failure is returned to the caller.

1. **Schema** in `src/schemas/tools.ts`: the parameters as a `Schema.Struct` and the success value, with `description` (and `examples`) annotations on the fields (the model reads these to decide when and how to call the tool). Annotate before any `.check(...)`; a custom `Schema.makeFilter` contributes nothing to the JSON Schema, so put what the model should know in the description (`TimeZone` shows the annotate-then-check order). No `identifier` annotation.
2. **Tool** in `src/tools/index.ts` (or its own file there): `Tool.make("<name>", { description, parameters, success })`. Add `failureMode: "return"` if the model should see a failure and carry on, rather than the turn failing (`CurrentTime` does, for input that doesn't decode), plus a `failure` schema if the handler itself can fail. Print `Tool.getJsonSchema(tool)` and read it before a model sees it: objects are open (`additionalProperties: true`), and `Tool.Strict` only sets the `strict` flag in the request, not the schema.
3. **Register it** in `ChatTools = Toolkit.make(CurrentTime, <New>)` and give it a handler in `ChatToolsLive = ChatTools.toLayer({ ..., <name>: (params) => Effect... })`. The handler gets services from the context (`Clock`, `ChatStore`), never by providing a layer. `McpTools` in `src/tools/mcp.ts` is `Toolkit.merge(ChatTools, ...)` and `McpToolsLive` includes `ChatToolsLive`, so `orx mcp` serves it with no change there; a tool for MCP only goes in `mcp.ts` instead.
4. **Render**: `orx ask` prints tool calls as a note and emits `tool-call`/`tool-result` events with `--json`; the TUI shows the call from the bridge's `tool` event. Check both show something sensible for its input; a new display needs a change in `src/tui/message-list.tsx` (and `DESIGN.md`).
5. **Prompt**: if the model should prefer the tool over guessing, add a line to `DEFAULT_SYSTEM_PROMPT` in `src/config.ts`.
6. **Tests.**
   - the handler for valid input, invalid input (the parameters schema rejects it), and any failure it can hit, with `TestClock` if it reads time
   - its JSON Schema, pinned exactly
   - a turn where the model calls it: the stub OpenRouter streams a tool call (push `{ name, arguments }` onto `stub.toolCalls`), and `orx ask --json` shows the `tool-call`, the `tool-result`, and the follow-up step's text
   - `orx mcp`: `tools/list` includes it and `tools/call` returns its result (`tests/mcp.test.ts`)
7. `/check`.

If the tool calls a third-party API, add its base URL to Config (with an unreachable default in `tests/isolation.ts`) and point tests at a local stub server. Tests never hit the network.
