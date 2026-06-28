// @wardenx/x12-837-client — Palmetto Jurisdiction J MAC portal client (DENY-STUB; not yet operational).
//
// Lights up when a tenant lands in Palmetto JJ. Adding the real body is a code-change-and-test, not an
// M23-surface change (spec §8.5): replace the throws with the real file-drop + status-poll, then the
// shared MacPortalClient CONFORMANCE TEST (task 20) — submitFile + pollStatus honor the common contract
// and return the X12WorkerResult envelope — must pass. dependency-cruiser (task 20) forbids this module
// from importing any sibling jurisdiction module: it imports ONLY from ../types.
import {
  NotImplementedError,
  type MacJurisdiction,
  type MacPortalClient,
  type MacPortalReceipt,
  type MacPortalStatus,
  type MacPortalStatusRequest,
  type MacPortalSubmitRequest,
  type X12WorkerResult,
} from "../types";

export class PalmettoJjPortalClient implements MacPortalClient {
  public readonly jurisdiction: MacJurisdiction = "palmetto_jj";

  submitFile(_input: MacPortalSubmitRequest): Promise<X12WorkerResult<MacPortalReceipt>> {
    throw new NotImplementedError("palmetto_jj portal client");
  }

  pollStatus(_input: MacPortalStatusRequest): Promise<X12WorkerResult<MacPortalStatus>> {
    throw new NotImplementedError("palmetto_jj portal client");
  }
}

export function createPalmettoJjPortalClient(): MacPortalClient {
  return new PalmettoJjPortalClient();
}
