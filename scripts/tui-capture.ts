#!/usr/bin/env bun
// `bun run tui:capture -- --keys "hi<enter>"`: runs orx in a pseudo-terminal, types the
// keys, and prints the screen as text once it settles. For agents, which can't look at a
// terminal. Logs and chats go where `bun run orx` puts them (logs/, .orx/data); point it at
// `bun run stub` for replies without a key.
//
//   --keys <spec>     keys to type: text plus <enter> <esc> <tab> <up> <down> <ctrl-x> <wait:ms>
//   --wait-for <text> print once this text is on screen (default: when the screen settles)
//   --cols/--rows     terminal size (default 100x30)
//   --bin <path>      run a binary (dist/orx) instead of src/bin.ts
//   --no-quit         leave the app running instead of sending Ctrl+C at the end
//
// orx's own flags go after a second `--`, so they aren't read as these:
// `bun run tui:capture -- --keys "hi<enter>" -- --resume <id>`.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseKeys, spawnPty } from "./lib/pty";

process.chdir(join(import.meta.dirname, ".."));

const parse = () => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        keys: { type: "string", default: "" },
        "wait-for": { type: "string" },
        cols: { type: "string", default: "100" },
        rows: { type: "string", default: "30" },
        bin: { type: "string" },
        "no-quit": { type: "boolean", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(
      `tui:capture: ${error instanceof Error ? error.message.split(".")[0] : error}. ` +
        `Put orx's own flags after a second \`--\`: ` +
        `bun run tui:capture -- --keys "..." -- --resume <id>\n`,
    );
    process.exit(2);
  }
};
const { values, positionals } = parse();

const command = values.bin
  ? [values.bin, ...positionals]
  : [process.execPath, "src/bin.ts", ...positionals];
const pty = spawnPty(command, {
  cols: Number(values.cols),
  rows: Number(values.rows),
  env: {
    ...process.env,
    ORX_LOG_FILE: process.env.ORX_LOG_FILE ?? "logs/orx.jsonl",
    ORX_DATA_DIR: process.env.ORX_DATA_DIR || ".orx/data",
  },
});

const timeout = setTimeout(() => {
  process.stderr.write(`tui:capture: gave up after 30s. Screen:\n${pty.screen()}\n`);
  pty.kill();
  process.exit(1);
}, 30_000);

// The first frame, then the keys.
await pty.waitFor((screen) => screen.trim() !== "", 10_000).catch(() => undefined);
await pty.settle(200);
for (const step of parseKeys(values.keys)) {
  if ("waitMs" in step) await Bun.sleep(step.waitMs);
  else {
    pty.write(step.send);
    await Bun.sleep(30);
  }
}
const waitFor = values["wait-for"];
const screen = waitFor
  ? await pty.waitFor((s) => s.includes(waitFor), 20_000)
  : await pty.settle(500);
process.stdout.write(`${screen}\n`);

if (!values["no-quit"]) {
  pty.write("\x03");
  const code = await Promise.race([pty.exited, Bun.sleep(5000).then(() => undefined)]);
  if (code === undefined) {
    pty.kill();
    process.stderr.write("tui:capture: the app didn't exit within 5s of Ctrl+C\n");
    process.exitCode = 1;
  } else {
    process.stderr.write(`tui:capture: exit ${code}\n`);
  }
}
clearTimeout(timeout);
process.exit();
