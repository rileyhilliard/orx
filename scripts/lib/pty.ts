// Runs a command in a pseudo-terminal and keeps a rendered copy of its screen, so agents
// (bun run tui:capture) and the e2e tests can see what a person would. Bun's built-in PTY
// (Bun.spawn `terminal`) feeds @xterm/headless, which interprets the escape codes.
import xterm from "@xterm/headless";

export interface PtyOptions {
  readonly cols?: number;
  readonly rows?: number;
  /** The whole environment for the child (not merged with this process's). */
  readonly env: Record<string, string | undefined>;
  readonly cwd?: string;
}

export interface Pty {
  /** The screen as text, one string per row, trailing spaces trimmed. */
  screen(): string;
  /** Everything the child wrote, raw. */
  readonly output: () => string;
  write(data: string): void;
  /** Resolves when `predicate(screen)` holds; rejects after `timeoutMs` with the screen. */
  waitFor(predicate: (screen: string) => boolean, timeoutMs?: number): Promise<string>;
  /** Resolves once the screen hasn't changed for `quietMs`. */
  settle(quietMs?: number, timeoutMs?: number): Promise<string>;
  readonly exited: Promise<number>;
  kill(): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const spawnPty = (command: ReadonlyArray<string>, options: PtyOptions): Pty => {
  const cols = options.cols ?? 100;
  const rows = options.rows ?? 30;
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  const decoder = new TextDecoder();
  let raw = "";
  let changedAt = Date.now();
  const proc = Bun.spawn([...command], {
    env: { TERM: "xterm-256color", ...options.env },
    ...(options.cwd ? { cwd: options.cwd } : {}),
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        const text = decoder.decode(data, { stream: true });
        raw += text;
        changedAt = Date.now();
        term.write(text);
      },
    },
  });

  const screen = () => {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    return lines.join("\n");
  };
  // xterm applies writes asynchronously; an empty write resolves after the queue drains.
  const flushed = () => new Promise<void>((resolve) => term.write("", resolve));

  return {
    screen,
    output: () => raw,
    write: (data) => {
      proc.terminal?.write(data);
    },
    waitFor: async (predicate, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await flushed();
        const current = screen();
        if (predicate(current)) return current;
        if (Date.now() > deadline) {
          throw new Error(`Timed out after ${timeoutMs}ms. Screen:\n${current}`);
        }
        await sleep(25);
      }
    },
    settle: async (quietMs = 300, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() - changedAt < quietMs && Date.now() < deadline) await sleep(25);
      await flushed();
      return screen();
    },
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

const NAMED_KEYS: Record<string, string> = {
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
};

/**
 * Keys as text with `<name>` tokens: `hi<enter>`, `<ctrl-p>gpt<enter>`, `<esc>`, `<wait:500>`.
 * Returns the steps to send in order.
 */
export const parseKeys = (spec: string): Array<{ send: string } | { waitMs: number }> => {
  const steps: Array<{ send: string } | { waitMs: number }> = [];
  for (const part of spec.split(/(<[^>]+>)/)) {
    if (part === "") continue;
    const token = part.match(/^<([^>]+)>$/)?.[1]?.toLowerCase();
    if (token === undefined) {
      steps.push({ send: part });
    } else if (token.startsWith("wait:")) {
      steps.push({ waitMs: Number(token.slice(5)) || 0 });
    } else if (token.startsWith("ctrl-") && token.length === 6) {
      steps.push({ send: String.fromCharCode(token.charCodeAt(5) - 96) });
    } else if (NAMED_KEYS[token] !== undefined) {
      steps.push({ send: NAMED_KEYS[token] });
    } else {
      throw new Error(
        `Unknown key <${token}>. Known: ${Object.keys(NAMED_KEYS).join(", ")}, ctrl-<letter>, wait:<ms>`,
      );
    }
  }
  return steps;
};
