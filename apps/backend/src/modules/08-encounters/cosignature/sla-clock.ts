// apps/backend/src/modules/08-encounters/cosignature/sla-clock.ts — M8-T06 (§2.4 D3 SLA clock).
//
// The D3 cosignature SLA is an HOUR-based clock measured from the moment the request was routed (the
// LPN/CHHA primary sign): soft alert at 12h, escalation to the clinical supervisor at 24h, hard cap at
// 48h. PURE and deterministic — `routedAt` and the "as of" instant are passed in as ISO strings (the
// §4.3 cron tick supplies "now"); there is no `Date.now()` and no IO, so the 12h/24h/48h boundaries
// are testable with a fixed clock (the §7.3 acceptance walks T+12h/T+24h/T+48h). The pure stage
// decision drives the §4.3 hard-cap sweep; the side-effecting state change is the ./cosignature machine.
import type { CosignatureStatus } from "@chartwarden/types";

/** The D3 SLA thresholds, in whole hours from `routedAt` (§2.4 / §1.1). */
export const COSIGNATURE_SLA_HOURS = {
  /** 12h — soft alert to the cosigner (`m8.encounter.cosignature_overdue`, warn). No state change. */
  overdue: 12,
  /** 24h — escalation to the clinical supervisor (`m8.encounter.cosignature_escalated`, warn). */
  escalate: 24,
  /** 48h — hard cap; encounter locked (`m8.encounter.cosignature_hard_cap_reached`, critical). */
  hardCap: 48,
} as const;

const MS_PER_HOUR = 3_600_000;

/** Add whole hours to an ISO instant; returns an ISO instant. */
export function addHours(instant: string, hours: number): string {
  return new Date(Date.parse(instant) + hours * MS_PER_HOUR).toISOString();
}

/** Whole-and-fractional hours elapsed from `from` to `to` (`to − from`); negative if `to` precedes. */
export function hoursBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / MS_PER_HOUR;
}

/** The three SLA boundary instants for a routed request (§2.4). */
export interface CosignatureSlaDeadlines {
  readonly overdueAt: string;
  readonly escalateAt: string;
  readonly hardCapAt: string;
}

/** Compute the 12h/24h/48h boundary instants from the moment the request was routed (§2.4). */
export function computeCosignatureSlaDeadlines(routedAtInstant: string): CosignatureSlaDeadlines {
  return {
    overdueAt: addHours(routedAtInstant, COSIGNATURE_SLA_HOURS.overdue),
    escalateAt: addHours(routedAtInstant, COSIGNATURE_SLA_HOURS.escalate),
    hardCapAt: addHours(routedAtInstant, COSIGNATURE_SLA_HOURS.hardCap),
  };
}

/**
 * The action the §4.3 cron sweep should take for one request at `asOfInstant`. The sweep is keyed on a
 * 15-minute cadence; this returns the single un-reached SLA stage given the elapsed time AND the
 * current status (so a request already `escalated` is not re-escalated, and a terminal/locked/released
 * request yields `none`). The `overdue` (12h) stage is a soft alert that does NOT change state, so its
 * once-only delivery is the job layer's `jobIdempotencyKey` concern (§4.3) — this function reports the
 * 12–24h window membership; the escalate/hard-cap stages also flip the request status (./cosignature).
 */
export type CosignatureSlaStage = "none" | "overdue" | "escalate" | "hard_cap";

/** Decide the SLA stage for a request given how long it has been awaiting cosignature (§2.4, §7.3). */
export function decideCosignatureSlaStage(input: {
  readonly routedAtInstant: string;
  readonly asOfInstant: string;
  readonly currentStatus: CosignatureStatus;
}): CosignatureSlaStage {
  // Only requests still actively awaiting cosignature are swept; the rest are terminal or supervisor-
  // gated (a `hard_cap_reached`/`supervisor_released`/`signed` request has already reached its ceiling).
  if (
    input.currentStatus !== "routed" &&
    input.currentStatus !== "acknowledged" &&
    input.currentStatus !== "escalated"
  ) {
    return "none";
  }
  const elapsed = hoursBetween(input.routedAtInstant, input.asOfInstant);
  if (elapsed >= COSIGNATURE_SLA_HOURS.hardCap) return "hard_cap";
  // Escalation only fires from a not-yet-escalated request; an already-escalated row stays put until 48h.
  if (elapsed >= COSIGNATURE_SLA_HOURS.escalate) {
    return input.currentStatus === "escalated" ? "none" : "escalate";
  }
  if (elapsed >= COSIGNATURE_SLA_HOURS.overdue) return "overdue";
  return "none";
}
