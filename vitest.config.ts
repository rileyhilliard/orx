import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// vitest runs on Node: everything except the TUI, which needs Bun (tests/tui, `bun run test:tui`)
// and the compiled binary (e2e, `bun run e2e`).
export default defineConfig({
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/tui/**", "node_modules/**"],
    environment: "node",
    // No key, unreachable URLs, temp config/data dirs (tests/isolation.ts).
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/tui/**", "src/bin.ts"],
      reporter: ["text", "html"],
    },
  },
});
