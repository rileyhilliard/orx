import { Cause, Clock, Duration, Effect, Exit, type Layer, Option, Ref, Stream } from "effect";
import { AiError, LanguageModel, Prompt, Response, type Toolkit } from "effect/unstable/ai";
import type { AssistantMessage, ChatId, ChatMessage, StoredChat, ToolStep, Usage } from "~/schemas";
import { loadConfig } from "../config";
import { isAppError, NotFound, UpstreamUnavailable } from "../errors";
import { ChatStore } from "../services/ChatStore";
import { Llm } from "../services/Llm";
import { OpenRouterModels } from "../services/OpenRouterModels";
import { type ApprovalEvent, Permissions } from "../services/permissions";
import { ChatTools, type ChatToolsLive } from "../tools";
import { budgetFor, canElide, elide, withCacheBreakpoints } from "./context";
import { isContextLengthError, timedOut, toUpstreamError } from "./upstream";

/** What the chat tools' handlers need (ChatToolsLive in the app, the same layer in tests). */
export type ChatToolHandlers = Layer.Success<typeof ChatToolsLive>;

/**
 * The tools a turn offers, with their handlers: a `Toolkit` (it is an Effect that needs its
 * handler layer, `R`). Tools must use `failureMode: "return"`, so a failing tool is a result
 * the model sees rather than a failed turn.
 */
// biome-ignore lint/suspicious/noExplicitAny: WithHandler is invariant in its tools; any toolkit fits.
export type TurnToolkit<R> = Effect.Effect<Toolkit.WithHandler<any>, never, R>;

/** The toolkit a turn uses unless the caller passes one. */
export const defaultToolkit: TurnToolkit<ChatToolHandlers> = ChatTools;

/** The same tool with identical input this many times in a row ends the turn with a note. */
export const MAX_REPEATED_CALLS = 3;

/** The result the model sees for a tool call the user interrupted before it finished. */
export const INTERRUPTED_RESULT = "Interrupted by the user before the tool finished.";

/**
 * What one chat turn emits, in order: text deltas and tool events as they happen, a `note` when
 * the turn stops early without failing (the step cap, a repeated tool call), then one `finish`
 * with the whole reply (text, tools, usage summed over every step). `orx ask` renders these as
 * text or NDJSON; the TUI renders them as they stream.
 */
export type TurnEvent =
  | { readonly type: "text"; readonly delta: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly output: unknown;
      readonly isFailure: boolean;
    }
  | { readonly type: "note"; readonly message: string }
  | { readonly type: "finish"; readonly reply: AssistantMessage }
  | ApprovalEvent;

/** An assistant message worth sending: some text, or a tool call. Providers reject empty ones. */
const isEmptyAssistant = (message: Prompt.Message) =>
  message.role === "assistant" &&
  message.content.every((part) => part.type === "text" && part.text === "");

/** Provider options without OpenRouter's `reasoningDetails`. */
const withoutReasoningDetails = <O extends Prompt.ProviderOptions>(options: O): O => {
  const openrouter = options.openrouter as Record<string, unknown> | undefined;
  if (openrouter?.reasoningDetails === undefined) return options;
  const { reasoningDetails: _, ...rest } = openrouter;
  return { ...options, openrouter: rest };
};

/**
 * A replayed message without the reasoning another model produced: reasoning parts and the
 * `reasoning_details` OpenRouter attaches to the message and its tool calls are provider-specific
 * (signed or encrypted), and a different model can reject them.
 */
const withoutReasoning = (message: Prompt.Message): Prompt.Message => {
  if (message.role !== "assistant") return message;
  return Prompt.makeMessage("assistant", {
    content: message.content
      .filter((part) => part.type !== "reasoning")
      .map((part) =>
        part.type === "tool-call"
          ? Prompt.makePart("tool-call", {
              ...part,
              options: withoutReasoningDetails(part.options),
            })
          : part,
      ),
    options: withoutReasoningDetails(message.options),
  });
};

/**
 * The prompt for a chat: the system prompt, then each message. A reply with `steps` replays
 * them verbatim (tool calls with their ids and results, reasoning details); a reply saved
 * before steps existed replays its text. Given the turn's `modelId`, a reply another model
 * produced replays without its reasoning (switching models mid-chat). An assistant message
 * with no text is left out: some providers reject empty assistant content.
 */
