import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { applyUpdate, checkForUpdate } from "../core/update";
import { Output } from "../services/Output";
import { jsonFlag } from "./shared";

const check = Flag.Boolean("check").pipe(
  Flag.withDescription("Only report whether a newer release exists"),
  Flag.withDefault(false),
);

export const update = Command.make("update", { check, json: jsonFlag }, ({ check, json }) =>
  Effect.gen(function* () {
    const out = yield* Output;
    const { check: result, release } = yield* checkForUpdate;
    if (check || !result.newer) {
      if (json) return yield* out.json(result);
      return yield* out.line(
        result.newer
          ? `orx ${result.latest} is available (you have ${result.current}); run \`orx update\`.`
          : `orx ${result.current} is the latest release.`,
      );
    }
    yield* out.note(`Updating orx ${result.current} -> ${result.latest}...`);
    yield* applyUpdate(release);
    if (json) return yield* out.json({ ...result, updated: true });
    yield* out.line(`Updated to orx ${result.latest}.`);
  }),
).pipe(Command.withDescription("Update orx to the latest GitHub release (checksum-verified)"));
