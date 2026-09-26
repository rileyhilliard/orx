import { describe, expect, it } from "bun:test";
import { RENDERER_OPTIONS } from "~/tui/launch";

describe("renderer options", () => {
  // Effect owns signals and the exit code; OpenTUI exiting on its own would skip saving the
  // chat and exit 0 or kill the process mid-write.
  it("leaves Ctrl+C and signals to orx", () => {
    expect(RENDERER_OPTIONS).toMatchObject({ exitOnCtrlC: false, exitSignals: [] });
  });

  it("keeps OpenTUI's console overlay off", () => {
    expect(RENDERER_OPTIONS.consoleMode).toBe("disabled");
  });
});
