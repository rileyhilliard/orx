// evals/score.ts and the case checks, on plain data. The runner (evals/run.ts) calls the real
// API, so it's exercised only by a manual `bun run eval`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CodingCase, cases, type Outcome } from "../evals/cases";
import {
  type CaseRun,
  formatModelSummaries,
  formatTable,
  score,
  summarize,
  summarizeByModel,
} from "../evals/score";

const caseById = (id: string) => {
  const found = cases.find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
};

const outcome = (overrides: Partial<Outcome> = {}): Outcome => ({
  text: "",
  toolCalls: [],
  ...overrides,
});

const run = (overrides: Partial<CaseRun> = {}): CaseRun => ({
  model: "acme/cheap-model",
  caseId: "tokyo-time",
  latencyMs: 1234,
  finishReason: "stop",
  ...overrides,
});

const tokyo = caseById("tokyo-time").check;

describe("score", () => {
  it("passes a run whose outcome satisfies the check", () => {
    const toolCalls = [{ name: "currentTime", input: { timeZone: "Asia/Tokyo" } }];
    expect(score(run({ outcome: outcome({ toolCalls }) }), tokyo)).toMatchObject({
      verdict: "pass",
    });
  });

  it("fails with the check's reason otherwise", () => {
    expect(score(run({ outcome: outcome({ text: "It's noon." }) }), tokyo)).toMatchObject({
      verdict: "fail",
      reason: "didn't call currentTime with Asia/Tokyo",
    });
  });

  it("reports an empty reply cut off by the output cap as truncated, not failed", () => {
    const scored = score(run({ finishReason: "length", outcome: outcome() }), tokyo);
    expect(scored.verdict).toBe("truncated");
  });

  it("still judges a reply that hit the cap after producing text", () => {
    const scored = score(
      run({ finishReason: "length", outcome: outcome({ text: "It is currently" }) }),
      tokyo,
    );
    expect(scored.verdict).toBe("fail");
  });

  it("reports a failed model call as an error with its message", () => {
    expect(score(run({ error: "The model failed to respond." }), tokyo)).toMatchObject({
      verdict: "error",
      reason: "The model failed to respond.",
    });
  });
});

describe("summarize", () => {
  const scored = (verdictRun: CaseRun) => score(verdictRun, tokyo);
  const pass = scored(
    run({
      outcome: outcome({
        toolCalls: [{ name: "currentTime", input: { timeZone: "Asia/Tokyo" } }],
      }),
    }),
  );
  const truncated = scored(run({ finishReason: "length", outcome: outcome() }));

  it("is ok with passes and truncations only", () => {
    expect(summarize([pass, truncated])).toEqual({
      counts: { pass: 1, fail: 0, truncated: 1, error: 0 },
      ok: true,
    });
  });

  it("is not ok once anything fails or errors", () => {
    expect(summarize([pass, scored(run({ outcome: outcome() }))]).ok).toBe(false);
    expect(summarize([pass, scored(run({ error: "boom" }))]).ok).toBe(false);
  });

  it("is not ok when nothing passed, even with no failures", () => {
    expect(summarize([truncated, truncated]).ok).toBe(false);
    expect(summarize([]).ok).toBe(false);
  });
});

describe("summarizeByModel", () => {
  const scoredRun = (overrides: Partial<CaseRun>) =>
    score(
      run({
        outcome: outcome({
          toolCalls: [{ name: "currentTime", input: { timeZone: "Asia/Tokyo" } }],
        }),
        ...overrides,
      }),
      tokyo,
    );

  it("rolls up passes, total cost, and median latency per model, in first-seen order", () => {
    const runs = [
      scoredRun({ model: "b/two", latencyMs: 3000, cost: 0.002 }),
      scoredRun({ model: "a/one", latencyMs: 1000, cost: 0.001 }),
      scoredRun({ model: "a/one", latencyMs: 5000, error: "boom" }),
      scoredRun({ model: "a/one", latencyMs: 2000, cost: 0.0005 }),
      scoredRun({ model: "b/two", latencyMs: 1000 }),
    ];
    const summaries = summarizeByModel(runs);
    expect(summaries).toEqual([
      { model: "b/two", passed: 2, total: 2, cost: 0.002, medianLatencyMs: 2000 },
      { model: "a/one", passed: 2, total: 3, cost: 0.0015, medianLatencyMs: 2000 },
    ]);
    expect(formatModelSummaries(summaries).split("\n")).toEqual([
      "b/two  2/2 passed  $0.002000  median 2.0s",
      "a/one  2/3 passed  $0.001500  median 2.0s",
    ]);
  });

  it("leaves cost unknown when no run reported one", () => {
    const summaries = summarizeByModel([scoredRun({})]);
    expect(summaries[0]).not.toHaveProperty("cost");
    expect(formatModelSummaries(summaries)).toBe("acme/cheap-model  1/1 passed  -  median 1.2s");
  });
});

