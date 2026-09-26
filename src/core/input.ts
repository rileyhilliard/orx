import { Effect, Schema, SchemaIssue } from "effect";
import { BadInput } from "../errors";

export const formatIssue = SchemaIssue.makeFormatterDefault();

/** Decodes a command's input (an argument, a flag value, stdin) at the trust boundary. */
export const decodeInput =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((error) => new BadInput({ message: formatIssue(error.issue) })),
    );
