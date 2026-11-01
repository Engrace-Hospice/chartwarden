// apps/backend/src/bootstrap/rust-bridge/client.ts — CW-RUST-M02 P1: one call to the Rust server over its Unix socket.
//
// Never throws: every outcome is a value, so the forwarder can fall back on each reason (spec §Fallback). The body
// is parsed but not trusted; validation is the caller's job.
import { ASSERTION_HEADER } from "./signer";

export type RustCallResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly contentType: string | null;
      readonly body: unknown;
    }
  | { readonly ok: false; readonly reason: "connect" | "timeout" | "bad_json" };

export interface RustClient {
  get(path: string, assertion: string): Promise<RustCallResult>;
}

/** Bun's `fetch` dials a Unix socket with the non-standard `unix` option. */
type UnixFetch = (input: string, init: RequestInit & { unix: string }) => Promise<Response>;

export function createRustClient(
  socketPath: string,
  timeoutMs: number,
  fetchImpl: UnixFetch = fetch as unknown as UnixFetch,
): RustClient {
  return {
    async get(path, assertion) {
      const signal = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(`http://localhost${path}`, {
          unix: socketPath,
          method: "GET",
          headers: { [ASSERTION_HEADER]: assertion },
          signal,
        });
      } catch {
        return { ok: false, reason: signal.aborted ? "timeout" : "connect" };
      }
      try {
        const body: unknown = await res.json();
        return { ok: true, status: res.status, contentType: res.headers.get("content-type"), body };
      } catch {
        return { ok: false, reason: signal.aborted ? "timeout" : "bad_json" };
      }
    },
  };
}
