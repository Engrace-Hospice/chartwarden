// @wardenx/bereavement — §2 / D4 / D7 / D9 pure-data policy constants (M16-T01 domain layout).
//
// The regulatory clocks and the closure / opt-out windows the CoP 418.64(d) program runs on, declared once
// here rather than re-derived in each service, worker, and CHECK constraint.
// PURE DATA — no IO, `@wardenx/types`-only.

import type {
  BereavementPlanClosureReason,
  BereavementPlanStatus,
  BereavedContactStatus,
} from "@wardenx/types";

/**
 * D4 — the CoP 418.64(d) obligation runs "until at least 1 year following death"; the platform floor is the
 * 13-month window `[death_date, death_date + 396 days)`. The anchor is the DEATH date, never the discharge
 * date: M6 W-DC-01 allows a late discharge filing, and anchoring there would silently shorten the
 * survivor's program by however long the paperwork lagged.
 */
export const BEREAVEMENT_WINDOW_DAYS = 396 as const;

/**
 * §2.5 / §3.3.4 — an outreach `due_at` must sit within the window plus a 30-day operational grace. The
 * 426-day ceiling is a CHECK on `bereavement_outreach` against the DENORMALIZED `death_date` (M16-F10 /
 * ADR-0022 D1.2: PostgreSQL forbids a subquery in a CHECK, so the plan's death date is copied onto the row).
 */
export const BEREAVEMENT_WINDOW_GRACE_DAYS = 30 as const;

/** §2.5 — the hard `due_at` ceiling in days from `death_date` (window + grace). */
export const OUTREACH_DUE_AT_CEILING_DAYS = BEREAVEMENT_WINDOW_DAYS + BEREAVEMENT_WINDOW_GRACE_DAYS;

/** §2.2 — how long past `due_at` a missed touchpoint may still be attempted. Inside the grace a
 *  `lateAttempt` re-opens the row (audit-flagged); past it the hourly worker's `missed` verdict stands. */
export const OUTREACH_LATE_ATTEMPT_GRACE_DAYS = 7 as const;

/** §2.3 — consecutive `no_response` contact logs before the nightly detector PROPOSES `markUnreachable`.
 *  It proposes; the counselor decides (the detector never transitions the contact itself). */
export const UNREACHABLE_CONSECUTIVE_NO_RESPONSE_THRESHOLD = 3 as const;

/** D9 — a bereaved contact may rescind their own opt-out through the M31 portal for this long. After the
 *  window, re-enrollment is counselor-driven with fresh M39 consent (a portal click must not silently
 *  un-do a survivor's considered decision). */
export const OPT_OUT_SELF_SERVICE_RESCIND_WINDOW_DAYS = 90 as const;

/** D7 / §2.5 — an early-close narrative must be at least this long. Matches M15's override-reason floor. */
export const EARLY_CLOSE_REASON_MIN_LENGTH = 40 as const;

/**
 * D7 — the closure reasons that require a clinical-supervisor cosign. The 13-month completion and the two
 * D9 patient-opt-out reasons are deliberately absent: the first is the regulatory clock running out, and
 * the second is honoring a directive the patient (or their DPOA) already gave — neither is a clinical
 * judgment call a supervisor should be asked to ratify. The same set is CHECK-enforced on
 * `bereavement_plan_closure` in M16-T02.
 */
export const COSIGN_REQUIRED_CLOSURE_REASONS: readonly BereavementPlanClosureReason[] = [
  "tenant_offboarding",
  "all_bereaved_deceased",
  "geographic_relocation",
  "family_legal_action",
  "other_early",
] as const;

/** D7 — whether a closure reason needs the supervisor cosign before the plan may reach `closed_early`. */
export function requiresCloseCosign(reason: BereavementPlanClosureReason): boolean {
  return COSIGN_REQUIRED_CLOSURE_REASONS.includes(reason);
}

/** §2.2 — the plan statuses that mean the program has ended. `closed_legal_hold_extended` is included: the
 *  program IS over; only M4's retention clock is still running. */
export const CLOSED_PLAN_STATUSES: readonly BereavementPlanStatus[] = [
  "closed_completed",
  "closed_declined",
  "closed_early",
  "closed_legal_hold_extended",
] as const;

/** §2.2 — true when no further outreach may be scheduled against the plan. */
export function isClosedPlanStatus(status: BereavementPlanStatus): boolean {
  return CLOSED_PLAN_STATUSES.includes(status);
}

/** §2.3 / D6 — the contact statuses that still count toward "the plan has someone to serve". A plan whose
 *  every contact leaves this set closes as `closed_declined` only when they all left via OPT-OUT (D6); a
 *  roster that merely went unreachable or deceased does not decline the program. */
export const ENGAGEABLE_CONTACT_STATUSES: readonly BereavedContactStatus[] = [
  "proposed",
  "active",
] as const;

