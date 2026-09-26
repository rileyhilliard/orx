import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubAsset {
  readonly name: string;
  readonly body: Uint8Array | string;
}

export interface StubReleases {
  /** Use as ORX_RELEASES_URL (stands in for https://api.github.com). */
  readonly apiUrl: string;
  /** The repo slug the stub answers for (ORX_RELEASES_REPO). */
  readonly repo: string;
  /** The latest release: its tag and assets. SHA256SUMS is generated unless `sums` is set. */
  release: { tag: string; assets: StubAsset[]; sums?: string };
  /** Fail GET .../releases/latest with this status. */
  failLatest: number | undefined;
  readonly downloads: string[];
  close(): Promise<void>;
}

export const sha256 = (body: Uint8Array | string) =>
  createHash("sha256").update(body).digest("hex");

/**
 * A local stand-in for GitHub's releases API and asset downloads, for `orx update`,
 * install.sh, and `bun run stub`. Port 0 picks a free port.
 */
export const startStubReleases = async (port = 0, repo = "test/orx"): Promise<StubReleases> => {
  const state = {
    release: { tag: "v0.1.0", assets: [] as StubAsset[] } as StubReleases["release"],
    failLatest: undefined as number | undefined,
    downloads: [] as string[],
  };
  const sums = () =>
    state.release.sums ??
    state.release.assets.map((asset) => `${sha256(asset.body)}  ${asset.name}`).join("\n");

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { port: listening } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${listening}`;
    if (req.method === "GET" && url.pathname === `/repos/${repo}/releases/latest`) {
      if (state.failLatest !== undefined) {
        res.writeHead(state.failLatest, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "stub failure" }));
        return;
      }
      const names = [...state.release.assets.map((a) => a.name), "SHA256SUMS"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          tag_name: state.release.tag,
          assets: names.map((name) => ({
            name,
            browser_download_url: `${base}/download/${state.release.tag}/${name}`,
          })),
        }),
      );
      return;
    }
    const download = url.pathname.match(/^\/download\/[^/]+\/(.+)$/);
    if (req.method === "GET" && download) {
      const name = download[1] ?? "";
      state.downloads.push(name);
      const body =
        name === "SHA256SUMS" ? sums() : state.release.assets.find((a) => a.name === name)?.body;
      if (body === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `no stub for ${req.method} ${url.pathname}` }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: listening } = server.address() as AddressInfo;

  return {
    apiUrl: `http://127.0.0.1:${listening}`,
    repo,
    get release() {
      return state.release;
    },
    set release(value) {
      state.release = value;
    },
    get failLatest() {
      return state.failLatest;
    },
    set failLatest(value) {
      state.failLatest = value;
    },
    get downloads() {
      return state.downloads;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        // Bun's node:http reports an already-stopped server as an error; stopped is the goal.
        server.close((error) =>
          error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            ? reject(error)
            : resolve(),
        );
      }),
  };
};
