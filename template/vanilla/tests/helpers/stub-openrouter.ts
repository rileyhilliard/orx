import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A model entry in OpenRouter's wire format (snake_case), as GET /models returns it. */
export interface StubModel {
  id: string;
  /** Defaults to `id`. Real entries often differ (a dated variant the API reports as served). */
  canonical_slug?: string;
  name: string;
  context_length?: number;
  prompt?: string;
  completion?: string;
}

export interface StubCompletion {
  text: string;
  model?: string;
  provider?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; cost?: number };
}

/** An HTTP error for POST /chat/completions, the way OpenRouter fails before a stream starts. */
export interface CompletionFailure {
  status: number;
  /** JSON body. Defaults to OpenRouter's shape: `{ error: { message, code } }`. */
  body?: unknown;
  /** Response headers, e.g. `retry-after-ms` so the AI SDK's retries don't wait seconds. */
  headers?: Record<string, string>;
  /** Fail this many requests, then serve normally again. Omitted: every request. */
  times?: number;
}

export interface StubOpenRouter {
  /** Base URL to use as OPENROUTER_BASE_URL (ends in /api/v1, like the real one). */
  readonly baseUrl: string;
  /** Parsed JSON bodies of every POST /chat/completions. */
  readonly chatRequests: unknown[];
  /** Count of GET /models requests. */
  modelsRequests: number;
  /** Fail the next N GET /models requests with a 500. */
  failModels: number;
  /**
   * Stream this many text deltas of the reply, then hang until the client disconnects. A
   * non-streaming request hangs without an answer.
   */
  hangAfter: number | undefined;
  /** Stream this many text deltas of the reply, then drop the connection (with hangAfter unset). */
  dropAfter: number | undefined;
  /** Answer POST /chat/completions with this error. */
  failCompletions: CompletionFailure | undefined;
  models: StubModel[];
  completion: StubCompletion;
  /**
   * Streamed tool calls, one per POST /chat/completions, each ending
   * with `finish_reason: "tool_calls"`. `arguments` is the raw JSON text the model sent.
   */
  toolCalls: Array<{ name: string; arguments: string }>;
  close(): Promise<void>;
}

const modelJson = (model: StubModel) => ({
  id: model.id,
  canonical_slug: model.canonical_slug ?? model.id,
  name: model.name,
  created: 1_700_000_000,
  description: "",
  context_length: model.context_length ?? 128_000,
  architecture: {
    modality: "text->text",
    input_modalities: ["text"],
    output_modalities: ["text"],
    tokenizer: "Other",
    instruct_type: null,
  },
  pricing: { prompt: model.prompt ?? "0.0000001", completion: model.completion ?? "0.0000004" },
  top_provider: {
    context_length: model.context_length ?? 128_000,
    max_completion_tokens: null,
    is_moderated: false,
  },
  per_request_limits: null,
  supported_parameters: ["tools", "max_tokens"],
  default_parameters: null,
  links: { details: `/api/v1/models/${model.id}/endpoints` },
  supported_voices: null,
});

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

/**
 * A local stand-in for the OpenRouter API: GET /models and streaming POST /chat/completions.
 * Tests, e2e, and `bun run stub` point orx at it through OPENROUTER_BASE_URL. A request with
 * `stream: false` (`orx ask`) gets one JSON completion of
 * `completion.text`. Port 0 (the default) picks a free port.
 */
