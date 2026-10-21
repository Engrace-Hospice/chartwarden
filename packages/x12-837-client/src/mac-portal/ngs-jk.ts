// @chartwarden/x12-837-client — NGS Jurisdiction K MAC portal client (DENY-STUB; not yet operational).
//
// Lights up when a tenant lands in NGS JK. Adding the real body is a code-change-and-test, not an
// M23-surface change (spec §8.5): replace the throws with the real file-drop + status-poll, then the
// shared MacPortalClient CONFORMANCE TEST (task 20) — submitFile + pollStatus honor the common contract
// and return the X12WorkerResult envelope — must pass. dependency-cruiser (task 20) forbids this module
// from importing any sibling jurisdiction module: it imports ONLY from ../types.
import {
  type MacJurisdiction,
  type MacPortalClient,
  type MacPortalReceipt,
  type MacPortalStatus,
  type MacPortalStatusRequest,
  type MacPortalSubmitRequest,
  NotImplementedError,
  type X12WorkerResult,
} from "../types";

export class NgsJkPortalClient implements MacPortalClient {
  public readonly jurisdiction: MacJurisdiction = "ngs_jk";

  submitFile(_input: MacPortalSubmitRequest): Promise<X12WorkerResult<MacPortalReceipt>> {
    throw new NotImplementedError("ngs_jk portal client");
  }

  pollStatus(_input: MacPortalStatusRequest): Promise<X12WorkerResult<MacPortalStatus>> {
    throw new NotImplementedError("ngs_jk portal client");
  }
}

export function createNgsJkPortalClient(): MacPortalClient {
  return new NgsJkPortalClient();
}
