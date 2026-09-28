// The no-network, no-real-state environment every bun test process starts from (tests/setup.ts,
// the bunfig.toml preload). bun auto-loads .env and the user may have a
// real ~/.config/orx/config.json, so this overrides both: no key, every URL unreachable, and
// config, data, and logs in a fresh temp dir. Tests that need a key or a stub set them explicitly.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const UNREACHABLE = "http://127.0.0.1:9";

export const isolateEnv = (): string => {
  const root = mkdtempSync(join(tmpdir(), "orx-test-"));
  Object.assign(process.env, {
    OPENROUTER_API_KEY: "",
    OPENROUTER_BASE_URL: `${UNREACHABLE}/api/v1`,
    ORX_RELEASES_URL: UNREACHABLE,
    XDG_CONFIG_HOME: join(root, "config"),
    ORX_DATA_DIR: join(root, "data"),
    ORX_LOG_FILE: "",
    HOME: root,
  });
  return root;
};
