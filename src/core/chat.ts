import { Clock, Duration, Effect, type Layer, Option, Ref, Stream } from "effect";
import { AiError, LanguageModel, Prompt, type Response } from "effect/unstable/ai";
import type { AssistantMessage, ChatId, ChatMessage, StoredChat, ToolStep, Usage } from "~/schemas";
import { loadConfig } from "../config";
import { NotFound } from "../errors";
import { ChatStore } from "../services/ChatStore";
import { Llm } from "../services/Llm";
import { ChatTools, type ChatToolsLive } from "../tools";

/** What the chat tools' handlers provide (ChatToolsLive in the app, the same layer in tests). */
type ToolHandlers = Layer.Success<typeof ChatToolsLive>;

import { timedOut, toUpstreamError } from "./upstream";

/**
 * What one chat turn emits, in order: text deltas and tool events as they happen, then one
 * `finish` with the whole reply (text, tools, usage summed over every step). `orx ask`
 * renders these as text or NDJSON; the TUI renders them as they stream.
 */
export type TurnEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "tool-call"; readonly name: string; readonly input: unknown }
  | {
      readonly type: "tool-result";
      readonly name: string;
      readonly output: unknown;
      readonly isFailure: boolean;
    }
  | { readonly type: "finish"; readonly reply: AssistantMessage };

/** Saved text only: tool calls stay in the stored chat for display and export, not the prompt. */
export const toPrompt = (systemPrompt: string, history: ReadonlyArray<ChatMessage>) =>
  Prompt.make([
    { role: "system", content: systemPrompt },
    ...history.map((message) => ({ role: message.role, content: message.text })),
  ]);

interface StepResult {
  readonly parts: ReadonlyArray<Response.AnyPart>;
  readonly finishReason: string;
}

interface TurnState {
  text: string;
  tools: ToolStep[];
  inputTokens: number;
  outputTokens: number;
  cost: number | undefined;
  model: string | undefined;
  provider: string | undefined;
  pendingCalls: Map<string, { name: string; input: unknown }>;
}

/** OpenRouter's provider and cost, from a finish part's metadata (extract reads it too). */
export const readOpenRouter = (part: Response.FinishPart) => {
  const openrouter = (part.metadata as Record<string, unknown> | undefined)?.openrouter as
    | { provider?: unknown; usage?: { cost?: unknown } }
    | undefined;
  return {
    provider: typeof openrouter?.provider === "string" ? openrouter.provider : undefined,
    cost: typeof openrouter?.usage?.cost === "number" ? openrouter.usage.cost : undefined,
  };
};

/**
 * One model step: streams the parts, records them into `state`, and emits TurnEvents. The step
 * is retried (twice, backing off from 500 ms) only while it hasn't emitted anything: once a part
 * reached the user, a retry would repeat it.
 */
const step = (
  model: LanguageModel.LanguageModel,
  prompt: Prompt.Prompt,
  state: Ref.Ref<TurnState>,
  collected: Ref.Ref<StepResult>,
) => {
  const attempt = Effect.gen(function* () {
    const emitted = yield* Ref.make(false);
    yield* Ref.set(collected, { parts: [], finishReason: "unknown" });
    const stream = LanguageModel.streamText({ prompt, toolkit: ChatTools }).pipe(
      Stream.provideService(LanguageModel.LanguageModel, model),
      Stream.tap((part) =>
        Ref.update(collected, (result) => ({
          parts: [...result.parts, part],
          finishReason: part.type === "finish" ? part.reason : result.finishReason,
        })),
      ),
      Stream.mapEffect((part) => toEvents(part, state)),
      Stream.flattenIterable,
      Stream.tap(() => Ref.set(emitted, true)),
    );
    return { stream, emitted };
  });

  const run = (
    retriesLeft: number,
    delay: Duration.Duration,
  ): Stream.Stream<TurnEvent, AiError.AiError, ToolHandlers> =>
    Stream.unwrap(
      Effect.map(attempt, ({ stream, emitted }) =>
        stream.pipe(
          Stream.catchIf(
            (error): error is AiError.AiError => AiError.isAiError(error),
            (error) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const started = yield* Ref.get(emitted);
                  if (started || retriesLeft === 0 || !error.isRetryable) return Stream.fail(error);
                  yield* Effect.logWarning("Model call failed before any output; retrying", {
                    reason: error.reason._tag,
                  });
                  yield* Effect.sleep(delay);
                  return run(retriesLeft - 1, Duration.times(delay, 2));
                }),
              ),
          ),
        ),
      ),
    );
  return run(2, Duration.millis(500));
};

