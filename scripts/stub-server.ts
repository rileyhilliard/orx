// The process `bun run stub` starts detached: the stub OpenRouter and stub releases servers
// from tests/helpers, on fixed ports, until SIGINT/SIGTERM. Writes logs/stub.pid while it runs.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStubOpenRouter } from "../tests/helpers/stub-openrouter";
import { startStubReleases } from "../tests/helpers/stub-releases";
import { STUB_PID_FILE, STUB_REPO } from "./lib/stub-pid";

process.chdir(join(import.meta.dirname, ".."));
const [openRouterPort, releasesPort] = [Number(process.argv[2]), Number(process.argv[3])];

const openRouter = await startStubOpenRouter(openRouterPort);
const releases = await startStubReleases(releasesPort, STUB_REPO);
// A newer release than any checkout, for `orx update --check` and install.sh.
const target = `orx-${process.platform}-${process.arch}`;
releases.release = {
  tag: "v99.0.0",
  assets: [{ name: target, body: "#!/bin/sh\necho 'orx v99.0.0 (stub release)'\n" }],
};

mkdirSync("logs", { recursive: true });
writeFileSync(STUB_PID_FILE, `${process.pid} ${openRouterPort} ${releasesPort}\n`);
const stop = async () => {
  rmSync(STUB_PID_FILE, { force: true });
  await Promise.all([openRouter.close(), releases.close()]);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
