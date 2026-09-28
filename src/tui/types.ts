/**
 * What the TUI components see of the app: plain data, promises, and async iterables. Built in
 * launch.tsx, which is the only TUI file that imports effect. Errors arrive already mapped to
 * a message and whether retrying can help.
 */
export interface UiToolCall {
  readonly name: string;
  readonly input: string;
}

export interface UiMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly tools: ReadonlyArray<UiToolCall>;
  /** Model, provider, tokens, cost (assistant replies only). */
  readonly usage?: string;
  readonly error?: UiError;
}

export interface UiError {
  readonly message: string;
  readonly retryable: boolean;
}

export type UiEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "tool"; readonly call: UiToolCall }
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
  /** Custom commands (`.orx/commands`, `~/.config/orx/commands`), loaded once per session. */
  readonly listCommands: () => Promise<ReadonlyArray<UiSlashItem>>;
  /** Skills (`.orx/skills`, `~/.config/orx/skills`), loaded once per session. */
  readonly listSkills: () => Promise<ReadonlyArray<UiSlashItem>>;
  /**
   * What `/name args` sends for a custom command (it wins a clash) or a skill, or undefined
   * when no command or skill has that name.
   */
  readonly expandCommand: (name: string, args: string) => Promise<UiExpansion | undefined>;
  /** Starts a new, empty chat on the same model (`/clear`); resolves to its id. */
  readonly newChat: () => Promise<string>;
}

export interface UiSlashItem {
  readonly name: string;
  readonly description: string;
}

export interface UiExpansion {
  readonly text: string;
  /** The model for this turn only, when a command's frontmatter names one. */
  readonly model?: string;
}
