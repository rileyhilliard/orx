import { Prompt } from "effect/unstable/ai";

/**
 * Keeping a turn's prompt inside the model's context window. Pure functions over a Prompt,
 * used by the turn loop in chat.ts before each model step.
 */

/** Elide once the estimated prompt passes this share of the model's context window. */
export const ELIDE_AT = 0.6;
/**
 * ...down to this share, so the next steps have room to grow before the elided set has to
 * change again (each change rewrites an early message, which the provider's cache then misses).
 */
export const ELIDE_TO = 0.4;
/** Tool outputs and attachments up to this many characters are never elided. */
export const ELIDE_MIN_CHARS = 2000;
/** The tool results of the last this-many model steps are never elided. */
export const PROTECTED_STEPS = 2;
/** Tools whose results are never elided (a loaded skill is instructions, not data). */
export const NEVER_ELIDED = new Set(["skill"]);

/**
 * The options on the text part that carries a user message's `@` attachments (`toPrompt`
 * builds it), so eliding can tell it from what the user typed. The OpenRouter provider reads
 * only `options.openrouter`, so this never reaches a request.
 */
export const ATTACHMENT_OPTIONS = { orx: { attachment: true } } as const;

const isAttachment = (part: Prompt.UserMessagePart) =>
  part.type === "text" &&
  (part.options.orx as { attachment?: unknown } | null | undefined)?.attachment === true;

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

/** The stub for an elided attachment: the paths its blocks named. */
export const elidedAttachmentStub = (attachments: string) => {
  const paths = [...attachments.matchAll(/^<(?:file|directory) path="([^"]*)">$/gm)].map(
    (match) => match[1],
  );
  return `[attached ${paths.length > 0 ? paths.join(", ") : "files"} elided, read again if needed]`;
};

/** Something eliding may replace: a tool result by call id, or a user message's attachments. */
type Candidate =
  | { readonly kind: "tool"; readonly id: string; readonly chars: number }
  | { readonly kind: "attachment"; readonly message: number; readonly chars: number };

/**
 * What may be elided, oldest first, and each call's params by id. Spared: the last
 * PROTECTED_STEPS steps' tool results, NEVER_ELIDED tools, and the last user message's
 * attachments (the message the model is answering).
 */
const candidatesOf = (prompt: Prompt.Prompt) => {
  const params = new Map<string, unknown>();
  const steps: Array<ReadonlyArray<string>> = [];
  let lastUser = -1;
  prompt.content.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
    if (message.role !== "assistant") return;
    const ids: string[] = [];
    for (const part of message.content) {
      if (part.type !== "tool-call") continue;
      params.set(part.id, part.params);
      ids.push(part.id);
    }
    if (ids.length > 0) steps.push(ids);
  });
  const protectedIds = new Set(steps.slice(-PROTECTED_STEPS).flat());
  const candidates: Candidate[] = [];
  prompt.content.forEach((message, index) => {
    if (message.role === "user" && index !== lastUser) {
      const chars = message.content
        .filter(isAttachment)
        .reduce((sum, part) => sum + partChars(part), 0);
      if (chars > ELIDE_MIN_CHARS) candidates.push({ kind: "attachment", message: index, chars });
    }
    if (message.role !== "tool") return;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      if (protectedIds.has(part.id) || NEVER_ELIDED.has(part.name)) continue;
      const chars = resultText(part.result).length;
      if (chars > ELIDE_MIN_CHARS) candidates.push({ kind: "tool", id: part.id, chars });
    }
  });
  return { candidates, params };
};

/** Whether eliding could shrink the prompt at all (so the context window is worth looking up). */
export const canElide = (prompt: Prompt.Prompt) => candidatesOf(prompt).candidates.length > 0;

/**
 * What a turn has elided so far: tool results by call id, and user messages' attachments by
 * message index (a turn's prompt only grows at the end, so indices hold). The turn keeps it
 * across steps, so an output stays elided and the prompt's prefix stays byte-identical.
 */
export interface Elision {
  readonly tools: ReadonlySet<string>;
  readonly messages: ReadonlySet<number>;
}

export const NOTHING_ELIDED: Elision = { tools: new Set(), messages: new Set() };

/** When to elide more (the estimate is over `limit` tokens), and down to how many (`target`). */
export interface ElideBudget {
  readonly limit: number;
  readonly target: number;
}

/** Every candidate: the retry after the provider rejected the prompt as too long. */
export const ELIDE_ALL: ElideBudget = { limit: 0, target: 0 };

const isElided = (elision: Elision, candidate: Candidate) =>
  candidate.kind === "tool"
    ? elision.tools.has(candidate.id)
    : elision.messages.has(candidate.message);

/**
 * Replaces tool outputs and older messages' `@` attachments over ELIDE_MIN_CHARS with a stub.
 * What `previous` elided stays elided. Only when the estimate is still over `budget.limit` are
 * more elided, oldest first, until it is at or under `budget.target`. Never the last
 * PROTECTED_STEPS steps' results, NEVER_ELIDED tools', or the last user message's attachments.
 * Returns the whole elision (for the next step) and how many it added; the prompt is unchanged
 * when nothing is elided.
 */
export const elide = (
  prompt: Prompt.Prompt,
  budget: ElideBudget,
  previous: Elision = NOTHING_ELIDED,
): { readonly prompt: Prompt.Prompt; readonly elision: Elision; readonly elided: number } => {
  const { candidates, params } = candidatesOf(prompt);
  let estimate = estimateTokens(prompt);
  for (const candidate of candidates) {
    if (isElided(previous, candidate)) estimate -= Math.floor(candidate.chars / 4);
  }
  const tools = new Set(previous.tools);
  const messages = new Set(previous.messages);
  if (estimate > budget.limit) {
    for (const candidate of candidates) {
      if (estimate <= budget.target) break;
      if (isElided(previous, candidate)) continue;
      if (candidate.kind === "tool") tools.add(candidate.id);
      else messages.add(candidate.message);
      estimate -= Math.floor(candidate.chars / 4);
    }
  }
  const elision: Elision = { tools, messages };
  const elided = tools.size + messages.size - previous.tools.size - previous.messages.size;
  if (tools.size + messages.size === 0) return { prompt, elision, elided: 0 };
  const replaced = prompt.content.map((message, index) => {
    if (message.role === "user" && messages.has(index)) {
      return Prompt.makeMessage("user", {
        content: message.content.map((part) =>
          part.type === "text" && isAttachment(part)
            ? Prompt.makePart("text", {
                text: elidedAttachmentStub(part.text),
                options: part.options,
              })
            : part,
        ),
        options: message.options,
      });
    }
    if (message.role !== "tool") return message;
    return Prompt.makeMessage("tool", {
      content: message.content.map((part) =>
        part.type === "tool-result" && tools.has(part.id)
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
    });
  });
  return { prompt: Prompt.fromMessages(replaced), elision, elided };
};

/** The elide budget for a model's window, or undefined when the window isn't known. */
export const budgetFor = (contextLength: number | null | undefined): ElideBudget | undefined =>
  contextLength
    ? {
        limit: Math.floor(contextLength * ELIDE_AT),
        target: Math.floor(contextLength * ELIDE_TO),
      }
    : undefined;

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