/** A response part as TurnEvents (most parts are bookkeeping and emit nothing). */
const toEvents = (part: Response.AnyPart, state: Ref.Ref<TurnState>) =>
  Ref.modify(state, (s): [ReadonlyArray<TurnEvent>, TurnState] => {
    switch (part.type) {
      case "text-delta":
        return [[{ type: "text", delta: part.delta }], { ...s, text: s.text + part.delta }];
      case "response-metadata":
        return [[], { ...s, model: part.modelId ?? s.model }];
      case "tool-call": {
        const pendingCalls = new Map(s.pendingCalls);
        pendingCalls.set(part.id, { name: part.name, input: part.params });
        return [
          [{ type: "tool-call", name: part.name, input: part.params }],
          { ...s, pendingCalls },
        ];
      }
      case "tool-result": {
        const call = s.pendingCalls.get(part.id);
        const tool: ToolStep = {
          name: part.name,
          input: call?.input ?? null,
          output: part.encodedResult,
          isFailure: part.isFailure,
        };
        return [
          [
            {
              type: "tool-result",
              name: part.name,
              output: part.encodedResult,
              isFailure: part.isFailure,
            },
          ],
          { ...s, tools: [...s.tools, tool] },
        ];
      }
      case "finish": {
        const { provider, cost } = readOpenRouter(part);
        return [
          [],
          {
            ...s,
            inputTokens: s.inputTokens + (part.usage.inputTokens.total ?? 0),
            outputTokens: s.outputTokens + (part.usage.outputTokens.total ?? 0),
            cost: cost === undefined ? s.cost : (s.cost ?? 0) + cost,
            provider: provider ?? s.provider,
          },
        ];
      }
      default:
        return [[], s];
    }
  });

const toReply = (s: TurnState, finishReason: string, interrupted: boolean): AssistantMessage => {
  const usage: Usage = {
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    ...(s.cost === undefined ? {} : { cost: s.cost }),
  };
  return {
    role: "assistant",
    text: s.text,
    tools: s.tools,
    ...(s.model === undefined ? {} : { model: s.model }),
    ...(s.provider === undefined ? {} : { provider: s.provider }),
    usage,
    finishReason,
    ...(interrupted ? { interrupted: true } : {}),
  };
};

export interface TurnOptions {
  readonly history: ReadonlyArray<ChatMessage>;
  readonly modelId: string;
  /** Called once with the reply as far as it got, including when the turn fails or is interrupted. */
  readonly onEnd?: (reply: AssistantMessage) => Effect.Effect<void>;
}

/**
 * One chat turn: the model streams, calls tools, and is prompted again with their results
 * until it stops or MAX_TOOL_STEPS is reached. Effect AI resolves tool calls within a step
 * but has no step loop, so this is it. Logs one `llm call` line per turn.
 */
