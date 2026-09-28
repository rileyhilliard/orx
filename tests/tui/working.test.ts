import { describe, expect, it } from "bun:test";
import { elapsed } from "~/tui/working";

describe("elapsed", () => {
  it("counts seconds, then minutes with padded seconds", () => {
    expect(elapsed(0)).toBe("0s");
    expect(elapsed(59_999)).toBe("59s");
    expect(elapsed(60_000)).toBe("1m 00s");
    expect(elapsed(65_000)).toBe("1m 05s");
    expect(elapsed(3_725_000)).toBe("62m 05s");
  });
});
