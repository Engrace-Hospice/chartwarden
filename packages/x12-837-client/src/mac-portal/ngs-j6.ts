// @wardenx/x12-837-client — NGS Jurisdiction 6 MAC portal client (the LAUNCH case, Engrace's MAC).
//
// This is the only operational MAC-portal client in Phase 1, but it is a SKELETON: the file-drop +
// status-poll HTTP details land in Phase 3 behind the `TODO(Phase 3)` boundaries, so Phase 1 methods
// fail closed with a degraded envelope (they do NOT throw NotImplementedError — that is reserved for
// non-active jurisdictions). The NGS J6 portal URLs / endpoints / credentials are confined to THIS file
// (spec §8.5): no other module names them, and per dependency-cruiser (task 20) this module imports ONLY
// from ../types — it may not import any sibling jurisdiction module.
import {
  degraded,
  MAC_PORTAL_NOT_WIRED,
  type MacJurisdiction,
  type MacPortalClient,
  type MacPortalReceipt,
  type MacPortalStatus,
  type MacPortalStatusRequest,
  type MacPortalSubmitRequest,
  type X12WorkerResult,
} from "../types";

/** The NGS J6 launch-case portal client. Implements the shared {@link MacPortalClient} conformance surface. */
export class NgsJ6PortalClient implements MacPortalClient {
  public readonly jurisdiction: MacJurisdiction = "ngs_j6";

  submitFile(_input: MacPortalSubmitRequest): Promise<X12WorkerResult<MacPortalReceipt>> {
    // TODO(Phase 3): drop the 837I file at the NGS J6 portal and return its receipt.
    return Promise.resolve(degraded<MacPortalReceipt>(MAC_PORTAL_NOT_WIRED, "ngs_j6 portal transport not wired"));
  }

  pollStatus(_input: MacPortalStatusRequest): Promise<X12WorkerResult<MacPortalStatus>> {
    // TODO(Phase 3): poll the NGS J6 portal for the submitted file's status.
    return Promise.resolve(degraded<MacPortalStatus>(MAC_PORTAL_NOT_WIRED, "ngs_j6 portal transport not wired"));
  }
}

/** Construct the NGS J6 portal client. */
export function createNgsJ6PortalClient(): MacPortalClient {
  return new NgsJ6PortalClient();
}
