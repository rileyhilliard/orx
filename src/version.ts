import pkg from "../package.json" with { type: "json" };

/** orx's version. Releases are cut from a tag that must equal it (release.yml checks). */
export const VERSION: string = pkg.version;