export const toPrompt = (
  systemPrompt: string,
  history: ReadonlyArray<ChatMessage>,
  modelId?: string,
) => {
  const messages: Prompt.Message[] = [Prompt.makeMessage("system", { content: systemPrompt })];
  for (const message of history) {
    if (message.role === "user") {
      messages.push(
        Prompt.makeMessage("user", {
          content: [Prompt.makePart("text", { text: message.text })],
        }),
      );
    } else if (message.steps !== undefined && message.steps.length > 0) {
      const producer = message.requestedModel ?? message.model;
      const switched = modelId !== undefined && producer !== undefined && producer !== modelId;
      for (const step of message.steps) {
        const replayed = switched ? step.content.map(withoutReasoning) : step.content;
        messages.push(...replayed.filter((m) => !isEmptyAssistant(m)));
      }
    } else if (message.text !== "") {
      messages.push(
        Prompt.makeMessage("assistant", {
          content: [Prompt.makePart("text", { text: message.text })],
        }),
      );
    }
  }
  return Prompt.fromMessages(messages);
};

interface StepResult {
  readonly parts: ReadonlyArray<Response.AnyPart>;
  readonly finishReason: string;
}

interface TurnState {
  text: string;
  tools: ToolStep[];
  /** Completed model steps, as the next request replays them. */
  steps: Prompt.Prompt[];
  inputTokens: number;
  outputTokens: number;
  cost: number | undefined;
  model: string | undefined;
  provider: string | undefined;
  pendingCalls: Map<string, { name: string; input: unknown }>;
  /** The last tool call's name and input, and how many times in a row it was made. */
  lastCall: { key: string; name: string; count: number } | undefined;
}

/** When the model last sent a part, and how many tool calls are running (not idle time). */
interface Activity {
  readonly at: number;
  readonly running: number;
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
 * A step's parts as the prompt the next request replays. For a step that was cut off, text or
 * reasoning still streaming is closed, and every tool call without a result gets a synthetic
 * failure (an unanswered tool call id fails the next request).
 */
export const stepPrompt = (parts: ReadonlyArray<Response.AnyPart>, interrupted: boolean) => {
  if (!interrupted) return Prompt.fromResponseParts(parts);
  const open = new Map<string, "text-end" | "reasoning-end">();
  const calls = new Map<string, string>();
  for (const part of parts) {
    if (part.type === "text-start") open.set(part.id, "text-end");
    if (part.type === "reasoning-start") open.set(part.id, "reasoning-end");
    if (part.type === "text-end" || part.type === "reasoning-end") open.delete(part.id);
    if (part.type === "tool-call") calls.set(part.id, part.name);
    if (part.type === "tool-result") calls.delete(part.id);
  }
  const closed = [
    ...parts,
    ...[...open].map(
      ([id, type]): Response.AnyPart =>
        type === "text-end"
          ? Response.makePart("text-end", { id })
          : Response.makePart("reasoning-end", { id }),
    ),
  ];
  const step = Prompt.fromResponseParts(closed);
  if (calls.size === 0) return step;
  return Prompt.concat(
    step,
    Prompt.fromMessages([
      Prompt.makeMessage("tool", {
        content: [...calls].map(([id, name]) =>
          Prompt.makePart("tool-result", {
            id,
            name,
            isFailure: true,
            result: INTERRUPTED_RESULT,
            providerExecuted: false,
          }),
        ),
      }),
    ]),
  );
};

interface StepOptions<R> {
  readonly model: LanguageModel.LanguageModel;
  readonly toolkit: TurnToolkit<R>;
  readonly prompt: Prompt.Prompt;
  /** The prompt to retry with once if the provider says this one is too long. */
  readonly shorter: Effect.Effect<Prompt.Prompt>;
  readonly state: Ref.Ref<TurnState>;
  readonly collected: Ref.Ref<StepResult>;
  readonly activity: Ref.Ref<Activity>;
}

/**
 * One model step: streams the parts, records them into `state`, and emits TurnEvents. The step
 * is retried (twice, backing off from 500 ms) only while it hasn't emitted anything: once a part
 * reached the user, a retry would repeat it. A context-length rejection is retried once with a
 * harder-elided prompt.
 */
const step = <R>(options: StepOptions<R>) => {
  const { model, toolkit, state, collected, activity } = options;
  const touch = (running: (n: number) => number) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) =>
      Ref.update(activity, (a) => ({ at, running: running(a.running) })),
    );
  const attempt = (prompt: Prompt.Prompt) =>
    Effect.gen(function* () {
      const emitted = yield* Ref.make(false);
      yield* Ref.set(collected, { parts: [], finishReason: "unknown" });
      // The toolkit's type is erased (TurnToolkit), so the stream's is restated here.
      const parts = LanguageModel.streamText({ prompt, toolkit }) as Stream.Stream<
        Response.AnyPart,
        AiError.AiError,
        LanguageModel.LanguageModel | R
      >;
      const stream = parts.pipe(
        Stream.provideService(LanguageModel.LanguageModel, model),
        Stream.tap((part) =>
          touch((n) =>
            part.type === "tool-call"
              ? n + 1
              : part.type === "tool-result" && part.preliminary !== true
                ? Math.max(0, n - 1)
                : n,
          ),
        ),
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
    prompt: Prompt.Prompt,
    retriesLeft: number,
    delay: Duration.Duration,
    shortened: boolean,
  ): Stream.Stream<TurnEvent, AiError.AiError, R> =>
    Stream.unwrap(
      Effect.map(attempt(prompt), ({ stream, emitted }) =>
        stream.pipe(
          Stream.catchIf(
            (error): error is AiError.AiError => AiError.isAiError(error),
            (error) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const started = yield* Ref.get(emitted);
                  if (!started && !shortened && isContextLengthError(error)) {
                    yield* Effect.logWarning("Prompt too long for the model; eliding and retrying");
                    return run(yield* options.shorter, retriesLeft, delay, true);
                  }
                  if (started || retriesLeft === 0 || !error.isRetryable) return Stream.fail(error);
                  yield* Effect.logWarning("Model call failed before any output; retrying", {
                    reason: error.reason._tag,
                  });
                  yield* Effect.sleep(delay);
                  return run(prompt, retriesLeft - 1, Duration.times(delay, 2), shortened);
                }),
              ),
          ),
        ),
      ),
    );
  return run(options.prompt, 2, Duration.millis(500), false);
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
        const key = `${part.name}\u0000${JSON.stringify(part.params)}`;
        const count = s.lastCall?.key === key ? s.lastCall.count + 1 : 1;
        return [
          [{ type: "tool-call", id: part.id, name: part.name, input: part.params }],
          { ...s, pendingCalls, lastCall: { key, name: part.name, count } },
        ];
      }
      case "tool-result": {
        if (part.preliminary === true) return [[], s];
        const pendingCalls = new Map(s.pendingCalls);
        const call = pendingCalls.get(part.id);
        pendingCalls.delete(part.id);
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
              id: part.id,
              name: part.name,
              output: part.encodedResult,
              isFailure: part.isFailure,
            },
          ],
          { ...s, tools: [...s.tools, tool], pendingCalls },
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

