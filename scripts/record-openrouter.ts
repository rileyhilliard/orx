/**
 * Records real OpenRouter stream bodies as test fixtures (tests/fixtures/openrouter/), which
 * the stub server replays (`stub.replay([...])` in tests/helpers/stub-openrouter.ts). Needs a
 * key and costs a fraction of a cent: `bun run record:openrouter`.
 *
 * Two turns through orx's own `runTurn` (system prompt, step and output limits, OpenRouter
 * settings), on OPENROUTER_MODEL: a plain reply (plain.1.sse) and a tool turn with the tests'
 * `currentTime` tool (tests/helpers/tools.ts; tool.1.sse: the tool call, tool.2.sse: the
 * answer after the tool result), which the replay test offers again. The HTTP client
 * gets a fetch that tees each /chat/completions response, so a fixture is exactly the bytes
 * @effect/ai-openrouter's parser read. Only response bodies are written, never request
 * headers, so the key can't end up in a fixture. Nothing is written unless both turns end in
 * a "stop" with text and the tool turn called the tool (scripts/lib/recording.ts); a
 * successful run replaces every .sse file in the directory.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Stream } from "effect";
import { loadConfig } from "~/config";
import { runTurn } from "~/core/chat";
import { testToolkit } from "../tests/helpers/tools";
import { type RecordedTurn, recordingProblems } from "./lib/recording";
import { runScript, type ScriptFetch } from "./lib/script-layer";

const OUT_DIR = join(import.meta.dirname, "../tests/fixtures/openrouter");

/** Bodies of the /chat/completions responses since the last `takeBodies()`. */
let bodies: Promise<string>[] = [];

const teeFetch: ScriptFetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = input instanceof Request ? input.url : String(input);
  // An error response goes to the client untouched; the turn then fails with its message.
  if (!url.endsWith("/chat/completions") || !response.ok || response.body === null) {
    return response;
  }
  const [forClient, forFixture] = response.body.tee();
  bodies.push(new Response(forFixture).text());
  return new Response(forClient, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const takeBodies = async () => {
  const taken = await Promise.all(bodies);
  bodies = [];
  return taken;
};

/** One chat turn, streamed the way `orx ask` streams it; `tools` offers the test tool. */
const turn = (modelId: string, prompt: string, tools = false) =>
  Stream.runCollect(
    runTurn({
      history: [{ role: "user", text: prompt }],
      modelId,
      ...(tools ? { toolkit: testToolkit } : {}),
    }),
  );

const config = await runScript(loadConfig);
if (Option.isNone(config.apiKey)) {
  console.error("OPENROUTER_API_KEY is empty. Set it in .env (recording calls the real API).");
  process.exit(1);
}
const model = config.defaultModel;

console.log(`Recording against ${model}`);
const { plain, tool } = await runScript(
  Effect.gen(function* () {
    const plainEvents = yield* turn(model, "Reply with one short sentence about the sea.");
    const plain: RecordedTurn = { events: plainEvents, bodies: yield* Effect.promise(takeBodies) };
    const toolEvents = yield* turn(model, "What time is it in Tokyo?", true);
    const tool: RecordedTurn = { events: toolEvents, bodies: yield* Effect.promise(takeBodies) };
    return { plain, tool };
  }),
  { fetch: teeFetch },
);

const problems = recordingProblems(plain, tool);
if (problems.length > 0) {
  console.error(`Nothing written:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
// A previous recording can have more requests per turn; its extra files would linger.
for (const file of readdirSync(OUT_DIR).filter((name) => name.endsWith(".sse"))) {
  rmSync(join(OUT_DIR, file));
}
const files: Record<string, string> = {};
for (const [name, recordedTurn] of [
  ["plain", plain],
  ["tool", tool],
] as const) {
  recordedTurn.bodies.forEach((body, index) => {
    files[`${name}.${index + 1}.sse`] = body;
  });
}
for (const [file, body] of Object.entries(files)) {
  writeFileSync(join(OUT_DIR, file), body);
  console.log(`  ${file}  ${body.length} bytes`);
}
/** The model each turn's last step reports serving (a fallback shows up here). */
const servedBy = (recordedTurn: RecordedTurn) =>
  recordedTurn.events.flatMap((event) =>
    event.type === "finish" && event.reply.model !== undefined ? [event.reply.model] : [],
  );
// Flat, so the file is already in Biome's format.
const meta = {
  model,
  servedModels: [...new Set([...servedBy(plain), ...servedBy(tool)])].join(", "),
  recordedAt: new Date().toISOString(),
};
writeFileSync(join(OUT_DIR, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
console.log(`  meta.json  (served by ${meta.servedModels})`);
