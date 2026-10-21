// @chartwarden/x12-837-client — NGS Jurisdiction 6 MAC portal client (the LAUNCH case, Engrace's MAC).
//
// This is the only operational MAC-portal client in Phase 1, but it is a SKELETON: the file-drop +
// status-poll HTTP details land in Phase 3 behind the `TODO(Phase 3)` boundaries, so Phase 1 methods
// fail closed with a degraded envelope (they do NOT throw NotImplementedError — that is reserved for
// non-active jurisdictions). The NGS J6 portal URLs / endpoints / credentials are confined to THIS file
// (spec §8.5): no other module names them, and per dependency-cruiser (task 20) this module imports ONLY
// from ../types — it may not import any sibling jurisdiction module.
import {
  MAC_PORTAL_NOT_WIRED,
  type MacJurisdiction,
  type MacPortalClient,
  type MacPortalReceipt,
  type MacPortalStatus,
  type MacPortalStatusRequest,
  type MacPortalSubmitRequest,
  type X12WorkerResult,
  degraded,
} from "../types";

/** The NGS J6 launch-case portal client. Implements the shared {@link MacPortalClient} conformance surface. */
export class NgsJ6PortalClient implements MacPortalClient {
  public readonly jurisdiction: MacJurisdiction = "ngs_j6";

  constructor(private readonly http: NgsJ6PortalHttpPort = NO_NGS_J6_PORT) {}

  async submitFile(input: MacPortalSubmitRequest): Promise<X12WorkerResult<MacPortalReceipt>> {
    return this.request({ method: "POST", path: "/submissions", body: input }, isReceipt);
  }

  async pollStatus(input: MacPortalStatusRequest): Promise<X12WorkerResult<MacPortalStatus>> {
    return this.request(
      {
        method: "POST",
        path: "/submission-status",
        body: input,
      },
      isStatus,
    );
  }

  private async request<T>(
    request: NgsJ6PortalHttpRequest,
    guard: (value: unknown) => value is T,
  ): Promise<X12WorkerResult<T>> {
    try {
      const response = await this.http.request(request);
      if (response.status < 200 || response.status >= 300) {
        return degraded<T>(
          "MAC_PORTAL_HTTP_ERROR",
          `ngs_j6 portal returned HTTP ${response.status}`,
        );
      }
      if (!guard(response.body)) {
        return degraded<T>(
          "MAC_PORTAL_INVALID_RESPONSE",
          "ngs_j6 portal response failed validation",
        );
      }
      return { ok: true, data: response.body };
    } catch {
      return degraded<T>(MAC_PORTAL_NOT_WIRED, "ngs_j6 portal transport unavailable");
    }
  }
}

/** Construct the NGS J6 portal client. */
export function createNgsJ6PortalClient(http?: NgsJ6PortalHttpPort): MacPortalClient {
  return new NgsJ6PortalClient(http);
}

export interface NgsJ6PortalHttpRequest {
  readonly method: "POST";
  readonly path: "/submissions" | "/submission-status";
  readonly body: unknown;
}

export interface NgsJ6PortalHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Auth, TLS, timeouts, and replay-safe request identifiers belong to this injected transport. */
export interface NgsJ6PortalHttpPort {
  request(input: NgsJ6PortalHttpRequest): Promise<NgsJ6PortalHttpResponse>;
}

const NO_NGS_J6_PORT: NgsJ6PortalHttpPort = {
  request: () => Promise.reject(new Error(MAC_PORTAL_NOT_WIRED)),
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isReceipt(value: unknown): value is MacPortalReceipt {
  return (
    record(value) &&
    typeof value.portalSubmissionId === "string" &&
    value.portalSubmissionId.length > 0 &&
    typeof value.acceptedAt === "string" &&
    !Number.isNaN(Date.parse(value.acceptedAt))
  );
}

function isStatus(value: unknown): value is MacPortalStatus {
  return (
    record(value) &&
    typeof value.portalSubmissionId === "string" &&
    (value.state === "received" ||
      value.state === "in_process" ||
      value.state === "acknowledged" ||
      value.state === "rejected")
  );
}
