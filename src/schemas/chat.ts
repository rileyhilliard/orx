import { Schema } from "effect";
import { Prompt as AiPrompt } from "effect/unstable/ai";

/** A chat's id: a UUID, branded so it can't be swapped with other strings. */
export const ChatId = Schema.String.annotate({
  identifier: "ChatId",
  description: "A chat id (UUID)",
})
  .check(Schema.isUUID(undefined, { message: "Expected a chat id (a UUID)" }))
  .pipe(Schema.brand("ChatId"));
export type ChatId = typeof ChatId.Type;

/** Tokens and cost for one assistant reply, summed over its steps, from OpenRouter's usage. */
export const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /** USD, as reported by OpenRouter. Missing when the provider didn't report it. */
  cost: Schema.optional(Schema.Number),
});
export type Usage = typeof Usage.Type;

/** A tool the model called during a reply, kept so a resumed chat and an export show it. */
export const ToolStep = Schema.Struct({
  name: Schema.String,
  input: Schema.Unknown,
  output: Schema.Unknown,
  isFailure: Schema.Boolean,
});
export type ToolStep = typeof ToolStep.Type;

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  text: Schema.String,
});
export type UserMessage = typeof UserMessage.Type;

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  text: Schema.String,
  tools: Schema.Array(ToolStep),
  /**
   * The reply as the model saw it, one Prompt per model step (`Prompt.fromResponseParts`): text,
   * tool calls with their ids and provider metadata (reasoning details), and tool results.
   * The next turn replays these verbatim. Chats saved before steps existed replay `text`.
   */
  steps: Schema.optional(Schema.Array(AiPrompt.Prompt)),
  /** The model the turn asked for; its steps' reasoning details replay only to that model. */
  requestedModel: Schema.optional(Schema.String),
  /** The model that served the reply's last step (may differ from the requested one). */
  model: Schema.optional(Schema.String),
  /** The upstream provider OpenRouter routed to. */
  provider: Schema.optional(Schema.String),
  usage: Schema.optional(Usage),
  finishReason: Schema.optional(Schema.String),
  /** True when the reply was cut off (Ctrl+C, timeout, or an error after it started). */
  interrupted: Schema.optional(Schema.Boolean),
});
export type AssistantMessage = typeof AssistantMessage.Type;

export const ChatMessage = Schema.Union([UserMessage, AssistantMessage]);
export type ChatMessage = typeof ChatMessage.Type;

/** A chat as ChatStore saves it: one JSON file per chat under the data dir. */
export const StoredChat = Schema.Struct({
  id: ChatId,
  /** The model the chat last asked for. */
  model: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  messages: Schema.Array(ChatMessage),
}).annotate({ identifier: "StoredChat" });
export type StoredChat = typeof StoredChat.Type;

/** A trimmed string with at least one character. */
export const Prompt = Schema.Trim.check(
  Schema.isMinLength(1, { message: "The prompt is empty." }),
  Schema.isMaxLength(32_000, { message: "The prompt is longer than 32000 characters." }),
);
