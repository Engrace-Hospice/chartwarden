// @wardenx/consent — the consent_renewal_cycle status machine (§2.4, D8/D13).
//
// M39-T04. A cycle opens when the first 30-day reminder fires and no open cycle exists for the
// source record. It closes when (a) a new consent record is signed with renewed_from = source
// (→ renewed), or (b) the source expires unrenewed (→ closed_expired), or (c) the source is revoked
// (→ closed_revoked), or (d) it no longer applies (→ closed_no_longer_applicable). The renewal chain
// is auditable independently from the supersession chain.
import type { ConsentRenewalCycleStatus } from "../interfaces/kinds";
import { type Decision, deny, ok } from "./result";

export type RenewalCloseReason =
  | "renewed"
  | "expired_without_renewal"
  | "revoked"
  | "no_longer_applicable";

const CLOSE_STATUS: Record<RenewalCloseReason, ConsentRenewalCycleStatus> = {
  renewed: "renewed",
  expired_without_renewal: "closed_expired",
  revoked: "closed_revoked",
  no_longer_applicable: "closed_no_longer_applicable",
};

/** Close an OPEN cycle for the given reason. Only an `open` cycle may be closed. */
export function closeRenewalCycle(
  current: ConsentRenewalCycleStatus,
  reason: RenewalCloseReason,
): Decision<ConsentRenewalCycleStatus> {
  if (current !== "open")
    return deny("renewal_cycle_not_open", `cannot close a renewal cycle in state '${current}'`);
  return ok<ConsentRenewalCycleStatus>(CLOSE_STATUS[reason]);
}

/** Whether a fresh cycle should be opened for a source record on a reminder fire (idempotent: skip
 *  if one is already open). */
export function shouldOpenRenewalCycle(hasOpenCycle: boolean): boolean {
  return !hasOpenCycle;
}
