import { mapParsed277ca } from "./parse-277ca";
// @chartwarden/x12-835-client — the X12_835WorkerClient SHAPE + a fail-closed factory.
//
// Implements the parse-835 / parse-277ca contract over an injected raw HTTP transport
// ({@link X12835HttpPort}) to the Python `x12-worker` sidecar. It performs NO direct network I/O and
// imports no SDK / no pyx12 shim; in Phase 1 no transport is wired, so the default port fails closed and
// every method returns a degraded envelope (never throws, never silently succeeds). The real sidecar
// request-building lands when the backend composition root injects a live port (Phase 3 wiring); it stays
// confined to THIS package per the architecture §25.14 adapter mandate.
//
// Imports ONLY from ./types + the ./parse-* mappers — never from ./index — to keep the no-circular rule.
import { mapParsed835 } from "./parse-835";
import {
  type Parsed277ca,
  type ParsedRemittanceAdvice,
  type PayerProgram,
  type X12WorkerResult,
  X12_835_WORKER_NOT_WIRED,
  degraded835,
} from "./types";

/** A single sidecar HTTP exchange. The transport is injected so this package holds no network code. */
export interface X12835HttpRequest {
  readonly method: "POST";
  readonly path: "/parse835" | "/parse277ca";
  readonly body: unknown;
}

/** The raw sidecar response. */
export interface X12835HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The injected raw transport port to the `x12-worker` sidecar. A live port is wired at Phase 3. */
export interface X12835HttpPort {
  request(req: X12835HttpRequest): Promise<X12835HttpResponse>;
}

/** Request to parse a raw 835 file already staged in MinIO (the worker reads it by key). */
export interface Parse835Request {
  /** The MinIO object key of the raw 835 file. */
  readonly minioObjectKey: string;
  /** The program the M25 puller pulled this 835 over (echoed onto the parsed envelope). */
  readonly payerProgram: PayerProgram;
}

/** Request to parse a raw 277CA file staged in MinIO. */
export interface Parse277caRequest {
  readonly minioObjectKey: string;
}

/** The M25-owned slice of the x12-worker client surface. */
export interface X12835WorkerClient {
  parse835(input: Parse835Request): Promise<X12WorkerResult<ParsedRemittanceAdvice>>;
  parse277ca(input: Parse277caRequest): Promise<X12WorkerResult<Parsed277ca>>;
}

/**
 * The fail-closed default port: no sidecar transport is wired in Phase 1, so any request rejects. The
 * factory converts that rejection into a retryable degraded envelope (transport, not parse, failure).
 */
export const NO_X12_835_PORT: X12835HttpPort = {
  request(): Promise<X12835HttpResponse> {
    return Promise.reject(new Error(X12_835_WORKER_NOT_WIRED));
  },
};

/**
 * Build an {@link X12835WorkerClient} over an injected transport (default: fail-closed). Sidecar transport
 * or parse errors surface as degraded envelopes; only a well-formed 2xx body is mapped to a parsed value.
 */
export function createX12835Client(port: X12835HttpPort = NO_X12_835_PORT): X12835WorkerClient {
  return {
    async parse835(input) {
      let res: X12835HttpResponse;
      try {
        res = await port.request({
          method: "POST",
          path: "/parse835",
          body: { minioObjectKey: input.minioObjectKey, payerProgram: input.payerProgram },
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : "transport rejected";
        return degraded835("X12_835_TRANSPORT", reason, "parse835", true);
      }
      if (res.status < 200 || res.status >= 300) {
        return degraded835(
          "X12_835_TRANSPORT",
          `sidecar returned status ${res.status}`,
          "parse835",
          res.status >= 500,
        );
      }
      return mapParsed835(res.body, input.payerProgram);
    },

    async parse277ca(input) {
      let res: X12835HttpResponse;
      try {
        res = await port.request({
          method: "POST",
          path: "/parse277ca",
          body: { minioObjectKey: input.minioObjectKey },
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : "transport rejected";
        return degraded835("X12_277CA_TRANSPORT", reason, "parse277ca", true);
      }
      if (res.status < 200 || res.status >= 300) {
        return degraded835(
          "X12_277CA_TRANSPORT",
          `sidecar returned status ${res.status}`,
          "parse277ca",
          res.status >= 500,
        );
      }
      return mapParsed277ca(res.body);
    },
  };
}
