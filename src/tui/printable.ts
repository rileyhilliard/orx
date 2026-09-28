/**
 * Text as it may be drawn: model- and tool-controlled strings (replies, tool inputs and
 * outputs, approval summaries and diffs) could carry terminal control sequences. A lone ESC or
 * CSI reaching the terminal can move the cursor, recolor, or retitle the window, so every C0
 * and C1 control character except newline and tab is dropped, and CRLF / CR become newlines.
 */
export const printable = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
