// @chartwarden/x12-837-client — Noridian Jurisdiction F MAC portal client (DENY-STUB; not yet operational).
//
// Lights up when a tenant lands in Noridian JF. Adding the real body is a code-change-and-test, not an
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

export class NoridianJfPortalClient implements MacPortalClient {
  public readonly jurisdiction: MacJurisdiction = "noridian_jf";

  submitFile(_input: MacPortalSubmitRequest): Promise<X12WorkerResult<MacPortalReceipt>> {
    throw new NotImplementedError("noridian_jf portal client");
  }

  pollStatus(_input: MacPortalStatusRequest): Promise<X12WorkerResult<MacPortalStatus>> {
    throw new NotImplementedError("noridian_jf portal client");
  }
}

export function createNoridianJfPortalClient(): MacPortalClient {
  return new NoridianJfPortalClient();
}
