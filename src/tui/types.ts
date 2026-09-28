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
  /** Running until its result arrives; then ok, error, or denied (by the user or the mode). */
  readonly status?: UiToolStatus;
  /** Once finished, one line saying what it did (`read src/x.ts · 120 lines`). */
  readonly summary?: string;
  /** The diff an edit or write applied. */
  readonly diff?: string;
}

export type UiToolStatus = "running" | "ok" | "error" | "denied";

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
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly status: Exclude<UiToolStatus, "running">;
      readonly summary?: string;
      readonly diff?: string;
    }
  | { readonly type: "approval"; readonly request: UiApproval }
  | { readonly type: "approval-cancelled"; readonly id: string }
  | { readonly type: "note"; readonly message: string }
  | { readonly type: "done"; readonly usage: string }
  | { readonly type: "error"; readonly error: UiError };

/** A tool call waiting for the user: answer it with `ChatBridge.answer`. */
export interface UiApproval {
  readonly id: string;
  readonly tool: string;
  /** The command for bash, or what a write or edit does ("Edit src/x.ts"). */
  readonly summary: string;
  /** The unified diff a write or edit would apply. */
  readonly diff?: string;
  /** Whether "always" is on offer. */
  readonly canAlways: boolean;
}

export type UiDecision = "yes" | "always" | { readonly no: string };

/** How much the agent may do without asking (Permissions). */
export type UiMode = "default" | "acceptEdits" | "plan" | "yolo";

export interface UiModel {
  readonly id: string;
  readonly name: string;
}

export interface ChatBridge {
  readonly chatId: string;
  readonly initialModel: string;
  readonly history: ReadonlyArray<UiMessage>;
  /**
   * One turn for `text` as typed; the bridge attaches the files its `@path` mentions for the
   * model. Ending the iteration early (`return()`) stops the reply and saves it as interrupted.
   */
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
   * What loading the commands and skills warned about (a file that didn't load, a skill over
   * its size limits, a skill named like a command), one line each; shown when the session starts.
   */
  readonly loadWarnings: () => Promise<ReadonlyArray<string>>;
  /**
   * What `/name args` sends for a custom command (it wins a clash) or a skill, or undefined
   * when no command or skill has that name. A command whose `model:` is unknown or can't call
   * tools resolves to `{ error }` instead, the line to show.
   */
  readonly expandCommand: (name: string, args: string) => Promise<UiExpansion | undefined>;
  /**
   * Workspace files and directories (`dir/`), root-relative, for the `@` picker. Walked on the
   * first call; later calls answer from the last walk and refresh it for the next one.
   */
  readonly listFiles: () => Promise<ReadonlyArray<string>>;
  /** Answers an approval request; an unknown id (already answered or cancelled) is ignored. */
  readonly answer: (id: string, decision: UiDecision) => Promise<void>;
  readonly setMode: (mode: UiMode) => Promise<void>;
  /**
   * Calls `onMode` with the permission mode now and on every change (an "always" answer to an
   * edit switches it too). Returns an unsubscribe.
   */
  readonly watchMode: (onMode: (mode: UiMode) => void) => () => void;
  /** Starts a new, empty chat on the same model (`/clear`); resolves to its id. */
  readonly newChat: () => Promise<string>;
}

export interface UiSlashItem {
  readonly name: string;
  readonly description: string;
}

export type UiExpansion =
  | {
      readonly text: string;
      /** The model for this turn only, when a command's frontmatter names one. */
      readonly model?: string;
    }
  | { readonly error: string };
