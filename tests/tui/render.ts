import { testRender } from "@opentui/react/test-utils";

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
