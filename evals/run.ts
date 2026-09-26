/**
 * `bun run eval [--models a,b,c]`: runs every case in evals/cases.ts against each model
 * (default OPENROUTER_MODEL), one call at a time, through orx's own programs: `runTurn` for
 * chat cases (the same prompts, tools, and limits as `orx ask`) and `extractContact` for
 * extract cases. Prints a table and a line per model, writes evals/results/<timestamp>.json,
 * and exits non-zero if any case failed or errored, or none passed. Calls the real API, so it
 * needs a key and costs money (about $0.001 for two cheap models with the default cases).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Cause, Effect, Exit, ManagedRuntime, Option, Stream } from "effect";
import { loadConfig } from "~/config";
import { runTurn } from "~/core/chat";
import { extractContact } from "~/core/extract";
import { UpstreamUnavailable } from "~/errors";
import { makeScriptLayer, type ScriptServices } from "../scripts/lib/script-layer";
import { cases, type EvalCase } from "./cases";
import {
  type CaseRun,
  formatModelSummaries,
  formatTable,
  type ScoredRun,
  score,
  summarize,
  summarizeByModel,
} from "./score";

/** Everything a CaseRun records except which model and case it was and how long it took. */
type Result = Omit<CaseRun, "model" | "caseId" | "latencyMs" | "error">;

/**
 * A chat turn the way `orx ask` makes one (tools run, up to MAX_TOOL_STEPS), read from its
 * `finish` event. runTurn bounds it by MAX_STREAM_SECONDS, so a hung case can't stall the run.
 */
const runChat = (modelId: string, input: string) =>
  Effect.gen(function* () {
    const finish = yield* runTurn({ history: [{ role: "user", text: input }], modelId }).pipe(
      Stream.filter((event) => event.type === "finish"),
      Stream.runLast,
    );
    if (Option.isNone(finish)) return yield* Effect.die("the turn ended without a finish event");
    const { reply } = finish.value;
    return {
      outcome: {
        text: reply.text,
        toolCalls: reply.tools.map(({ name, input }) => ({ name, input })),
      },
      finishReason: reply.finishReason,
      inputTokens: reply.usage?.inputTokens,
      outputTokens: reply.usage?.outputTokens,
      cost: reply.usage?.cost,
      provider: reply.provider,
      servedModel: reply.model,
    } satisfies Result;
  });

/**
 * Extract has its own timeout and retries (src/core/extract.ts). Its result carries tokens,
 * cost, and the served model; no provider (the chat path has none either, see AGENTS.md).
 */
const runExtract = (modelId: string, input: string) =>
  extractContact(input, modelId).pipe(
    Effect.map(
      (result) =>
        ({
          outcome: { text: "", toolCalls: [], contact: result.contact },
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cost: result.usage.cost,
          servedModel: result.model,
        }) satisfies Result,
    ),
  );

const runtime = ManagedRuntime.make(makeScriptLayer());
const config = await runtime.runPromise(loadConfig);
if (Option.isNone(config.apiKey)) {
  console.error("OPENROUTER_API_KEY is empty. Evals call the real API: set it in .env first.");
  process.exit(1);
}

const { values } = parseArgs({ options: { models: { type: "string" } } });
const models = values.models
  ?.split(",")
  .map((model) => model.trim())
  .filter((model) => model !== "") ?? [config.defaultModel];

/**
 * The underlying cause, not the user-facing message: UpstreamUnavailable carries the upstream
 * status and reason in `detail`.
 */
const describeError = (error: unknown): string => {
  if (error instanceof UpstreamUnavailable) return error.detail ?? error.message;
  return error instanceof Error ? error.message : String(error);
};

const runCase = async (model: string, evalCase: EvalCase): Promise<ScoredRun> => {
  const program: Effect.Effect<Result, unknown, ScriptServices> =
    evalCase.kind === "chat" ? runChat(model, evalCase.input) : runExtract(model, evalCase.input);
  const startedAt = Date.now();
  const exit = await runtime.runPromiseExit(program);
  const base = { model, caseId: evalCase.id, latencyMs: Date.now() - startedAt };
  if (Exit.isFailure(exit)) {
    return score({ ...base, error: describeError(Cause.squash(exit.cause)) }, evalCase.check);
  }
  return score({ ...base, ...exit.value }, evalCase.check);
};

const startedAt = new Date();
const runs: ScoredRun[] = [];
for (const model of models) {
  for (const evalCase of cases) {
    process.stdout.write(`${model} ${evalCase.id} ... `);
    const run = await runCase(model, evalCase);
    console.log(run.verdict);
    runs.push(run);
  }
}
await runtime.dispose();

const summary = summarize(runs);
const byModel = summarizeByModel(runs);
console.log(`\n${formatTable(runs)}\n`);
console.log(`${formatModelSummaries(byModel)}\n`);
console.log(
  Object.entries(summary.counts)
    .map(([verdict, count]) => `${count} ${verdict}`)
    .join(", "),
);

const resultsDir = join(import.meta.dirname, "results");
mkdirSync(resultsDir, { recursive: true });
const file = join(resultsDir, `${startedAt.toISOString().replaceAll(":", "-")}.json`);
writeFileSync(file, `${JSON.stringify({ startedAt, models, summary, byModel, runs }, null, 2)}\n`);
console.log(`Wrote ${file}`);
process.exit(summary.ok ? 0 : 1);
