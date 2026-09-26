#!/usr/bin/env bun
// `bun run build`: dist/orx for this machine. `bun run build:all`: every release target as
// dist/orx-<os>-<arch>, plus dist/SHA256SUMS (what the release uploads and `orx update` checks).
//
// OpenTUI's native library comes from one optional package per platform
// (@opentui/core-<os>-<arch>). A compiled binary embeds whatever those imports resolve to, so
// the plugin below keeps only the target's and turns the rest into empty modules: each binary
// carries one native library, not four. build:all needs every target's package installed:
// `bun install --os='*' --cpu='*'` (CI does this).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BunPlugin } from "bun";

process.chdir(join(import.meta.dirname, ".."));

export const TARGETS = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
] as const;
type Target = (typeof TARGETS)[number];

const NATIVE = /^@opentui\/core-(darwin|linux|win32)-(x64|arm64)(-musl)?$/;

const onlyNativeFor = ({ os, arch }: Target): BunPlugin => ({
  name: "opentui-native-for-target",
  setup(build) {
    build.onResolve({ filter: NATIVE }, (args) =>
      args.path === `@opentui/core-${os}-${arch}`
        ? undefined
        : { path: args.path, namespace: "opentui-stub" },
    );
    build.onLoad({ filter: /.*/, namespace: "opentui-stub" }, () => ({
      contents: "export default undefined;",
      loader: "js",
    }));
  },
});

const build = async (target: Target, outfile: string) => {
  const pkg = `node_modules/@opentui/core-${target.os}-${target.arch}`;
  if (!existsSync(pkg)) {
    throw new Error(
      `${pkg} isn't installed, so the binary would have no TUI. Run: bun install --os='*' --cpu='*'`,
    );
  }
  const result = await Bun.build({
    entrypoints: ["src/bin.ts"],
    plugins: [onlyNativeFor(target)],
    minify: true,
    // Embedded in the binary, so defect stacks in the log point at src/ lines. Bun also writes
    // <outfile>.map, which nothing reads; it's deleted below so releases don't ship it.
    sourcemap: "linked",
    compile: {
      target: `bun-${target.os}-${target.arch}`,
      outfile,
      // A user's .env or bunfig.toml in their cwd must not change what orx does.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
    throw new Error(`Build failed for ${target.os}-${target.arch}`);
  }
  rmSync(`${outfile}.map`, { force: true });
  process.stderr.write(`built ${outfile}\n`);
};

mkdirSync("dist", { recursive: true });
if (process.argv.includes("--all")) {
  const sums: string[] = [];
  for (const target of TARGETS) {
    const name = `orx-${target.os}-${target.arch}`;
    await build(target, join("dist", name));
    sums.push(
      `${createHash("sha256")
        .update(readFileSync(join("dist", name)))
        .digest("hex")}  ${name}`,
    );
  }
  writeFileSync("dist/SHA256SUMS", `${sums.join("\n")}\n`);
  process.stderr.write("wrote dist/SHA256SUMS\n");
} else {
  const host = TARGETS.find((t) => t.os === process.platform && t.arch === process.arch);
  if (!host) throw new Error(`No release target for ${process.platform}-${process.arch}`);
  await build(host, "dist/orx");
}
