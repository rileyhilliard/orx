import type { AssistantMessage, StoredChat } from "~/schemas";

/** Inline code that survives backticks in the text: a longer fence, padded when needed. */
const inlineCode = (text: string): string => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
};

/** The italic line under an assistant reply: model, tokens, cost, interrupted. Empty for none. */
export const replyDetails = (message: AssistantMessage): string => {
  const { model, usage, interrupted } = message;
  const details = [
    model,
    usage ? `${usage.inputTokens} input / ${usage.outputTokens} output tokens` : undefined,
    usage?.cost !== undefined ? `$${usage.cost.toFixed(6)}` : undefined,
    interrupted ? "interrupted" : undefined,
  ].filter((detail) => detail !== undefined);
  return details.length > 0 ? `_${details.join(", ")}_` : "";
};

/** A chat as Markdown: a heading per turn, the text, a quoted line per tool call, reply details. */
export const chatToMarkdown = (chat: StoredChat): string => {
  const blocks = [`# Chat ${chat.id}`];
  for (const message of chat.messages) {
    if (message.role === "user") {
      blocks.push("## User", message.text);
      continue;
    }
    blocks.push("## Assistant");
    for (const tool of message.tools) {
      blocks.push(`> Called \`${tool.name}\` with ${inlineCode(JSON.stringify(tool.input))}`);
    }
    if (message.text) blocks.push(message.text);
    const details = replyDetails(message);
    if (details) blocks.push(details);
  }
  return `${blocks.join("\n\n")}\n`;
};
