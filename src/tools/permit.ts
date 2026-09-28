import { Effect } from "effect";
import { ToolFailure } from "~/schemas";
import { type PermissionRequest, Permissions } from "../services/permissions";

/** Asks Permissions; a denial becomes a ToolFailure the model reads. */
export const permit = (request: PermissionRequest) =>
  Effect.gen(function* () {
    const result = yield* (yield* Permissions).check(request);
    if (result !== "allow") {
      return yield* new ToolFailure({ message: `${request.summary}: denied. ${result.deny}` });
    }
  });

/** What write and edit report back when a file changed after it was read. */
export const freshnessFailure = (shown: string, freshness: "not-read" | "stale") =>
  new ToolFailure({
    message:
      freshness === "not-read"
        ? `${shown}: read it first; write and edit only change files you have read`
        : `${shown} changed since you read it; read it again before changing it`,
  });
