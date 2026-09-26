/**
 * The TUI's colors (DESIGN.md). The only file under src/tui with color literals: components
 * use these names, so a palette change is one edit.
 */
export const theme = {
  text: "#e6e6e6",
  muted: "#8a8f98",
  faint: "#4b5058",
  accent: "#7aa2f7",
  user: "#c0caf5",
  tool: "#bb9af7",
  error: "#f7768e",
  border: "#3b4048",
  selectedBg: "#2a2f3a",
} as const;
