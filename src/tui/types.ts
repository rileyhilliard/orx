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
  /** Once finished, one line saying what it did (`read src/x.ts · 120 lines`). */
  readonly summary?: string;
  /** The diff an edit applied. */
  readonly diff?: string;
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
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly isFailure: boolean;
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
  /**
   * Workspace files and directories (`dir/`), root-relative, for the `@` picker. Walked on the
   * first call; later calls answer from the last walk and refresh it for the next one.
   */
  readonly listFiles: () => Promise<ReadonlyArray<string>>;
  /**
   * The message as the model should get it: `text` plus a `<file>` block (numbered lines) for
   * each `@path` naming a workspace file, and a listing for each `@dir/`. Never rejects; with
   * nothing to attach it resolves to `text`.
   */
  readonly attachFiles: (text: string) => Promise<string>;
  /** Answers an approval request; an unknown id (already answered or cancelled) is ignored. */
  readonly answer: (id: string, decision: UiDecision) => Promise<void>;
  readonly setMode: (mode: UiMode) => Promise<void>;
  /**
   * Calls `onMode` with the permission mode now and on every change (an "always" answer to an
   * edit switches it too). Returns an unsubscribe. Without a session, never calls it.
   */
  readonly watchMode: (onMode: (mode: UiMode) => void) => () => void;
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
