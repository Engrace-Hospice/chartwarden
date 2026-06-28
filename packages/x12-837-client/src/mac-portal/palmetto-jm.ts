// @wardenx/x12-837-client — Palmetto Jurisdiction M MAC portal client (DENY-STUB; not yet operational).
//
// Lights up when a tenant lands in Palmetto JM. Adding the real body is a code-change-and-test, not an
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

export class PalmettoJmPortalClient implements MacPortalClient {
  public readonly jurisdiction: MacJurisdiction = "palmetto_jm";

  submitFile(_input: MacPortalSubmitRequest): Promise<X12WorkerResult<MacPortalReceipt>> {
    throw new NotImplementedError("palmetto_jm portal client");
  }

  pollStatus(_input: MacPortalStatusRequest): Promise<X12WorkerResult<MacPortalStatus>> {
    throw new NotImplementedError("palmetto_jm portal client");
  }
}

export function createPalmettoJmPortalClient(): MacPortalClient {
  return new PalmettoJmPortalClient();
}
