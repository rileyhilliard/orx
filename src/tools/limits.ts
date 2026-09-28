/** Output limits for the agent's tools, in one place so they can be tuned together. */

/** `read` returns at most this many lines unless the model passes `limit`. */
export const READ_DEFAULT_LINES = 2000;
/** `read` cuts a line longer than this many characters. */
export const READ_MAX_LINE_CHARS = 2000;
/** `read` refuses a file larger than this: it loads the whole file to number its lines. */
export const READ_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** A file with a NUL byte in its first this-many bytes is treated as binary. */
export const BINARY_SNIFF_BYTES = 8000;

/** `glob` lists at most this many paths, newest first. */
export const GLOB_MAX_RESULTS = 100;

/** `grep` returns at most this many results (files, lines, or counts) unless `head_limit` is set. */
export const GREP_DEFAULT_HEAD_LIMIT = 100;
/** The JS fallback of `grep` skips files larger than this. */
export const GREP_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** `grep` cuts a matching line longer than this many characters in `content` mode. */
export const GREP_MAX_LINE_CHARS = 500;

/** `bash` kills a command after this long unless the model passes `timeout_ms`. */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
/** The most `timeout_ms` may ask for. */
export const BASH_MAX_TIMEOUT_MS = 600_000;
/** `bash` keeps at most this many characters of output: the first and last halves. */
export const BASH_MAX_OUTPUT_CHARS = 30_000;