const toReply = (
  requestedModel: string,
  s: TurnState,
  finishReason: string,
  interrupted: boolean,
  partial: ReadonlyArray<Response.AnyPart>,
): AssistantMessage => {
  const usage: Usage = {
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    ...(s.cost === undefined ? {} : { cost: s.cost }),
  };
  // A cut-off step is kept as far as it got; its unfinished tool calls count as failed.
  const lastStep = interrupted && partial.length > 0 ? [stepPrompt(partial, true)] : [];
  const steps = [...s.steps, ...lastStep].filter((step) => step.content.length > 0);
  const unfinished: ToolStep[] = interrupted
    ? [...s.pendingCalls.values()].map(({ name, input }) => ({
        name,
        input,
        output: INTERRUPTED_RESULT,
        isFailure: true,
      }))
    : [];
  return {
    role: "assistant",
    text: s.text,
    tools: [...s.tools, ...unfinished],
    ...(steps.length > 0 ? { steps } : {}),
    requestedModel,
    ...(s.model === undefined ? {} : { model: s.model }),
    ...(s.provider === undefined ? {} : { provider: s.provider }),
    usage,
    finishReason,
    ...(interrupted ? { interrupted: true } : {}),
  };
};

export interface TurnOptions<R = ChatToolHandlers> {
  readonly history: ReadonlyArray<ChatMessage>;
  readonly modelId: string;
  /** The tools the model may call, and with them the handlers `R`. Default: `defaultToolkit`. */
  readonly toolkit?: TurnToolkit<R>;
  /** The system prompt. Default: SYSTEM_PROMPT from the config. */
  readonly systemPrompt?: string;
  /** Called once with the reply as far as it got, including when the turn fails or is interrupted. */
  readonly onEnd?: (reply: AssistantMessage) => Effect.Effect<void>;
}

