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
