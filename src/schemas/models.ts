import { Schema } from "effect";

/** One model from OpenRouter's list. Prices are USD per token, as OpenRouter reports them. */
export const ModelInfo = Schema.Struct({
  id: Schema.String,
  /**
   * The permanent slug OpenRouter can report as the served model instead of `id` (often a
   * dated variant). Chat maps it back to `id` to tell a fallback from a renamed model.
   */
  canonicalSlug: Schema.String,
  name: Schema.String,
  /** The model author, from the id prefix (`openai/gpt-...` -> `openai`). */
  provider: Schema.String,
  contextLength: Schema.NullOr(Schema.Number),
  promptPrice: Schema.Number,
  completionPrice: Schema.Number,
}).annotate({ identifier: "ModelInfo" });
export type ModelInfo = typeof ModelInfo.Type;

/** What `orx models --json` prints and the TUI picker loads. */
export const ModelsList = Schema.Struct({
  models: Schema.Array(ModelInfo),
  defaultModel: Schema.String,
  /** False when the list couldn't be fetched; the picker then offers only the default. */
  available: Schema.Boolean,
}).annotate({ identifier: "ModelsList" });
export type ModelsList = typeof ModelsList.Type;
