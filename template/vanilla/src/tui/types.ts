/**
 * What the TUI components see of the app: plain data and promises. Built in launch.tsx, which
 * is the only TUI file that imports effect. Errors arrive already mapped to a message and
 * whether retrying can help.
 */
export interface UiError {
  readonly message: string;
  readonly retryable: boolean;
}

export type UiReply =
  | { readonly type: "reply"; readonly text: string; readonly usage: string }
  | { readonly type: "error"; readonly error: UiError };

export interface UiBridge {
  /** The model `ask` uses. */
  readonly model: string;
  /** One prompt to the model. Never rejects: failures resolve to an `error` reply. */
  readonly ask: (prompt: string) => Promise<UiReply>;
  readonly quit: () => void;
}
