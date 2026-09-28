// Setting env vars for one test and putting them back, for bun test (which has no vi.stubEnv).
// Every test process shares one process.env, so a test that stubs calls restoreEnv in afterEach.

const saved = new Map<string, string | undefined>();

/** Sets `name` (or unsets it, for undefined) until the next restoreEnv. */
export const stubEnv = (name: string, value: string | undefined) => {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

/** Puts back every variable stubEnv changed since the last call. */
export const restoreEnv = () => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
};