export const runTurn = (options: TurnOptions) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const llm = yield* Llm;
      const model = yield* llm.languageModel(options.modelId);
      const state = yield* Ref.make<TurnState>({
        text: "",
        tools: [],
        inputTokens: 0,
        outputTokens: 0,
        cost: undefined,
        model: undefined,
        provider: undefined,
        pendingCalls: new Map(),
      });
      const collected = yield* Ref.make<StepResult>({ parts: [], finishReason: "unknown" });
      const startedAt = yield* Clock.currentTimeMillis;
      const firstTokenAt = yield* Ref.make(Option.none<number>());
      // Complete only once `finish` went out: a consumer that stops early (the TUI's Esc, via
      // an async iterator's return) ends the stream with a Success exit, not an interruption.
      const finished = yield* Ref.make(false);

      const loop = (
        prompt: Prompt.Prompt,
        stepIndex: number,
      ): Stream.Stream<TurnEvent, AiError.AiError, ToolHandlers> =>
        step(model, prompt, state, collected).pipe(
          Stream.concat(
            Stream.unwrap(
              Effect.gen(function* () {
                const result = yield* Ref.get(collected);
                if (
                  result.finishReason === "tool-calls" &&
                  stepIndex + 1 < config.limits.maxToolSteps
                ) {
                  return loop(
                    Prompt.concat(prompt, Prompt.fromResponseParts(result.parts)),
                    stepIndex + 1,
                  );
                }
                const finish: TurnEvent = {
                  type: "finish",
                  reply: toReply(yield* Ref.get(state), result.finishReason, false),
                };
                return Stream.make(finish);
              }),
            ),
          ),
        );

      const finalize = (interrupted: boolean) =>
        Effect.gen(function* () {
          const s = yield* Ref.get(state);
          const { finishReason } = yield* Ref.get(collected);
          const reply = toReply(s, finishReason, interrupted);
          const ttft = yield* Ref.get(firstTokenAt);
          const endedAt = yield* Clock.currentTimeMillis;
          yield* Effect.logInfo("llm call").pipe(
            Effect.annotateLogs({
              requestedModel: options.modelId,
              model: reply.model ?? null,
              provider: reply.provider ?? null,
              finishReason,
              inputTokens: s.inputTokens,
              outputTokens: s.outputTokens,
              cost: s.cost ?? null,
              tools: s.tools.length,
              aborted: interrupted,
              timeToFirstTokenMs: Option.getOrNull(Option.map(ttft, (at) => at - startedAt)),
              durationMs: endedAt - startedAt,
            }),
          );
          if (options.onEnd) yield* options.onEnd(reply);
        });

      return loop(toPrompt(config.systemPrompt, options.history), 0).pipe(
        Stream.tap((event) =>
          event.type === "text"
            ? Effect.flatMap(Clock.currentTimeMillis, (now) =>
                Ref.update(firstTokenAt, (at) => (Option.isNone(at) ? Option.some(now) : at)),
              )
            : event.type === "finish"
              ? Ref.set(finished, true)
              : Effect.void,
        ),
        Stream.mapError(toUpstreamError),
        Stream.interruptWhen(
          Effect.sleep(config.limits.maxStreamDuration).pipe(
            Effect.andThen(Effect.fail(timedOut("The model reply"))),
          ),
        ),
        Stream.onExit((exit) =>
          Effect.flatMap(Ref.get(finished), (done) => finalize(exit._tag === "Failure" || !done)),
        ),
      );
    }),
  );

const now = () => new Date().toISOString();

/** A new chat, not yet saved. */
export const newChat = (id: ChatId, model: string): StoredChat => ({
  id,
  model,
  createdAt: now(),
  updatedAt: now(),
  messages: [],
});

/** The saved chat, or NotFound. */
export const loadChat = (id: ChatId) =>
  Effect.gen(function* () {
    const store = yield* ChatStore;
    const chat = yield* store.get(id);
    if (Option.isNone(chat)) {
      return yield* new NotFound({ message: `No saved chat ${id}. \`orx chats\` lists them.` });
    }
    return chat.value;
  });

/**
 * Sends one user message in a chat: runs the turn and saves the chat when it ends, with the
 * reply as far as it got (so Ctrl+C keeps the partial reply, marked interrupted).
 */
export const sendMessage = (chat: StoredChat, text: string, modelId: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* ChatStore;
      const history: ReadonlyArray<ChatMessage> = [...chat.messages, { role: "user", text }];
      return runTurn({
        history,
        modelId,
        onEnd: (reply) =>
          store.save({ ...chat, model: modelId, updatedAt: now(), messages: [...history, reply] }),
      });
    }),
  );
