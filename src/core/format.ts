import type { AssistantMessage, ModelInfo, StoredChat } from "~/schemas";

const dim = (color: boolean) => (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text);

/** `z-ai/glm-5.3-flash · Together · 278 in / 30 out · $0.000057` */
export const usageLine = (reply: AssistantMessage): string =>
  [
    reply.model,
    reply.provider,
    reply.usage ? `${reply.usage.inputTokens} in / ${reply.usage.outputTokens} out` : undefined,
    reply.usage?.cost !== undefined ? `$${reply.usage.cost.toFixed(6)}` : undefined,
    reply.interrupted ? "interrupted" : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

export const noteLine = (text: string, color: boolean) => dim(color)(text);

/** USD per million tokens, the way people compare prices. */
const perMillion = (price: number) => (price === 0 ? "free" : `$${(price * 1e6).toFixed(2)}`);

/** Plain-text columns: id, context, input and output price per million tokens. */
export const modelsTable = (models: ReadonlyArray<ModelInfo>, defaultModel: string): string => {
  const rows = models.map((m) => [
    m.id === defaultModel ? `${m.id} *` : m.id,
    m.contextLength === null ? "-" : `${Math.round(m.contextLength / 1000)}k`,
    perMillion(m.promptPrice),
    perMillion(m.completionPrice),
  ]);
  return table([["MODEL", "CONTEXT", "IN/M", "OUT/M"], ...rows]);
};

export const chatsTable = (chats: ReadonlyArray<StoredChat>): string => {
  const rows = chats.map((chat) => {
    const first = chat.messages.find((m) => m.role === "user")?.text ?? "";
    const title = first.replace(/\s+/g, " ").slice(0, 48);
    return [chat.id, chat.updatedAt.slice(0, 16).replace("T", " "), chat.model, title];
  });
  return table([["ID", "UPDATED", "MODEL", "FIRST MESSAGE"], ...rows]);
};

const table = (rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths =
    rows[0]?.map((_, col) => Math.max(...rows.map((row) => row[col]?.length ?? 0))) ?? [];
  return rows
    .map((row) =>
      row
        .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col] ?? 0)))
        .join("  "),
    )
    .join("\n");
};
