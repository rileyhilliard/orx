import { Schema } from "effect";

/**
 * Contact details pulled from free text. Fields are nullable rather than optional so the
 * JSON Schema lists every property as required, which strict structured-output modes need.
 */
export const Contact = Schema.Struct({
  name: Schema.String.annotate({ description: "The person's full name" }),
  email: Schema.NullOr(Schema.String).annotate({
    description: "Email address, or null if none is given",
  }),
  phone: Schema.NullOr(Schema.String).annotate({
    description: "Phone number as written, or null if none is given",
  }),
  company: Schema.NullOr(Schema.String).annotate({
    description: "Company or organization, or null if none is given",
  }),
}).annotate({
  // No `identifier`: it makes the JSON Schema a top-level $ref, which models handle poorly.
  title: "Contact",
  description: "Contact details extracted from free text",
});
export type Contact = typeof Contact.Type;

/** The text `orx extract` reads from its argument or stdin. */
export const ExtractText = Schema.Trim.check(
  Schema.isMinLength(1, { message: "Give some text to extract from (an argument or stdin)." }),
  Schema.isMaxLength(4000, { message: "Text must be at most 4000 characters." }),
);
