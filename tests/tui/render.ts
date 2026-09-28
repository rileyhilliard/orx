import { testRender } from "@opentui/react/test-utils";
import { APPROVAL_ARM_MS } from "~/tui/app";

/**
 * testRender with React's act checks off. The app's state changes arrive from streams and
 * promises outside act, which React would warn about on every update; the tests wait for the
 * frame they need (`waitForFrame`) instead.
 */
export const render = async (...args: Parameters<typeof testRender>) => {
  const setup = await testRender(...args);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  return setup;
};

export type RenderSetup = Awaited<ReturnType<typeof render>>;

/**
 * Renders until the frame matches, for at most `timeoutMs`. `waitForFrame` gives up as soon as
 * the renderer has nothing scheduled, which is fine for a fake bridge (its events are microtasks)
 * but not for the real one, whose events wait on the stub's HTTP and on the chat file's write.
 */
export const waitForScreen = async (
  setup: RenderSetup,
  predicate: (frame: string) => boolean,
  timeoutMs = 5000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the screen. Last frame:\n${frame}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * Types `key` until `done`: the approval panel ignores y / a / n for its first APPROVAL_ARM_MS,
 * so a press lands once it's armed. Checks between presses so no extra key reaches the composer.
 */
export const pressWhenArmed = async (setup: RenderSetup, key: string, done: () => boolean) => {
  const deadline = Date.now() + APPROVAL_ARM_MS + 3000;
  for (;;) {
    await setup.renderOnce();
    if (done()) return;
    if (Date.now() > deadline) throw new Error(`"${key}" never answered the panel`);
    await setup.mockInput.typeText(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
