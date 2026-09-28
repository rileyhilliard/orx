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

/**
 * Every key, for /help (two columns, so keep each description short). The footer shows only
 * the ones that fit in 80 columns; a new key goes here, in DESIGN.md's table, and in app.tsx's
 * docblock.
 */
export const KEYS = [
  ["Enter", "send, or run a /command"],
  ["@", "attach a file"],
  ["/", "commands and skills"],
  ["Up / Down", "move in a list or a diff"],
  ["PgUp/PgDn", "page through a diff"],
  ["Tab", "insert a /command"],
  ["Backspace", "on an empty filter, close"],
  ["Esc", "close, or stop a reply"],
  ["Shift+Tab", "cycle the permission mode"],
  ["y / a / n", "allow, always, deny"],
  ["Ctrl+P", "pick a model"],
  ["Ctrl+E", "export as Markdown"],
  ["Ctrl+C", "quit"],
] as const;
