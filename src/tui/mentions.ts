/** The `@` file picker's pure parts: when it opens, how it ranks, what it inserts. */

/** True when the composer's text ends in an `@` that starts a word: the picker should open. */
export const opensMentionPicker = (draft: string) => /(^|\s)@$/.test(draft);

/** The draft with `@path ` in place of the trailing `@` that opened the picker (or appended). */
export const insertMention = (draft: string, path: string) => {
  const mention = `@${path} `;
  if (opensMentionPicker(draft)) return draft.slice(0, -1) + mention;
  return draft === "" || /\s$/.test(draft) ? draft + mention : `${draft} ${mention}`;
};

/**
 * How many contiguous runs `query` splits into when matched left to right as a subsequence of
 * `text`, or undefined when it doesn't match. Fewer runs is a tighter match.
 */
const subsequenceRuns = (query: string, text: string) => {
  let i = 0;
  let runs = 0;
  let previous = -2;
  for (const [at, char] of [...text].entries()) {
    if (i === query.length) break;
    if (char !== query[i]) continue;
    if (at !== previous + 1) runs++;
    previous = at;
    i++;
  }
  return i === query.length ? runs : undefined;
};

const basename = (path: string) => path.replace(/\/$/, "").split("/").at(-1) ?? path;

/**
 * Paths matching `query` (case-insensitive), best first. Tiers: the basename contains the query
 * (starting with it first), the path contains it, the basename matches it as a subsequence, then
 * the whole path does. Subsequence matches in fewer contiguous runs rank higher, so `pack` puts
 * `x/package.json` well above `template/vanilla/.claude/hooks/`. Shorter paths break ties. An
 * empty query keeps the list as it is.
 */
export const rankPaths = (paths: ReadonlyArray<string>, query: string): ReadonlyArray<string> => {
  const q = query.trim().toLowerCase();
  if (q === "") return paths;
  const scoreOf = (path: string): readonly [number, number] | undefined => {
    const lower = path.toLowerCase();
    const base = basename(lower);
    if (base.includes(q)) return [0, base.startsWith(q) ? 0 : 1];
    if (lower.includes(q)) return [1, 0];
    const baseRuns = subsequenceRuns(q, base);
    if (baseRuns !== undefined) return [2, baseRuns];
    const pathRuns = subsequenceRuns(q, lower);
    return pathRuns === undefined ? undefined : [3, pathRuns];
  };
  return paths
    .flatMap((path) => {
      const score = scoreOf(path);
      return score === undefined ? [] : [{ path, score }];
    })
    .sort(
      (a, b) =>
        a.score[0] - b.score[0] ||
        a.score[1] - b.score[1] ||
        a.path.length - b.path.length ||
        (a.path < b.path ? -1 : 1),
    )
    .map((m) => m.path);
};
