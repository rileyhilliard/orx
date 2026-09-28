import { describe, expect, it } from "bun:test";
import { Cause, Exit, Option } from "effect";
import { toPrompt } from "~/core/chat";
import { chatToMarkdown } from "~/core/export";
import { modelsTable, usageLine } from "~/core/format";
import { searchModels } from "~/core/models";
import { checksumFor } from "~/core/update";
import {
  APP_ERROR_TAGS,
  type AppError,
  BadInput,
  BrokenPipe,
  defectOf,
  exitCodeFor,
  InvalidConfig,
  InvalidModelOutput,
  NotConfigured,
  NotFound,
  NotInteractive,
  PermissionDenied,
  retryableFor,
  TuiUnavailable,
  UnknownModel,
  UpstreamUnavailable,
} from "~/errors";
import type { ChatId, ModelInfo, StoredChat } from "~/schemas";

describe("exit codes", () => {
  it("maps every error to its documented code", () => {
    // Keyed by tag, so tsc fails when an AppError has no row; the key check below fails at
    // runtime when APP_ERROR_TAGS and this table disagree.
    const table: Record<AppError["_tag"], ReadonlyArray<readonly [AppError, number, boolean]>> = {
      BadInput: [[new BadInput({ message: "" }), 2, false]],
      NotFound: [[new NotFound({ message: "" }), 2, false]],
      UnknownModel: [[new UnknownModel({ message: "", model: "x" }), 2, false]],
      NotInteractive: [[new NotInteractive({ message: "" }), 2, false]],
      NotConfigured: [[new NotConfigured({ message: "" }), 3, false]],
      InvalidConfig: [[new InvalidConfig({ message: "" }), 3, false]],
      TuiUnavailable: [[new TuiUnavailable({ message: "" }), 3, false]],
      UpstreamUnavailable: [
        [new UpstreamUnavailable({ message: "", retryable: true }), 4, true],
        [new UpstreamUnavailable({ message: "", retryable: false }), 4, false],
      ],
      InvalidModelOutput: [[new InvalidModelOutput({ message: "" }), 5, true]],
      PermissionDenied: [[new PermissionDenied({ message: "" }), 6, false]],
    };
    expect(Object.keys(table).sort()).toEqual([...APP_ERROR_TAGS].sort());
    for (const [error, code, retryable] of Object.values(table).flat()) {
      expect([error._tag, exitCodeFor(error), retryableFor(error)]).toEqual([
        error._tag,
        code,
        retryable,
      ]);
    }
  });
});

describe("defectOf", () => {
  const upstream = new UpstreamUnavailable({ message: "down", retryable: true });
  const bug = new Error("a bug");
  const defect = (cause: Cause.Cause<unknown>) => defectOf(Exit.failCause(cause));

  it("reports a defect beside the typed failure that decided the exit code", () => {
    const cause = Cause.combine(Cause.fail(upstream), Cause.die(bug));
    expect(Option.getOrUndefined(defect(cause))).toBe(cause);
    const interrupted = Cause.combine(Cause.interrupt(), Cause.die(bug));
    expect(Option.isSome(defect(interrupted))).toBe(true);
  });

  it("reports a defect alone, or a failure that isn't an AppError", () => {
    expect(Option.isSome(defect(Cause.die(bug)))).toBe(true);
    expect(Option.isSome(defect(Cause.fail(bug)))).toBe(true);
  });

  it("reports nothing for a typed failure, an interruption, or a closed stdout", () => {
    expect(Option.isNone(defect(Cause.fail(upstream)))).toBe(true);
    expect(Option.isNone(defect(Cause.interrupt()))).toBe(true);
    expect(Option.isNone(defect(Cause.die(new BrokenPipe())))).toBe(true);
    expect(Option.isNone(defectOf(Exit.void))).toBe(true);
  });
});

const model = (id: string, name = id): ModelInfo => ({
  id,
  name,
  canonicalSlug: id,
  supportsTools: true,
  provider: id.split("/")[0] ?? "",
  contextLength: 128_000,
  promptPrice: 0.000001,
  completionPrice: 0.000002,
  maxCompletionTokens: null,
});

describe("toPrompt", () => {
  it("leaves out assistant messages with no text", () => {
    const prompt = toPrompt("sys", [
      { role: "user", text: "hi" },
      { role: "assistant", text: "", tools: [], interrupted: true },
      { role: "user", text: "again" },
    ]);
    expect(prompt.content.map((m) => m.role)).toEqual(["system", "user", "user"]);
  });
});

describe("searchModels", () => {
  const models = [
    model("openai/gpt-5", "OpenAI: GPT-5"),
    model("acme/gpt-clone"),
    model("meta/llama", "Meta Llama"),
  ];

  it("returns everything for an empty query", () => {
    expect(searchModels(models, "  ")).toHaveLength(3);
  });

  it("puts ids that start with the query first, then id matches, then names", () => {
    expect(searchModels(models, "gpt").map((m) => m.id)).toEqual([
      "openai/gpt-5",
      "acme/gpt-clone",
    ]);
    expect(searchModels(models, "llama").map((m) => m.id)).toEqual(["meta/llama"]);
  });
});

describe("formatting", () => {
  it("prints prices per million tokens and marks the default", () => {
    const table = modelsTable([model("openai/gpt-5")], "openai/gpt-5");
    expect(table).toContain("openai/gpt-5 *");
    expect(table).toContain("$1.00");
    expect(table).toContain("128k");
  });

  it("writes the usage line from what's known", () => {
    expect(
      usageLine({
        role: "assistant",
        text: "",
        tools: [],
        model: "m/x",
        usage: { inputTokens: 3, outputTokens: 4, cost: 0.0001 },
      }),
    ).toBe("m/x · 3 in / 4 out · $0.000100");
  });
});

describe("chatToMarkdown", () => {
  it("renders turns, tool calls, and reply details", () => {
    const chat: StoredChat = {
      id: "00000000-0000-4000-8000-000000000000" as ChatId,
      model: "m/x",
      createdAt: "2026-09-26T00:00:00.000Z",
      updatedAt: "2026-09-26T00:00:00.000Z",
      messages: [
        { role: "user", text: "time?" },
        {
          role: "assistant",
          text: "Noon.",
          tools: [
            {
              name: "currentTime",
              input: { timeZone: "UTC" },
              output: { iso: "x" },
              isFailure: false,
            },
          ],
          model: "m/x",
          usage: { inputTokens: 1, outputTokens: 2 },
        },
      ],
    };
    const markdown = chatToMarkdown(chat);
    expect(markdown).toContain("time?");
    expect(markdown).toContain("Noon.");
    expect(markdown).toContain("currentTime");
  });
});

describe("checksumFor", () => {
  it("reads sha256sum output, including binary-mode names", () => {
    const sums = "abc  orx-linux-x64\ndef *orx-darwin-arm64\n";
    expect(checksumFor(sums, "orx-linux-x64")).toBe("abc");
    expect(checksumFor(sums, "orx-darwin-arm64")).toBe("def");
    expect(checksumFor(sums, "orx-linux-arm64")).toBeUndefined();
  });
});
