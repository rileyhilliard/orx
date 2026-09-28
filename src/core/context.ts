import { Prompt } from "effect/unstable/ai";

/**
 * Keeping a turn's prompt inside the model's context window. Pure functions over a Prompt,
 * used by the turn loop in chat.ts before each model step.
 */

/** Elide once the estimated prompt passes this share of the model's context window. */
export const ELIDE_AT = 0.6;
/** Tool outputs up to this many characters are never elided. */
export const ELIDE_MIN_CHARS = 2000;
/** The tool results of the last this-many model steps are never elided. */
export const PROTECTED_STEPS = 2;
/** Tools whose results are never elided (a loaded skill is instructions, not data). */
export const NEVER_ELIDED = new Set(["skill"]);

const resultText = (result: unknown) =>
  typeof result === "string" ? result : (JSON.stringify(result) ?? "");

const partChars = (part: Prompt.Part): number => {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text.length;
    case "tool-call":
      return part.name.length + resultText(part.params).length;
    case "tool-result":
      return resultText(part.result).length;
    default:
      return 0;
  }
};

/** A rough token count for a prompt: characters / 4. */
export const estimateTokens = (prompt: Prompt.Prompt): number => {
  let chars = 0;
  for (const message of prompt.content) {
    if (message.role === "system") chars += message.content.length;
    else for (const part of message.content) chars += partChars(part);
  }
  return Math.ceil(chars / 4);
};

/** What a stub names the call by: its `path`, or else its first string argument. */
const argOf = (params: unknown): string => {
  if (typeof params !== "object" || params === null) return "";
  const record = params as Record<string, unknown>;
  const value =
    typeof record.path === "string"
      ? record.path
      : Object.values(record).find((v): v is string => typeof v === "string");
  if (value === undefined) return "";
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
};

export const elidedStub = (name: string, params: unknown) => {
  const arg = argOf(params);
  return `[${name}${arg === "" ? "" : ` ${arg}`} output elided, re-run if needed]`;
};

interface Candidate {
  readonly id: string;
  readonly chars: number;
}

/** Tool results that may be elided, oldest first, and each call's params by id. */
const candidatesOf = (prompt: Prompt.Prompt) => {
  const params = new Map<string, unknown>();
  const steps: Array<ReadonlyArray<string>> = [];
  for (const message of prompt.content) {
    if (message.role !== "assistant") continue;
    const ids: string[] = [];
    for (const part of message.content) {
      if (part.type !== "tool-call") continue;
      params.set(part.id, part.params);
      ids.push(part.id);
    }
    if (ids.length > 0) steps.push(ids);
  }
  const protectedIds = new Set(steps.slice(-PROTECTED_STEPS).flat());
  const candidates: Candidate[] = [];
  for (const message of prompt.content) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      if (protectedIds.has(part.id) || NEVER_ELIDED.has(part.name)) continue;
      const chars = resultText(part.result).length;
      if (chars > ELIDE_MIN_CHARS) candidates.push({ id: part.id, chars });
    }
  }
  return { candidates, params };
};

/** Whether eliding could shrink the prompt at all (so the context window is worth looking up). */
export const canElide = (prompt: Prompt.Prompt) => candidatesOf(prompt).candidates.length > 0;

/**
 * Replaces tool outputs over ELIDE_MIN_CHARS with a stub, oldest first, until the estimate is
 * at or under `budgetTokens` (0 elides every candidate). Never the last PROTECTED_STEPS steps'
 * results, and never NEVER_ELIDED tools'. Returns the prompt unchanged when nothing is elided.
 */
export const elide = (
  prompt: Prompt.Prompt,
  budgetTokens: number,
): { readonly prompt: Prompt.Prompt; readonly elided: number } => {
  const { candidates, params } = candidatesOf(prompt);
  let estimate = estimateTokens(prompt);
  const chosen = new Set<string>();
  for (const candidate of candidates) {
    if (estimate <= budgetTokens) break;
    chosen.add(candidate.id);
    estimate -= Math.floor(candidate.chars / 4);
  }
  if (chosen.size === 0) return { prompt, elided: 0 };
  const messages = prompt.content.map((message) =>
    message.role !== "tool"
      ? message
      : Prompt.makeMessage("tool", {
          content: message.content.map((part) =>
            part.type === "tool-result" && chosen.has(part.id)
              ? Prompt.makePart("tool-result", {
                  id: part.id,
                  name: part.name,
                  isFailure: part.isFailure,
                  result: elidedStub(part.name, params.get(part.id)),
                  providerExecuted: part.providerExecuted,
                  options: part.options,
                })
              : part,
          ),
          options: message.options,
        }),
  );
  return { prompt: Prompt.fromMessages(messages), elided: chosen.size };
};

/** The token budget for a model's window, or undefined when the window isn't known. */
export const budgetFor = (contextLength: number | null | undefined) =>
  contextLength ? Math.floor(contextLength * ELIDE_AT) : undefined;

const ephemeral = { openrouter: { cacheControl: { type: "ephemeral" as const } } };

/**
 * Anthropic prompt caching through OpenRouter: breakpoints on the system prompt and the last
 * user message. @effect/ai-openrouter sends `cache_control` only on system and user messages,
 * so the breakpoint can't sit on the latest tool step.
 */
export const withCacheBreakpoints = (prompt: Prompt.Prompt): Prompt.Prompt => {
  let lastUser = -1;
  prompt.content.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
  });
  return Prompt.fromMessages(
    prompt.content.map((message, index) => {
      if (message.role === "system") {
        return Prompt.makeMessage("system", {
          content: message.content,
          options: { ...message.options, ...ephemeral },
        });
      }
      if (message.role === "user" && index === lastUser) {
        return Prompt.makeMessage("user", {
          content: message.content,
          options: { ...message.options, ...ephemeral },
        });
      }
      return message;
    }),
  );
};
