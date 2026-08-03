// @wardenx/inpatient — M37-T08, §2.10 D11. The pure restraint policy core: application validation, the
// reassessment cadence clock, and the active → released state machine. Default IPU posture is
// restraint-free; a restraint requires the step-up `m37.restraint.apply` permission, a ≥100-char
// justification, and a physician order (CoP 418.110, required even in emergency). IO-free — the route
// (M37-T11) resolves the permission/step-up and injects the facts.
import type { IpuRestraintEventState, IpuRestraintReassessmentOutcome } from "@wardenx/types";
import { IpuStateError, requireIpu } from "../errors";

/** §2.10 — the reassessment-interval platform floors (minutes): 15 behavioral, 120 medical. Tighten-only. */
export const RESTRAINT_REASSESS_FLOOR_MINUTES = { behavioral: 15, medical: 120 } as const;
/** §2.10 — the restraint justification floor (chars). */
export const RESTRAINT_JUSTIFICATION_MIN = 100;

/** A restraint's clinical category — drives the reassessment-interval floor. */
export type RestraintCategory = keyof typeof RESTRAINT_REASSESS_FLOOR_MINUTES;

/** The §4.4 `m37.restraint.*` outbox events this core emits. */
export type RestraintOutboxEvent =
  | "m37.restraint.applied"
  | "m37.restraint.reassessment_due"
  | "m37.restraint.reassessment_completed"
  | "m37.restraint.released";

/**
 * §2.10 — validate a restraint application. Throws the precise code on a justification / order / step-up
 * failure. All facts are injected (the DB CHECK `char_length(justification) >= 100` is the schema backstop).
 */
export function validateRestraintApply(input: {
  readonly justificationText: string;
  readonly hasOrderingOrder: boolean;
  readonly stepUpVerified: boolean;
}): void {
  requireIpu(
    input.stepUpVerified,
    "RESTRAINT_STEP_UP_REQUIRED",
    "Applying a restraint requires fresh M2 step-up (the m37.restraint.apply key is step-up gated).",
  );
  requireIpu(
    input.hasOrderingOrder,
    "RESTRAINT_ORDER_REQUIRED",
    "A restraint cannot be applied without a physician order (CoP 418.110, even in emergency).",
  );
  requireIpu(
    input.justificationText.trim().length >= RESTRAINT_JUSTIFICATION_MIN,
    "RESTRAINT_JUSTIFICATION_TOO_SHORT",
    `A restraint requires a justification ≥ ${RESTRAINT_JUSTIFICATION_MIN} chars.`,
  );
}

/** §2.10 — normalize a configured reassessment interval against its category floor (tighten-only). */
export function normalizeReassessmentInterval(configuredMinutes: number, category: RestraintCategory): number {
  const floor = RESTRAINT_REASSESS_FLOOR_MINUTES[category];
  requireIpu(
    configuredMinutes <= floor,
    "RESTRAINT_INTERVAL_NOT_TIGHTENING",
    `A ${category} restraint reassessment interval may not loosen above the ${floor}-minute floor.`,
  );
  return Math.max(1, configuredMinutes);
}

/**
 * §2.10 — is an active restraint past its reassessment interval? The `restraint-reassessment-watchdog`
 * (every 15 min) calls this against `applied_at` or the last reassessment `reassessed_at`.
 */
export function isRestraintReassessmentDue(lastAtMs: number, intervalMinutes: number, nowMs: number): boolean {
  return nowMs - lastAtMs >= intervalMinutes * 60_000;
}

/** The result of a reassessment: the effect on the event + the outbox. */
export interface RestraintReassessmentResult {
  /** Whether this reassessment closes the current restraint event (release or modify-fork). */
  readonly closesEvent: boolean;
  /** Whether a NEW restraint event is forked (a `modify` outcome). */
  readonly forksNewEvent: boolean;
  readonly nextState: IpuRestraintEventState;
  readonly outbox: RestraintOutboxEvent;
}

/**
 * §2.10 — apply a reassessment outcome to an ACTIVE restraint event. `continue` keeps it active; `release`
 * closes it; `modify` closes the prior event and forks a new one (the service persists the fork). Throws
 * `ILLEGAL_RESTRAINT_TRANSITION` if the event is already released.
 */
export function planReassessmentOutcome(
  currentState: IpuRestraintEventState,
  outcome: IpuRestraintReassessmentOutcome,
): RestraintReassessmentResult {
  requireIpu(
    currentState === "active",
    "ILLEGAL_RESTRAINT_TRANSITION",
    "Only an active restraint event can be reassessed ('released' is terminal).",
  );
  switch (outcome) {
    case "continue":
      return { closesEvent: false, forksNewEvent: false, nextState: "active", outbox: "m37.restraint.reassessment_completed" };
    case "modify":
      return { closesEvent: true, forksNewEvent: true, nextState: "released", outbox: "m37.restraint.reassessment_completed" };
    case "release":
      return { closesEvent: true, forksNewEvent: false, nextState: "released", outbox: "m37.restraint.released" };
  }
}

/**
 * §2.10 auto-closure — when an admission goes discharged/deceased/transferred, active restraints are
 * auto-closed with `released_reason='discharge_auto_close'` and a synthetic reassessment-completion row.
 */
export const RESTRAINT_DISCHARGE_AUTO_CLOSE_REASON = "discharge_auto_close";