export const startStubOpenRouter = async (port = 0): Promise<StubOpenRouter> => {
  const state = {
    chatRequests: [] as unknown[],
    modelsRequests: 0,
    failModels: 0,
    failCompletions: undefined as CompletionFailure | undefined,
    dropAfter: undefined as number | undefined,
    hangAfter: undefined as number | undefined,
    models: [
      { id: "openai/gpt-test", name: "OpenAI: GPT Test" },
      { id: "acme/cheap-model", name: "Acme: Cheap Model" },
    ] as StubModel[],
    completion: {
      text: "Hello from the stub.",
      model: "openai/gpt-test",
      provider: "StubProvider",
      usage: { prompt_tokens: 12, completion_tokens: 5, cost: 0.00042 },
    } as StubCompletion,
    toolCalls: [] as Array<{ name: string; arguments: string }>,
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/v1/models") {
      state.modelsRequests += 1;
      if (state.failModels > 0) {
        state.failModels -= 1;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub failure", code: 500 } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: state.models.map(modelJson),
          links: { next: null },
          total_count: state.models.length,
        }),
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/chat/completions") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      state.chatRequests.push(body);
      const failure = state.failCompletions;
      if (failure !== undefined) {
        if (failure.times !== undefined) {
          failure.times -= 1;
          if (failure.times <= 0) state.failCompletions = undefined;
        }
        res.writeHead(failure.status, { "content-type": "application/json", ...failure.headers });
        res.end(
          JSON.stringify(
            failure.body ?? {
              error: { message: `stub failure ${failure.status}`, code: failure.status },
            },
          ),
        );
        return;
      }
      const { text, model, provider, usage } = state.completion;
      const usageJson = usage
        ? { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens }
        : undefined;
      if (body.stream !== true) {
        // A non-streaming request with hangAfter set never gets an answer.
        if (state.hangAfter !== undefined) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "gen-stub-1",
            object: "chat.completion",
            created: 1,
            system_fingerprint: "stub",
            model,
            provider,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: text },
                finish_reason: "stop",
              },
            ],
            usage: usageJson,
          }),
        );
        return;
      }
      const partial = state.hangAfter ?? state.dropAfter;
      if (partial !== undefined) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const words = text.split(/(?<= )/).slice(0, partial);
        for (const word of words) {
          const chunk = {
            id: "gen-stub-1",
            object: "chat.completion.chunk",
            created: 1,
            model,
            provider,
            choices: [
              { index: 0, delta: { role: "assistant", content: word }, finish_reason: null },
            ],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        // hangAfter never ends: the client has to give up (a timeout, Ctrl+C).
        if (state.hangAfter === undefined) setTimeout(() => res.destroy(), 10);
        return;
      }
      const base = {
        id: "gen-stub-1",
        object: "chat.completion.chunk",
        created: 1,
        model,
        provider,
      };
      const toolCall = state.toolCalls.shift();
      if (toolCall !== undefined) {
        const call = {
          index: 0,
          id: `call_stub_${state.chatRequests.length}`,
          type: "function",
          function: toolCall,
        };
        const toolChunks = [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] } }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          { ...base, choices: [], usage: usageJson },
        ];
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        for (const chunk of toolChunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      const chunks = [
        {
          ...base,
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
        },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        {
          ...base,
          choices: [],
          usage: usageJson,
        },
      ];
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no stub for ${req.method} ${url.pathname}` } }));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: listening } = server.address() as AddressInfo;

  const stub: StubOpenRouter = {
    baseUrl: `http://127.0.0.1:${listening}/api/v1`,
    get chatRequests() {
      return state.chatRequests;
    },
    get modelsRequests() {
      return state.modelsRequests;
    },
    set modelsRequests(value) {
      state.modelsRequests = value;
    },
    get failModels() {
      return state.failModels;
    },
    set failModels(value) {
      state.failModels = value;
    },
    get hangAfter() {
      return state.hangAfter;
    },
    set hangAfter(value) {
      state.hangAfter = value;
    },
    get dropAfter() {
      return state.dropAfter;
    },
    set dropAfter(value) {
      state.dropAfter = value;
    },
    get failCompletions() {
      return state.failCompletions;
    },
    set failCompletions(value) {
      state.failCompletions = value === undefined ? undefined : { ...value };
    },
    get models() {
      return state.models;
    },
    set models(value) {
      state.models = value;
    },
    get completion() {
      return state.completion;
    },
    set completion(value) {
      state.completion = value;
    },
    get toolCalls() {
      return state.toolCalls;
    },
    set toolCalls(value) {
      state.toolCalls = [...value];
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        // Bun's node:http reports an already-stopped server as an error; stopped is the goal.
        server.close((error) =>
          error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            ? reject(error)
            : resolve(),
        );
      }),
  };
  return stub;
};
