import { Context, Layer } from "effect";

/** Facts about the running process that only src/bin.ts can know (it runs under Bun). */
export interface HostShape {
  /** The running binary (the compiled orx, or bun when running from source). */
  readonly execPath: string;
  /** True for a `bun build --compile` binary; false from source (`bun run orx`). */
  readonly compiled: boolean;
  readonly platform: string;
  readonly arch: string;
}

export class Host extends Context.Service<Host, HostShape>()("orx/Host") {
  static readonly layer = (host: HostShape) => Layer.succeed(Host, host);
}
