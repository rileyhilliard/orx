// Waiting on a condition instead of sleeping (bun test has no vi.waitFor).

/**
 * Runs `check` until it returns without throwing, and returns what it returned; after
 * `timeout` ms, rethrows its last error.
 */
export const waitFor = async <A>(
  check: () => A | Promise<A>,
  {
    timeout = 1_000,
    interval = 20,
  }: { readonly timeout?: number; readonly interval?: number } = {},
): Promise<A> => {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
};