/** §2.3 — true while the contact may still be scheduled for outreach. */
export function isEngageableContactStatus(status: BereavedContactStatus): boolean {
  return ENGAGEABLE_CONTACT_STATUSES.includes(status);
}

/**
 * D6 — the plan-level close-on-full-opt-out guard. `closed_declined` requires that EVERY contact opted out,
 * not merely that none is engageable: a roster of one deceased and one unreachable contact is an
 * operational problem for the counselor, not a declined program, and closing it as `declined` would put a
 * false "the family refused bereavement services" on the survey record.
 */
export function shouldCloseAsDeclined(
  contactStatuses: readonly BereavedContactStatus[],
): boolean {
  return contactStatuses.length > 0 && contactStatuses.every((s) => s === "opted_out");
}

/** §7.10 / §4.9 — the days-out marks the anniversary lookahead alerts on. The cron emits the
 *  `anniversary_due_in_14_days` event at the 14-day boundary; the 30 / 7 equivalents are tenant tightenings
 *  of the same ladder. */
export const ANNIVERSARY_ALERT_DAYS_OUT = [30, 14, 7] as const;

/** §7.10 — how loud the anniversary ladder is at a given days-out. It never goes quiet as the date nears;
 *  a `hasScheduledContact === false` at 7 days is the `critical` case (nobody is going to reach out). */
export function anniversaryAlertSeverity(
  daysOut: number,
  hasScheduledContact: boolean,
): "info" | "warn" | "critical" {
  if (daysOut <= 7) return hasScheduledContact ? "warn" : "critical";
  if (daysOut <= 14) return "warn";
  return "info";
}

/** §2.5 — `bereavement_plan` and `bereaved_contact` carry `version int`; PATCH requires `If-Match:
 *  <version>` and answers a mismatch with 412 + the current row (the M7 §7.7 / M15 pattern verbatim). */
export const OPTIMISTIC_CONCURRENCY_HEADER = "If-Match" as const;

/** §4.4 — the `payloadSchemaVersion` stamped on every M16 outbox envelope; a consumer refusing an unknown
 *  version dead-letters rather than guessing. */
export const M16_PAYLOAD_SCHEMA_VERSION = "2026-01-v1" as const;

// ── Death-date anchored window arithmetic (pure; UTC-normalized) ──────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/** Parses a `YYYY-MM-DD` local date into the UTC midnight instant it anchors on. Throws on a malformed
 *  date rather than silently producing `NaN` days (a NaN would make every window check pass vacuously). */
function utcMidnight(localDate: string): number {
  const ms = Date.parse(`${localDate}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new RangeError(`bereavement: malformed local date '${localDate}'`);
  return ms;
}

/** D4 — the exclusive end of the bereavement window as an ISO instant (`death_date + 396 days`). M36
 *  pre-computes its channel `archives_at` from this and M5 expires the bereavement-window cache on it. */
export function bereavementWindowEnd(deathDate: string): string {
  return new Date(utcMidnight(deathDate) + BEREAVEMENT_WINDOW_DAYS * MS_PER_DAY).toISOString();
}

/** D4 — whole days elapsed from `death_date` to an instant. Negative before the death date. */
export function daysSinceDeath(deathDate: string, asOfIso: string): number {
  const asOf = Date.parse(asOfIso);
  if (Number.isNaN(asOf)) throw new RangeError(`bereavement: malformed instant '${asOfIso}'`);
  return Math.floor((asOf - utcMidnight(deathDate)) / MS_PER_DAY);
}

/** D4 — whether an instant falls inside `[death_date, death_date + 396 days)`. Half-open on purpose: day
 *  396 is the close-out day, and the auto-close worker fires ON it. */
export function isWithinBereavementWindow(deathDate: string, asOfIso: string): boolean {
  const days = daysSinceDeath(deathDate, asOfIso);
  return days >= 0 && days < BEREAVEMENT_WINDOW_DAYS;
}

/** §2.5 — whether a proposed `due_at` satisfies the window + grace ceiling the DB CHECK enforces. */
export function isOutreachDueAtWithinCeiling(deathDate: string, dueAtIso: string): boolean {
  const days = daysSinceDeath(deathDate, dueAtIso);
  return days >= 0 && days <= OUTREACH_DUE_AT_CEILING_DAYS;
}

/** D9 — whether a contact may still self-service rescind their opt-out through the portal. */
export function isWithinOptOutRescindWindow(optedOutAtIso: string, asOfIso: string): boolean {
  const optedOut = Date.parse(optedOutAtIso);
  const asOf = Date.parse(asOfIso);
  if (Number.isNaN(optedOut) || Number.isNaN(asOf)) {
    throw new RangeError("bereavement: malformed opt-out rescind-window instant");
  }
  const days = (asOf - optedOut) / MS_PER_DAY;
  return days >= 0 && days <= OPT_OUT_SELF_SERVICE_RESCIND_WINDOW_DAYS;
}