describe("formatTable", () => {
  it("shows tokens, cost, the provider, a fallback's served model, and non-pass reasons", () => {
    const table = formatTable([
      score(
        run({
          outcome: outcome(),
          inputTokens: 278,
          outputTokens: 30,
          cost: 0.0000567,
          provider: "Together",
          servedModel: "acme/other-model",
        }),
        tokyo,
      ),
    ]);
    const [header, row, , reason] = table.split("\n");
    expect(header).toMatch(
      /^model\s+case\s+result\s+finish\s+latency\s+tokens in\/out\s+cost\s+provider\s+served$/,
    );
    expect(row?.split(/\s{2,}/)).toEqual([
      "acme/cheap-model",
      "tokyo-time",
      "fail",
      "stop",
      "1.2s",
      "278/30",
      "$0.000057",
      "Together",
      "acme/other-model",
    ]);
    expect(reason).toBe(
      "  acme/cheap-model tokyo-time: fail, didn't call currentTime with Asia/Tokyo",
    );
  });

  it("leaves served empty when OpenRouter served the requested model", () => {
    const table = formatTable([
      score(
        run({ outcome: outcome(), provider: "Together", servedModel: "acme/cheap-model" }),
        tokyo,
      ),
    ]);
    const row = table.split("\n")[1];
    expect(row?.split(/\s{2,}/).slice(-2)).toEqual(["Together", "-"]);
  });
});

describe("case checks", () => {
  it("reply-ok accepts ok with or without punctuation and rejects anything longer", () => {
    const check = caseById("reply-ok").check;
    expect(check(outcome({ text: " OK.\n" }))).toBeUndefined();
    expect(check(outcome({ text: "ok, sure thing" }))).toMatch(/expected "ok"/);
  });

  it("no-tool-for-trivia fails when a tool is called even with the right answer", () => {
    const check = caseById("no-tool-for-trivia").check;
    expect(check(outcome({ text: "Paris" }))).toBeUndefined();
    const toolCalls = [{ name: "currentTime", input: { timeZone: "Europe/Paris" } }];
    expect(check(outcome({ text: "Paris", toolCalls }))).toMatch(/tool/);
  });

  it("extract checks name every wrong field and accept a case difference", () => {
    const check = caseById("extract-missing-fields").check;
    const contact = { name: "grace hopper", email: null, phone: null, company: null };
    expect(check(outcome({ contact }))).toBeUndefined();
    expect(check(outcome({ contact: { ...contact, company: "Navy", phone: "555" } }))).toBe(
      'wrong phone ("555"), company ("Navy")',
    );
    expect(check(outcome())).toBe("no contact returned");
  });
});

describe("the rename-across-files coding case", () => {
  const rename = caseById("rename-across-files") as CodingCase;
  const renamed = Object.fromEntries(
    Object.entries(rename.files).map(([path, text]) => [
      path,
      text.replaceAll("fmtPrice", "formatPrice"),
    ]),
  );
  const workspace = (
    files: Record<string, string>,
    test: { exitCode: number; output: string } = { exitCode: 0, output: "" },
  ) => outcome({ workspace: { files, test } });

  it("passes when every file is renamed and the test passes", () => {
    expect(rename.check(workspace(renamed))).toBeUndefined();
  });

  it("names the files that still use the old name", () => {
    expect(
      rename.check(workspace({ ...renamed, "README.md": rename.files["README.md"] ?? "" })),
    ).toBe("fmtPrice still in README.md");
  });

  it("fails a rename that dropped a call site instead of renaming it", () => {
    const dropped = { ...renamed, "src/receipt.ts": "export const receipt = () => '';\n" };
    expect(rename.check(workspace(dropped))).toBe("formatPrice missing from src/receipt.ts");
  });

  it("fails when files were added or removed", () => {
    const { "src/cart.ts": _, ...withoutCart } = renamed;
    expect(rename.check(workspace({ ...withoutCart, "src/new.ts": "" }))).toBe(
      "added src/new.ts, removed src/cart.ts",
    );
  });

  it("fails with the test's first line of output when it exits non-zero", () => {
    expect(
      rename.check(workspace(renamed, { exitCode: 1, output: 'got ["$12.50"]\nmore\n' })),
    ).toBe('the test exited 1: got ["$12.50"]');
  });

  it("fails without a workspace (the turn never ran)", () => {
    expect(rename.check(outcome())).toBe("no workspace recorded");
  });

  // The case's own fixture: its test must fail on the files as given and pass once renamed,
  // or the eval measures nothing.
  const runTest = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "orx-eval-case-"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return spawnSync("bun", ["-e", rename.test], { cwd: dir, encoding: "utf8" }).status;
  };

  it("has a test that fails before the rename and passes after it", () => {
    expect(runTest(rename.files)).not.toBe(0);
    expect(runTest(renamed)).toBe(0);
  });
});
