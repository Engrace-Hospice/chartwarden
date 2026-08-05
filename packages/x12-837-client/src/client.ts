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
  X12_WORKER_NOT_WIRED,
  degraded,
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

  private async post<T>(
    path: string,
    body: unknown,
    isResult: (value: unknown) => value is T,
  ): Promise<X12WorkerResult<T>> {
    try {
      const response = await this.deps.http.request({ method: "POST", path, body });
      if (response.status < 200 || response.status >= 300) {
        return degraded<T>("X12_WORKER_HTTP_ERROR", `x12-worker returned HTTP ${response.status}`);
      }
      if (!isResult(response.body)) {
        return degraded<T>("X12_WORKER_INVALID_RESPONSE", "x12-worker response failed validation");
      }
      return { ok: true, data: response.body };
    } catch {
      return degraded<T>(X12_WORKER_NOT_WIRED, "x12-worker transport unavailable");
    }
  }

  generate837i(input: Generate837iRequest): Promise<X12WorkerResult<Generated837i>> {
    return this.post("/generate-837i", input, isGenerated837i);
  }

  generate837iNoe(input: Generate837iNoeRequest): Promise<X12WorkerResult<Generated837i>> {
    return this.post("/generate-noe", input, isGenerated837i);
  }

  generate837iNotr(input: Generate837iNotrRequest): Promise<X12WorkerResult<Generated837i>> {
    return this.post("/generate-notr", input, isGenerated837i);
  }

  parse999(input: Parse999Request): Promise<X12WorkerResult<Parsed999>> {
    return this.post("/parse-999", input, isParsed999);
  }

  parse277ca(input: Parse277caRequest): Promise<X12WorkerResult<Parsed277ca>> {
    return this.post("/parse-277ca", input, isParsed277ca);
  }

  eligibility270(input: Eligibility270Request): Promise<X12WorkerResult<Eligibility271Result>> {
    return this.post("/eligibility-270", input, isEligibility271);
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const outcome = (value: unknown): value is "accepted" | "rejected" | "partial" =>
  value === "accepted" || value === "rejected" || value === "partial";

function isGenerated837i(value: unknown): value is Generated837i {
  return (
    record(value) &&
    string(value.fileContents) &&
    value.fileContents.length > 0 &&
    string(value.interchangeControlNumber) &&
    string(value.transactionSetControlNumber)
  );
}

function isAckError(value: unknown): boolean {
  return record(value) && string(value.segment) && string(value.code) && string(value.description);
}

function isParsed999(value: unknown): value is Parsed999 {
  return (
    record(value) &&
    outcome(value.outcome) &&
    string(value.interchangeControlNumber) &&
    Array.isArray(value.errors) &&
    value.errors.every(isAckError)
  );
}

function isParsed277ca(value: unknown): value is Parsed277ca {
  return (
    record(value) &&
    outcome(value.outcome) &&
    Array.isArray(value.claimStatuses) &&
    value.claimStatuses.every(
      (status) =>
        record(status) &&
        string(status.claimControlNumber) &&
        typeof status.accepted === "boolean" &&
        string(status.statusCategoryCode) &&
        string(status.statusCode),
    )
  );
}

function isEligibility271(value: unknown): value is Eligibility271Result {
  return (
    record(value) &&
    (value.outcome === "active" || value.outcome === "inactive" || value.outcome === "unknown") &&
    string(value.asOfDate)
  );
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
