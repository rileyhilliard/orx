// The no-network, no-real-state environment every bun test process starts from (tests/setup.ts,
// the bunfig.toml preload). bun auto-loads .env and the user may have a
// real ~/.config/orx/config.json, so this overrides both: no key, every URL unreachable, and
// config, data, and logs in a fresh temp dir. Tests that need a key or a stub set them explicitly.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const UNREACHABLE = "http://127.0.0.1:9";

/**
 * Every other variable src/config.ts reads, cleared so a developer's .env (MAX_TOOL_STEPS=5,
 * say) can't change what a test sees. tests/isolation.test.ts fails when config gains one
 * that is neither here nor set below.
 */
export const CLEARED = [
  "FORCE_COLOR",
  "LOG_LEVEL",
  "MAX_OUTPUT_TOKENS",
  "MAX_STREAM_SECONDS",
  "MAX_TOOL_STEPS",
  "NO_COLOR",
  "OPENROUTER_ALLOW_FALLBACKS",
  "OPENROUTER_DATA_COLLECTION",
  "OPENROUTER_FALLBACK_MODELS",
  "OPENROUTER_MODEL",
  "OPENROUTER_PROVIDER_SORT",
  "OPENROUTER_ZDR",
  "ORX_LOG_FORMAT",
  "ORX_RELEASES_REPO",
  "SYSTEM_PROMPT",
  "XDG_DATA_HOME",
] as const;

export const isolateEnv = (): string => {
  const root = mkdtempSync(join(tmpdir(), "orx-test-"));
  for (const name of CLEARED) delete process.env[name];
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
