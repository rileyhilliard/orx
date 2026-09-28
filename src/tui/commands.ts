/**
 * Slash commands in the composer: parsing, and the built-ins app.tsx runs itself. Custom
 * commands and skills come from the bridge (`listCommands`, `listSkills`, `expandCommand`).
 */
export interface SlashInput {
  readonly name: string;
  readonly args: string;
}

/** `/name args` as its parts; anything else (including a bare `/`) isn't a command. */
export const parseSlash = (text: string): SlashInput | undefined => {
  const match = /^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match?.[1] === undefined) return undefined;
  return { name: match[1], args: (match[2] ?? "").trim() };
};

export const MODES = ["default", "acceptEdits", "plan"] as const;
export type Mode = (typeof MODES)[number];

export const isMode = (value: string): value is Mode =>
  (MODES as ReadonlyArray<string>).includes(value);

export const BUILTINS = [
  { name: "help", description: "List commands and keys" },
  { name: "clear", description: "Start a new chat" },
  { name: "model", description: "Pick a model" },
  { name: "mode", description: `Set the permission mode: ${MODES.join(", ")}` },
  { name: "export", description: "Export the chat as Markdown" },
  { name: "quit", description: "Quit orx" },
] as const;

export type Builtin = (typeof BUILTINS)[number]["name"];

export const isBuiltin = (name: string): name is Builtin => BUILTINS.some((b) => b.name === name);

/** The keys, for /help. Keep in step with the footer and DESIGN.md. */
export const KEYS = [
  ["Enter", "send"],
  ["@", "attach a file"],
  ["/", "commands and skills"],
  ["Esc", "stop a reply, or close a list"],
  ["Shift+Tab", "cycle the permission mode"],
  ["y / a / n", "allow, always allow, or deny a tool call"],
  ["Ctrl+P", "pick a model"],
  ["Ctrl+E", "export as Markdown"],
  ["Ctrl+C", "quit"],
] as const;
