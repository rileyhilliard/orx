/** The `@` file picker's pure parts: when it opens, how it ranks, what it inserts. */

/** True when the composer's text ends in an `@` that starts a word: the picker should open. */
export const opensMentionPicker = (draft: string) => /(^|\s)@$/.test(draft);

/** The draft with `@path ` in place of the trailing `@` that opened the picker (or appended). */
export const insertMention = (draft: string, path: string) => {
  const mention = `@${path} `;
  if (opensMentionPicker(draft)) return draft.slice(0, -1) + mention;
  return draft === "" || /\s$/.test(draft) ? draft + mention : `${draft} ${mention}`;
};

const isSubsequence = (query: string, text: string) => {
  let i = 0;
  for (const char of text) if (char === query[i]) i++;
  return i === query.length;
};

const basename = (path: string) => path.replace(/\/$/, "").split("/").at(-1) ?? path;

/**
 * Paths matching `query` as a fuzzy subsequence (case-insensitive), best first: the basename
 * containing the query, then the basename matching it as a subsequence, then the whole path;
 * shorter paths first within each. An empty query keeps the list as it is.
 */
export const rankPaths = (paths: ReadonlyArray<string>, query: string): ReadonlyArray<string> => {
  const q = query.trim().toLowerCase();
  if (q === "") return paths;
  const tierOf = (path: string) => {
    const lower = path.toLowerCase();
    const base = basename(lower);
    if (base.includes(q)) return 0;
    if (isSubsequence(q, base)) return 1;
    if (isSubsequence(q, lower)) return 2;
    return undefined;
  };
  return paths
    .flatMap((path) => {
      const tier = tierOf(path);
      return tier === undefined ? [] : [{ path, tier }];
    })
    .sort((a, b) => a.tier - b.tier || a.path.length - b.path.length || (a.path < b.path ? -1 : 1))
    .map((m) => m.path);
};
