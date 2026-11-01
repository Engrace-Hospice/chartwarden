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
      // Bounded body, counted in BYTES while streaming: the reader is cancelled the moment the total passes
      // MAX_BODY_BYTES, so a huge or endless body is never buffered. The abort signal covers the whole read, so a
      // stream that stalls after the headers times out too.
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_BODY_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "bad_json" };
      }
      try {
        const bytes = await readBounded(res, MAX_BODY_BYTES);
        if (bytes === null) return { ok: false, reason: "bad_json" };
        const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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

/** Reads at most `limit` bytes of the body; returns null (after cancelling the stream) if it is longer. */
export async function readBounded(res: Response, limit: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
