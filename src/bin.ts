#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { main } from "./main";
import { AppLayer, LoggerLayer } from "./runtime";
import { Host } from "./services/Host";

// @opentui/react loads its devtools when DEV=true; a user's DEV must never reach it.
delete process.env.DEV;

const PlatformLayer = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Host.layer({
    execPath: process.execPath,
    // A compiled binary's modules live in Bun's embedded filesystem.
    compiled: import.meta.path.startsWith("/$bunfs"),
    platform: process.platform,
    arch: process.arch,
  }),
);

const program = main({
  argv: process.argv.slice(2),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).pipe(
  Effect.provide(AppLayer.pipe(Layer.provideMerge(PlatformLayer))),
  Effect.provide(LoggerLayer),
);

BunRuntime.runMain(program, {
  // main renders every failure itself; runMain would print them again, to stdout.
  disableErrorReporting: true,
  teardown: (exit, onExit) => {
    if (Exit.isSuccess(exit)) return onExit(typeof exit.value === "number" ? exit.value : 0);
    if (Cause.hasInterruptsOnly(exit.cause)) return onExit(130);
    // A layer failed to build (everything after that is handled in main).
    process.stderr.write(`orx: couldn't start: ${Cause.pretty(exit.cause)}\n`);
    onExit(1);
  },
});
