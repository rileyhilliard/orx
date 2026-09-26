// The process `bun run stub` starts detached: the stub OpenRouter and stub releases servers
// from tests/helpers, on fixed ports, until SIGINT/SIGTERM. Writes logs/stub.pid while it runs.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStubOpenRouter } from "../tests/helpers/stub-openrouter";
import { startStubReleases } from "../tests/helpers/stub-releases";
import { STUB_PID_FILE, STUB_REPO } from "./lib/stub-pid";

process.chdir(join(import.meta.dirname, ".."));
const [openRouterPort, releasesPort] = [Number(process.argv[2]), Number(process.argv[3])];

const openRouter = await startStubOpenRouter(openRouterPort);
const releases = await startStubReleases(releasesPort, STUB_REPO);
// A newer release than any checkout, for `orx update --check` and install.sh. Its binary is
// dist/orx as built when the stub started (a placeholder script before the first build), so
// an `orx update` driven through the stub swaps in a working orx, never a toy script.
const target = `orx-${process.platform}-${process.arch}`;
const binary = existsSync("dist/orx")
  ? readFileSync("dist/orx")
  : "#!/bin/sh\necho 'orx stub release: run bun run build, then restart the stub'\n";
releases.release = { tag: "v99.0.0", assets: [{ name: target, body: binary }] };

mkdirSync("logs", { recursive: true });
writeFileSync(STUB_PID_FILE, `${process.pid} ${openRouterPort} ${releasesPort}\n`);
const stop = async () => {
  rmSync(STUB_PID_FILE, { force: true });
  await Promise.all([openRouter.close(), releases.close()]);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
