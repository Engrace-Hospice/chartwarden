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

/** Largest Rust response body accepted (bytes). */
export const MAX_BODY_BYTES = 64 * 1024;

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
      // Bounded body: the permission list is small; anything larger is refused rather than buffered. The abort
      // signal still covers the body read, so a stalled stream times out too.
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_BODY_BYTES) return { ok: false, reason: "bad_json" };
      try {
        const text = await res.text();
        if (text.length > MAX_BODY_BYTES) return { ok: false, reason: "bad_json" };
        const body: unknown = JSON.parse(text);
        return {
          ok: true,
          status: res.status,
          contentType: res.headers.get("content-type"),
          body,
        };
      } catch {
        return { ok: false, reason: signal.aborted ? "timeout" : "bad_json" };
      }
    },
  };
}
