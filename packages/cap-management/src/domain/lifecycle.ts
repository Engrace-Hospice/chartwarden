// @wardenx/cap-management — the cap_period state machine (§2.2). Deterministic, owned entirely by M26;
// downstream consumers observe transitions via outbox events and never mutate state directly. Any rejected
// transition surfaces as a 409 with a structured transition_rejected error (the route layer maps it).
//
//   open ──first accrual / t>startsOn──▶ active ──close (Sep30+grace | manual)──▶ in_settlement
//   in_settlement ──settlement finalize (step-up)──▶ settled ──reopen (step-up+reason)──▶ reopened
//   reopened ──re-finalize──▶ settled
import type { PeriodStatus } from "./types";

/** Allowed status → status transitions. */
const TRANSITIONS: Record<PeriodStatus, readonly PeriodStatus[]> = {
  open: ["active"],
  active: ["in_settlement"],
  in_settlement: ["settled"],
  settled: ["reopened"],
  reopened: ["settled"],
};

export class CapTransitionError extends Error {
  constructor(
    public readonly from: PeriodStatus,
    public readonly to: PeriodStatus,
  ) {
    super(`cap_period transition rejected: ${from} → ${to}`);
    this.name = "CapTransitionError";
  }
}

/** True if `from → to` is a legal cap_period transition. */
export function canTransition(from: PeriodStatus, to: PeriodStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Assert a legal transition or throw CapTransitionError (the route maps it to a 409). */
export function assertTransition(from: PeriodStatus, to: PeriodStatus): void {
  if (!canTransition(from, to)) throw new CapTransitionError(from, to);
}

/** The accrual-eligible states (the `cap_period_open` ABAC predicate): open/active/reopened. */
export function isAccrualEligible(status: PeriodStatus): boolean {
  return status === "open" || status === "active" || status === "reopened";
}

/** open → active when the first accrual lands (or the window has started); a no-op once already active+. */
export function statusOnFirstAccrual(status: PeriodStatus): PeriodStatus {
  return status === "open" ? "active" : status;
}
