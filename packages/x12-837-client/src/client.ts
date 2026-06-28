// @wardenx/x12-837-client — the X12WorkerClient SHAPE + a fail-closed factory.
//
// Implements the published {@link X12WorkerClient} contract over an injected raw HTTP transport
// ({@link X12WorkerHttpPort}) to the Python `x12-worker` sidecar. It performs NO direct network I/O and
// imports no SDK / no pyx12 shim; in Phase 1 no transport is wired, so the default port fails closed and
// every method returns a {@link DegradedError} envelope (never throws, never silently succeeds). The real
// HTTP request-building + sidecar calls land in Phase 3 behind the `TODO(Phase 3)` boundaries below; they
// stay confined to THIS package per the architecture §25.14 adapter mandate.
//
// Imports ONLY from ./types (the extracted contract leaf) — never from ./index — to keep the no-circular
// fitness rule (the M27 index↔client cycle gotcha) satisfied.
import {
  degraded,
  X12_WORKER_NOT_WIRED,
  type Eligibility270Request,
  type Eligibility271Result,
  type Generate837iNoeRequest,
  type Generate837iNotrRequest,
  type Generate837iRequest,
  type Generated837i,
  type Parse277caRequest,
  type Parse999Request,
  type Parsed277ca,
  type Parsed999,
  type X12WorkerClient,
  type X12WorkerResult,
} from "./types";

/** A single sidecar HTTP exchange. The transport is injected so this package holds no network code. */
export interface X12WorkerHttpRequest {
  readonly method: "POST";
  readonly path: string;
  readonly body: unknown;
}

/** The raw sidecar response. */
export interface X12WorkerHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The injected raw transport port to the `x12-worker` sidecar. Live transport lands in Phase 3 (M34 wiring). */
export interface X12WorkerHttpPort {
  request(req: X12WorkerHttpRequest): Promise<X12WorkerHttpResponse>;
}

/**
 * The fail-closed default port: no sidecar transport is wired in Phase 1, so any request fails closed as
 * degraded. The backend composition root injects a live port in Phase 3 via {@link createX12WorkerClient}.
 */
export const NO_X12_WORKER_PORT: X12WorkerHttpPort = {
  request(): Promise<X12WorkerHttpResponse> {
    return Promise.reject(new Error(X12_WORKER_NOT_WIRED));
  },
};

/** Everything a {@link LiveX12WorkerClient} needs; assembled by {@link createX12WorkerClient}. */
export interface X12WorkerClientDeps {
  readonly http: X12WorkerHttpPort;
}

/**
 * The X12 worker client shape. In Phase 1 every method fails closed with a degraded envelope; the real
 * payload-building + `deps.http.request(...)` calls land in Phase 3 at the `TODO(Phase 3)` boundaries.
 */
export class LiveX12WorkerClient implements X12WorkerClient {
  constructor(private readonly deps: X12WorkerClientDeps) {}

  generate837i(_input: Generate837iRequest): Promise<X12WorkerResult<Generated837i>> {
    // TODO(Phase 3): build the /generate-837i payload and call this.deps.http.request(...).
    return Promise.resolve(degraded<Generated837i>(X12_WORKER_NOT_WIRED, "x12-worker sidecar not wired"));
  }

  generate837iNoe(_input: Generate837iNoeRequest): Promise<X12WorkerResult<Generated837i>> {
    // TODO(Phase 3): build the /generate-noe payload and call this.deps.http.request(...).
    return Promise.resolve(degraded<Generated837i>(X12_WORKER_NOT_WIRED, "x12-worker sidecar not wired"));
  }

  generate837iNotr(_input: Generate837iNotrRequest): Promise<X12WorkerResult<Generated837i>> {
    // TODO(Phase 3): build the /generate-notr payload and call this.deps.http.request(...).
    return Promise.resolve(degraded<Generated837i>(X12_WORKER_NOT_WIRED, "x12-worker sidecar not wired"));
  }

  parse999(_input: Parse999Request): Promise<X12WorkerResult<Parsed999>> {
    // TODO(Phase 3): POST raw 999 to /parse-999 and normalize the response.
    return Promise.resolve(degraded<Parsed999>(X12_WORKER_NOT_WIRED, "x12-worker sidecar not wired"));
  }

  parse277ca(_input: Parse277caRequest): Promise<X12WorkerResult<Parsed277ca>> {
    // TODO(Phase 3): POST raw 277CA to /parse-277ca and normalize the response.
    return Promise.resolve(degraded<Parsed277ca>(X12_WORKER_NOT_WIRED, "x12-worker sidecar not wired"));
  }

  eligibility270(_input: Eligibility270Request): Promise<X12WorkerResult<Eligibility271Result>> {
    // TODO(Phase 3): build the HETS 270 with the transient MBI, POST /eligibility-270, then ensure the
    // caller secure-zeroes the MBI. The MBI never enters the result, a log, or an audit payload (§8.7).
    return Promise.resolve(
      degraded<Eligibility271Result>(X12_WORKER_NOT_WIRED, "x12-worker sidecar not wired"),
    );
  }
}

/** The published factory seam shape (mirrors `@wardenx/cost-report`'s seam interfaces). */
export interface X12WorkerClientFactory {
  create(): X12WorkerClient;
}

/**
 * Build an {@link X12WorkerClient} over an injected transport port. The default {@link x12WorkerClient}
 * passes the fail-closed {@link NO_X12_WORKER_PORT}; M23's composition root passes a live port in Phase 3.
 */
export function createX12WorkerClient(deps: X12WorkerClientDeps): X12WorkerClient {
  return new LiveX12WorkerClient(deps);
}

/**
 * The fail-closed default client. Built on {@link NO_X12_WORKER_PORT}, so every method returns a degraded
 * envelope until M23's boot injects a live port via {@link createX12WorkerClient}.
 */
export const x12WorkerClient: X12WorkerClient = createX12WorkerClient({ http: NO_X12_WORKER_PORT });
