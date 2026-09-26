/**
 * Turns eval runs into verdicts, a summary, and the printed table. Pure: no model calls,
 * so tests/evals.test.ts covers it with plain data.
 */
import type { Check, Outcome } from "./cases";

/** One case run against one model, as evals/run.ts records it. */
export interface CaseRun {
  readonly model: string;
  readonly caseId: string;
  readonly latencyMs: number;
  /** The model call itself failed (upstream error, output that didn't decode). */
  readonly error?: string;
  readonly outcome?: Outcome;
  readonly finishReason?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** USD, from OpenRouter's usage accounting. */
  readonly cost?: number;
  readonly provider?: string;
  /** The model id OpenRouter reports serving (differs from `model` after a fallback). */
  readonly servedModel?: string;
}

/**
 * `truncated`: the reply hit the output cap before producing any text. That's a limit
 * problem (MAX_OUTPUT_TOKENS, often spent on reasoning), not a wrong answer.
 */
export type Verdict = "pass" | "fail" | "truncated" | "error";

export interface ScoredRun extends CaseRun {
  readonly verdict: Verdict;
  /** Why it didn't pass. */
  readonly reason?: string;
}

export const score = (run: CaseRun, check: Check): ScoredRun => {
  if (run.error !== undefined || run.outcome === undefined) {
    return { ...run, verdict: "error", reason: run.error ?? "no outcome recorded" };
  }
  const { outcome } = run;
  if (run.finishReason === "length" && outcome.text.trim() === "" && !outcome.contact) {
    return { ...run, verdict: "truncated", reason: "hit the output cap before any text" };
  }
  const reason = check(outcome);
  return reason === undefined ? { ...run, verdict: "pass" } : { ...run, verdict: "fail", reason };
};

export interface Summary {
  readonly counts: Record<Verdict, number>;
  /**
   * False when any case failed or errored, or none passed (a run where every case was
   * truncated measured nothing); the runner exits non-zero.
   */
  readonly ok: boolean;
}

export const summarize = (runs: ReadonlyArray<ScoredRun>): Summary => {
  const counts: Record<Verdict, number> = { pass: 0, fail: 0, truncated: 0, error: 0 };
  for (const run of runs) counts[run.verdict] += 1;
  return { counts, ok: counts.pass > 0 && counts.fail === 0 && counts.error === 0 };
};

/** One model's results across every case. */
export interface ModelSummary {
  readonly model: string;
  readonly passed: number;
  readonly total: number;
  /** USD, summed over the runs that reported a cost; undefined when none did. */
  readonly cost?: number;
  readonly medianLatencyMs: number;
}

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** A rollup per model, in the order the models first appear in `runs`. */
export const summarizeByModel = (runs: ReadonlyArray<ScoredRun>): ModelSummary[] => {
  const byModel = new Map<string, ScoredRun[]>();
  for (const run of runs) byModel.set(run.model, [...(byModel.get(run.model) ?? []), run]);
  return [...byModel].map(([model, modelRuns]) => {
    const costs = modelRuns.flatMap((run) => (run.cost === undefined ? [] : [run.cost]));
    return {
      model,
      passed: modelRuns.filter((run) => run.verdict === "pass").length,
      total: modelRuns.length,
      ...(costs.length === 0 ? {} : { cost: costs.reduce((a, b) => a + b, 0) }),
      medianLatencyMs: median(modelRuns.map((run) => run.latencyMs)),
    };
  });
};

const dash = "-";
const tokens = (run: ScoredRun) =>
  run.inputTokens === undefined && run.outputTokens === undefined
    ? dash
    : `${run.inputTokens ?? "?"}/${run.outputTokens ?? "?"}`;
const usd = (value: number | undefined) => (value === undefined ? dash : `$${value.toFixed(6)}`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
/** Only a model other than the one requested (a fallback): OpenRouter normally echoes the id. */
const served = (run: ScoredRun) =>
  run.servedModel !== undefined && run.servedModel !== run.model ? run.servedModel : dash;

/** Pads every column to its widest cell, two spaces apart. */
const columns = (rows: ReadonlyArray<ReadonlyArray<string>>): string[] => {
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0)));
  return rows.map((cells) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd(),
  );
};

/** A plain-text table, one row per run, with each non-pass reason listed underneath. */
export const formatTable = (runs: ReadonlyArray<ScoredRun>): string => {
  const header = [
    "model",
    "case",
    "result",
    "finish",
    "latency",
    "tokens in/out",
    "cost",
    "provider",
    "served",
  ];
  const rows = runs.map((run) => [
    run.model,
    run.caseId,
    run.verdict,
    run.finishReason ?? dash,
    seconds(run.latencyMs),
    tokens(run),
    usd(run.cost),
    run.provider ?? dash,
    served(run),
  ]);
  const reasons = runs
    .filter((run) => run.reason !== undefined)
    .map((run) => `  ${run.model} ${run.caseId}: ${run.verdict}, ${run.reason}`);
  return [...columns([header, ...rows]), ...(reasons.length > 0 ? ["", ...reasons] : [])].join(
    "\n",
  );
};

/** One line per model: cases passed, total cost, median latency. */
export const formatModelSummaries = (summaries: ReadonlyArray<ModelSummary>): string =>
  columns(
    summaries.map((summary) => [
      summary.model,
      `${summary.passed}/${summary.total} passed`,
      usd(summary.cost),
      `median ${seconds(summary.medianLatencyMs)}`,
    ]),
  ).join("\n");
