import { mapParsed277ca } from "./parse-277ca";
// @chartwarden/x12-835-client — the M25 X12 client. parse835 is IN-PROCESS pure TypeScript (ADR-0037; the
// Python x12-worker sidecar was cancelled): raw 835 text -> parseX12835, fail-closed. parse277ca still maps
// a sidecar response over an injected HTTP port (default fails closed) — the 277CA belongs to M23's client
// (ADR-0029) and is deliberately not parsed here. No network or storage code lives in this package.
// Imports ONLY from ./types + the ./parse-* mappers — never from ./index — to keep the no-circular rule.
import { parseX12835 } from "./parse-x12-835";
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
  readonly path: "/parse277ca";
  readonly body: unknown;
}

/** The raw sidecar response. */
export interface X12835HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The injected raw transport port to the 277CA sidecar endpoint (no live port is wired). */
export interface X12835HttpPort {
  request(req: X12835HttpRequest): Promise<X12835HttpResponse>;
}

/** Request to parse a raw 835 file already staged in MinIO (the worker reads it by key). */
export interface Parse835Request {
  /** The MinIO object key of the raw 835 file. */
  readonly minioObjectKey: string;
  /** The program the M25 puller pulled this 835 over (echoed onto the parsed envelope). */
  readonly payerProgram: PayerProgram;
  /** The raw 835 text, when the caller already holds it (receive path). Otherwise read via `readRaw`. */
  readonly rawEdi?: string;
}

/** Reads the staged raw 835 by object key (injected: this package holds no storage code). */
export type X12RawReader = (minioObjectKey: string) => Promise<string>;

export interface X12835ClientOptions {
  /** Sidecar transport — used ONLY by `parse277ca`. 835 parsing is in-process TypeScript (ADR-0037). */
  readonly port?: X12835HttpPort;
  /** Raw-835 reader for requests that carry only an object key. */
  readonly readRaw?: X12RawReader;
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
export function createX12835Client(opts: X12835ClientOptions = {}): X12835WorkerClient {
  const port = opts.port ?? NO_X12_835_PORT;
  return {
    async parse835(input) {
      let raw = input.rawEdi;
      if (raw === undefined) {
        if (!opts.readRaw) {
          return degraded835(
            "X12_835_RAW_UNAVAILABLE",
            "raw 835 not supplied and no object reader is wired",
            "parse835",
            true,
          );
        }
        try {
          raw = await opts.readRaw(input.minioObjectKey);
        } catch (err) {
          const reason = err instanceof Error ? err.message : "object read rejected";
          return degraded835("X12_835_RAW_READ", reason, "parse835", true);
        }
      }
      return parseX12835(raw, input.payerProgram);
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
