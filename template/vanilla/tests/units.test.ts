import { describe, expect, it } from "bun:test";
import { usageLine } from "~/core/format";
import { checksumFor } from "~/core/update";
import {
  BadInput,
  exitCodeFor,
  InvalidConfig,
  NotConfigured,
  NotInteractive,
  PermissionDenied,
  retryableFor,
  TuiUnavailable,
  UpstreamUnavailable,
} from "~/errors";

describe("exit codes", () => {
  it("maps every error to its documented code", () => {
    const cases = [
      [new BadInput({ message: "" }), 2, false],
      [new NotInteractive({ message: "" }), 2, false],
      [new NotConfigured({ message: "" }), 3, false],
      [new InvalidConfig({ message: "" }), 3, false],
      [new TuiUnavailable({ message: "" }), 3, false],
      [new UpstreamUnavailable({ message: "", retryable: true }), 4, true],
      [new UpstreamUnavailable({ message: "", retryable: false }), 4, false],
      [new PermissionDenied({ message: "" }), 6, false],
    ] as const;
    for (const [error, code, retryable] of cases) {
      expect([error._tag, exitCodeFor(error), retryableFor(error)]).toEqual([
        error._tag,
        code,
        retryable,
      ]);
    }
  });
});

describe("formatting", () => {
  it("writes the usage line from what's known", () => {
    expect(
      usageLine({
        text: "",
        model: "m/x",
        usage: { inputTokens: 3, outputTokens: 4, cost: 0.0001 },
      }),
    ).toBe("m/x · 3 in / 4 out · $0.000100");
    expect(usageLine({ text: "", usage: { inputTokens: 3, outputTokens: 4 } })).toBe(
      "3 in / 4 out",
    );
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
