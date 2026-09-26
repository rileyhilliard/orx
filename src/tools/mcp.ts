import { Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { Contact, ErrorBody, ExtractText } from "~/schemas";
import { extractContact } from "../core/extract";
import { errorBody } from "../errors";
import { ChatTools, ChatToolsLive } from "./index";

/** `orx extract` as an MCP tool. A failure comes back as a tool result the client can read. */
export const ExtractContact = Tool.make("extractContact", {
  description: "Extract a person's contact details (name, email, phone, company) from free text.",
  parameters: Schema.Struct({
    text: ExtractText.annotate({ description: "Free text that mentions one person" }),
  }),
  success: Contact,
  failure: ErrorBody,
  failureMode: "return",
});

/** What `orx mcp` serves: the chat tools plus extractContact. */
export const McpTools = Toolkit.merge(ChatTools, Toolkit.make(ExtractContact));

const ExtractContactLive = Toolkit.make(ExtractContact).toLayer(
  Effect.gen(function* () {
    // Handlers can't require services, so the ones extraction needs are captured here.
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof extractContact>>>();
    return {
      extractContact: ({ text }) =>
        extractContact(text).pipe(
          Effect.map(({ contact }) => contact),
          Effect.mapError(errorBody),
          Effect.provideContext(context),
        ),
    };
  }),
);

export const McpToolsLive = Layer.mergeAll(ChatToolsLive, ExtractContactLive);
