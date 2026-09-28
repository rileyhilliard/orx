import type { AskResult } from "~/schemas";

const dim = (color: boolean) => (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text);

/** `openai/gpt-6-luna · 278 in / 30 out · $0.000057` */
export const usageLine = (result: AskResult): string =>
  [
    result.model,
    `${result.usage.inputTokens} in / ${result.usage.outputTokens} out`,
    result.usage.cost !== undefined ? `$${result.usage.cost.toFixed(6)}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

export const noteLine = (text: string, color: boolean) => dim(color)(text);