/** The model's context window from the models list, or undefined when it can't be known. */
const contextLengthOf = (modelId: string) =>
  Effect.gen(function* () {
    const models = yield* (yield* OpenRouterModels).list;
    const base = modelId.split(":", 1)[0];
    const model = models.find((m) => m.id === modelId) ?? models.find((m) => m.id === base);
    return model?.contextLength ?? undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * One chat turn: the model streams, calls tools, and is prompted again with their results
 * until it stops, MAX_TOOL_STEPS is reached, or it repeats one call MAX_REPEATED_CALLS times.
 * Effect AI resolves tool calls within a step but has no step loop, so this is it. Before each
 * step, old tool outputs are elided if the prompt nears the model's context window. The reply
 * fails when the model sends nothing for MAX_STREAM_SECONDS (tool runs don't count). Logs one
 * `llm call` line per turn.
 */
export const runTurn = <R = ChatToolHandlers>(options: TurnOptions<R>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const llm = yield* Llm;
      const model = yield* llm.languageModel(options.modelId);
      // With no toolkit given, R is its default, ChatToolHandlers.
      const toolkit = (options.toolkit ?? defaultToolkit) as TurnToolkit<R>;
      const cacheBreakpoints = options.modelId.startsWith("anthropic/");
      const models = yield* OpenRouterModels;
      const contextLength = yield* Effect.cached(
        contextLengthOf(options.modelId).pipe(Effect.provideService(OpenRouterModels, models)),
      );
      const state = yield* Ref.make<TurnState>({
        text: "",
        tools: [],
        steps: [],
        inputTokens: 0,
        outputTokens: 0,
        cost: undefined,
        model: undefined,
        provider: undefined,
        pendingCalls: new Map(),
        lastCall: undefined,
      });
      const collected = yield* Ref.make<StepResult>({ parts: [], finishReason: "unknown" });
      const startedAt = yield* Clock.currentTimeMillis;
      const activity = yield* Ref.make<Activity>({ at: startedAt, running: 0 });
      const firstTokenAt = yield* Ref.make(Option.none<number>());
      // Complete only once `finish` went out: a consumer that stops early (the TUI's Esc, via
      // an async iterator's return) ends the stream with a Success exit, not an interruption.
      const finished = yield* Ref.make(false);

      /** The prompt as sent: old tool outputs elided to fit, and cache breakpoints. */
      const prepare = (prompt: Prompt.Prompt, harder: boolean) =>
        Effect.gen(function* () {
          let sent = prompt;
          if (canElide(prompt)) {
            const budget = harder ? 0 : budgetFor(yield* contextLength);
            if (budget !== undefined) {
              const result = elide(prompt, budget);
              if (result.elided > 0) {
                yield* Effect.logInfo("Elided old tool outputs").pipe(
                  Effect.annotateLogs({ elided: result.elided, harder }),
                );
              }
              sent = result.prompt;
            }
          }
          return cacheBreakpoints ? withCacheBreakpoints(sent) : sent;
        });

      const loop = (
        prompt: Prompt.Prompt,
        stepIndex: number,
      ): Stream.Stream<TurnEvent, AiError.AiError, R> =>
        Stream.unwrap(
          Effect.map(prepare(prompt, false), (sent) =>
            step({
              model,
              toolkit,
              prompt: sent,
              shorter: prepare(prompt, true),
              state,
              collected,
              activity,
            }).pipe(
              Stream.concat(
                Stream.unwrap(
                  Effect.gen(function* () {
                    const result = yield* Ref.get(collected);
                    const done = Prompt.fromResponseParts(result.parts);
                    const s = yield* Ref.updateAndGet(state, (s) => ({
                      ...s,
                      steps: [...s.steps, done],
                    }));
                    // The step is recorded; nothing of it is partial any more.
                    yield* Ref.set(collected, { parts: [], finishReason: result.finishReason });
                    let note: string | undefined;
                    if (result.finishReason === "tool-calls") {
                      if (s.lastCall !== undefined && s.lastCall.count >= MAX_REPEATED_CALLS) {
                        note = `Stopped: the model called ${s.lastCall.name} with the same input ${s.lastCall.count} times in a row.`;
                      } else if (stepIndex + 1 >= config.limits.maxToolSteps) {
                        note = `Stopped after ${config.limits.maxToolSteps} model steps (MAX_TOOL_STEPS). Send a message to continue.`;
                      } else {
                        return loop(Prompt.concat(prompt, done), stepIndex + 1);
                      }
                    }
                    const events: TurnEvent[] = note ? [{ type: "note", message: note }] : [];
                    events.push({
                      type: "finish",
                      reply: toReply(options.modelId, s, result.finishReason, false, []),
                    });
                    return Stream.fromIterable(events);
                  }),
                ),
              ),
            ),
          ),
        );

      // Fails the turn once the model has sent nothing for the idle timeout while no tool runs.
      const idleMs = Duration.toMillis(config.limits.streamIdleTimeout);
      const watchdog = Effect.gen(function* () {
        while (true) {
          const { at, running } = yield* Ref.get(activity);
          const now = yield* Clock.currentTimeMillis;
          if (running === 0 && now - at >= idleMs) {
            return yield* timedOut("The model reply");
          }
          yield* Effect.sleep(Duration.millis(running > 0 ? idleMs : idleMs - (now - at)));
        }
      });

      const finalize = (exit: Exit.Exit<unknown, unknown>, done: boolean) =>
        Effect.gen(function* () {
          // Anything short of `finish` is interrupted in the saved reply. In the log, `aborted`
          // means the user (or a closed consumer) stopped it; a failure has its own fields.
          const interrupted = !done;
          const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
          const error = Option.getOrUndefined(failure);
          const s = yield* Ref.get(state);
          const { finishReason, parts } = yield* Ref.get(collected);
          const reply = toReply(options.modelId, s, finishReason, interrupted, parts);
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
              steps: s.steps.length,
              aborted: interrupted && error === undefined,
              errorTag: isAppError(error) ? error._tag : null,
              errorDetail:
                error instanceof UpstreamUnavailable ? (error.detail ?? error.message) : null,
              timeToFirstTokenMs: Option.getOrNull(Option.map(ttft, (at) => at - startedAt)),
              durationMs: endedAt - startedAt,
            }),
          );
          if (options.onEnd) yield* options.onEnd(reply);
        });

      // A tool waiting on the user's approval (Permissions, when the session has it) shows up
      // here as `approval-request`; a cancellation only for a request this turn showed.
      const permissions = yield* Effect.serviceOption(Permissions);
      const shown = new Set<string>();
      const approvals: Stream.Stream<TurnEvent> = Option.match(permissions, {
        onNone: () => Stream.empty,
        onSome: (p) =>
          p.events.pipe(
            Stream.filter((event) => {
              if (event.type === "approval-request") shown.add(event.id);
              return shown.has(event.id);
            }),
          ),
      });
      const cancelApprovals = Option.match(permissions, {
        onNone: () => Effect.void,
        onSome: (p) => Effect.asVoid(p.cancelAll),
      });

      return loop(
        toPrompt(options.systemPrompt ?? config.systemPrompt, options.history, options.modelId),
        0,
      ).pipe(
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
        Stream.merge(approvals, { haltStrategy: "left" }),
        Stream.interruptWhen(watchdog),
        Stream.onExit((exit) =>
          Effect.andThen(
            cancelApprovals,
            Effect.flatMap(Ref.get(finished), (done) => finalize(exit, done)),
          ),
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

/** What `sendMessage` can change about the turn. */
export interface SendOptions<R = ChatToolHandlers> {
  /** The tools the model may call. Default: `defaultToolkit`. */
  readonly toolkit?: TurnToolkit<R>;
  /** The system prompt. Default: SYSTEM_PROMPT from the config. */
  readonly systemPrompt?: string;
}

/**
 * Sends one user message in a chat: runs the turn and saves the chat when it ends, with the
 * reply as far as it got (so Ctrl+C keeps the partial reply, marked interrupted). A turn that
 * ends before any text or tool call saves nothing: the chat stays as it was, and sending the
 * message again is the retry.
 */
export const sendMessage = <R = ChatToolHandlers>(
  chat: StoredChat,
  text: string,
  modelId: string,
  options: SendOptions<R> = {},
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* ChatStore;
      const history: ReadonlyArray<ChatMessage> = [...chat.messages, { role: "user", text }];
      return runTurn<R>({
        history,
        modelId,
        ...(options.toolkit ? { toolkit: options.toolkit } : {}),
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        onEnd: (reply) =>
          reply.interrupted && reply.text === "" && reply.tools.length === 0
            ? Effect.void
            : store.save({
                ...chat,
                model: modelId,
                updatedAt: now(),
                messages: [...history, reply],
              }),
      });
    }),
  );
