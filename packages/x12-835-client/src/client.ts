// @chartwarden/x12-835-client — the M25 X12 client. parse835 is IN-PROCESS pure TypeScript (ADR-0037; the
// Python x12-worker sidecar was cancelled): raw 835 text -> parseX12835, fail-closed. parse277ca still maps
// a sidecar response over an injected HTTP port (default fails closed) — the 277CA belongs to M23's client
// (ADR-0029) and is deliberately not parsed here. No network or storage code lives in this package.
// Imports ONLY from ./types + the ./parse-* mappers — never from ./index — to keep the no-circular rule.
import { mapParsed277ca } from "./parse-277ca";
import { parseX12835, parseX12835AllSets } from "./parse-x12-835";
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
  /** ST02 of the transaction set to parse; required when the file holds more than one ST/SE set. */
  readonly transactionSetControlNumber?: string;
}

/** Reads the staged raw 835 by object key (injected: this package holds no storage code). */
export type X12RawReader = (minioObjectKey: string) => Promise<string>;

export interface X12835ClientOptions {
  /** Sidecar transport — used ONLY by `parse277ca`. 835 parsing is in-process TypeScript (ADR-0037). */
  readonly port?: X12835HttpPort;
  /** Raw-835 reader for requests that carry only an object key. */
  readonly readRaw?: X12RawReader;
  /** Accept ISA15 = T test interchanges (dev/test only; default rejects them). */
  readonly allowTestFiles?: boolean;
}

/** Request to parse a raw 277CA file staged in MinIO. */
export interface Parse277caRequest {
  readonly minioObjectKey: string;
}

/** The M25-owned X12 client surface: in-process 835 parsing plus the 277CA sidecar mapper. */
export interface X12835WorkerClient {
  parse835(input: Parse835Request): Promise<X12WorkerResult<ParsedRemittanceAdvice>>;
  /**
   * Every ST/SE set of the file, parsed in one pass, in file order (all-or-nothing). Optional so a test double
   * need not implement it; the receive path falls back to one `parse835` per ST02 when it is absent.
   */
  parse835All?(input: Parse835Request): Promise<X12WorkerResult<ParsedRemittanceAdvice[]>>;
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
  const loadRaw = async (input: Parse835Request): Promise<string | X12WorkerResult<never>> => {
    if (input.rawEdi !== undefined) return input.rawEdi;
    if (!opts.readRaw) {
      return degraded835(
        "X12_835_RAW_UNAVAILABLE",
        "raw 835 not supplied and no object reader is wired",
        "parse835",
        true,
      );
    }
    try {
      return await opts.readRaw(input.minioObjectKey);
    } catch {
      // Fixed text: a storage error message can carry bucket/endpoint detail and lands in parse_summary.
      return degraded835(
        "X12_835_RAW_READ",
        "staged 835 object could not be read",
        "parse835",
        true,
      );
    }
  };
  const parseOpts = { allowTestFiles: opts.allowTestFiles ?? false };
  return {
    async parse835(input) {
      const raw = await loadRaw(input);
      if (typeof raw !== "string") return raw;
      return parseX12835(raw, input.payerProgram, parseOpts, input.transactionSetControlNumber);
    },

    async parse835All(input) {
      const raw = await loadRaw(input);
      if (typeof raw !== "string") return raw;
      return parseX12835AllSets(raw, input.payerProgram, parseOpts);
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
