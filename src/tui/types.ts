/**
 * What the TUI components see of the app: plain data, promises, and async iterables. Built in
 * launch.tsx, which is the only TUI file that imports effect. Errors arrive already mapped to
 * a message and whether retrying can help.
 */
export interface UiToolCall {
  /** Matches the call's `tool-result` event. */
  readonly id?: string;
  readonly name: string;
  readonly input: string;
  /** Running until its result arrives; a saved call is ok or error. */
  readonly status?: "running" | "ok" | "error";
}

export interface UiMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly tools: ReadonlyArray<UiToolCall>;
  /** Model, provider, tokens, cost (assistant replies only). */
  readonly usage?: string;
  readonly error?: UiError;
  /** Why the reply stopped early without failing (the step cap, a repeated tool call). */
  readonly note?: string;
}

export interface UiError {
  readonly message: string;
  readonly retryable: boolean;
}

export type UiEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "tool"; readonly call: UiToolCall }
  | { readonly type: "tool-result"; readonly id: string; readonly isFailure: boolean }
  | { readonly type: "note"; readonly message: string }
  | { readonly type: "done"; readonly usage: string }
  | { readonly type: "error"; readonly error: UiError };

export interface UiModel {
  readonly id: string;
  readonly name: string;
}

export interface ChatBridge {
  readonly chatId: string;
  readonly initialModel: string;
  readonly history: ReadonlyArray<UiMessage>;
  /** One turn. Ending the iteration early (`return()`) stops the reply and saves it as interrupted. */
  readonly send: (text: string, model: string) => AsyncIterable<UiEvent>;
  readonly listModels: () => Promise<{
    readonly models: ReadonlyArray<UiModel>;
    readonly available: boolean;
  }>;
  /**
   * Writes the chat as Markdown into the current directory. Resolves to the status line to
   * show ("Exported to …", "Overwrote …", or why it failed); never rejects.
   */
  readonly exportMarkdown: () => Promise<string>;
  readonly quit: () => void;
}
