import {
  CLOCK_ADVANCING_ATTESTATION_MODES,
  SUPERVISORY_CADENCE,
  isCadenceOverrideLegal,
  supervisoryEscalationDays,
} from "@chartwarden/discipline-plans";
// apps/backend/src/modules/15-discipline-care-plans/lifecycle/supervisory.ts — M15-T03 (§2.2.4 / §7.1).
//
// The 42 CFR §418.76(h) RN supervisory cadence — the Aide POC's compliance heart:
//
//   • `computeNextSupervisoryDueAt` OWNS the `discipline_care_plan.next_supervisory_due_at` column value:
//     `supervisory_at + COALESCE(tenant_override, 14) days` (§2.3). One home for the day math, shared by
//     the plan-activation path (§7.1: the clock arms at the first signature), the supervisory-visit
//     recording path, and the 6-hourly overdue cron (M15-T06).
//   • `decideRecordSupervisoryVisit` is the pure §2.2.4 guard set behind route 15: the corrective-actions
//     floor, the aide-on-plan check, the supervising-RN check, and the D3 rule that a documented
//     PHONE-only supervision (null `source_encounter_id`) does NOT advance the clock — it is recorded for
//     survey discoverability and the 14-day window keeps running.
//   • `evaluateSupervisoryCadence` is the §7.1 ladder (`on_time → due → overdue → gate_engaged`) the M17
//     day view, the M14 dashboard and the CHHA encounter-sign gate all read, so "day 12 warn / day 14 red
//     / day 16 block" has exactly one implementation.
//
// PURE & deterministic — `now`, the cadence override and every cross-module fact (the M8 encounter's
// author + patient, resolved through `SignedEncountersReader` in `../consumers`) are injected. Fail-CLOSED
// per §8.7: an unresolvable clock is treated as due, never as on-time.
import type {
  AideSupervisoryAttestationMode,
  DisciplinePlanId,
  IsoInstant,
  MembershipId,
  SupervisoryCadenceState,
} from "@chartwarden/types";
import type { DisciplinePlanSideEffect } from "./effects";
import { require_ } from "./errors";
import { TEXT_MINIMUMS } from "./validation";

const MS_PER_DAY = 86_400_000;

/**
 * §2.3 — the effective cadence for a plan: `COALESCE(tenant_override, 14)`. A tenant override may only
 * TIGHTEN the CoP floor; `> 14` is a policy violation and is refused here rather than silently clamped,
 * because silently clamping would hide a misconfiguration the agency needs to see (D3).
 */
export function effectiveCadenceDays(overrideDays: number | null | undefined): number {
  if (overrideDays === null || overrideDays === undefined) {
    return SUPERVISORY_CADENCE.platformFloorDays;
  }
  require_(
    isCadenceOverrideLegal(overrideDays),
    "SUPERVISORY_CADENCE_ILLEGAL",
    `a supervisory cadence override of ${overrideDays} days may only tighten the 42 CFR 418.76(h) 14-day floor`,
  );
  return overrideDays;
}

/**
 * §2.3 / §7.1 — `next_due_at = supervisory_at + cadence_days`. Called at the Aide POC's first signature
 * (the clock arms) and on every recorded clock-advancing supervisory visit (the clock re-arms).
 */
export function computeNextSupervisoryDueAt(
  supervisoryAt: IsoInstant,
  cadenceDaysOverride: number | null | undefined,
): IsoInstant {
  const cadenceDays = effectiveCadenceDays(cadenceDaysOverride);
  return new Date(Date.parse(supervisoryAt) + cadenceDays * MS_PER_DAY).toISOString();
}

/** §2.2.4 — whether an attestation mode advances the 14-day clock (a phone-only supervision does not). */
export function advancesSupervisoryClock(
  attestationMode: AideSupervisoryAttestationMode,
  sourceEncounterId: string | null,
): boolean {
  return sourceEncounterId !== null && CLOCK_ADVANCING_ATTESTATION_MODES.includes(attestationMode);
}

/** The already-resolved facts route 15 decides an `aide_supervisory_visit` INSERT over (§2.2.4 / §4.2). */
export interface SupervisoryVisitFacts {
  readonly planStatus: string;
  /** `discipline_care_plan.aide_membership_id` — the aide the POC is written for. */
  readonly planAideMembershipId: MembershipId | null;
  /** `discipline_care_plan.supervising_rn_membership_id` — the RN who owns the supervision. */
  readonly planSupervisingRnMembershipId: MembershipId | null;
  readonly aideMembershipId: MembershipId;
  readonly supervisingRnMembershipId: MembershipId;
  /** Null = documented phone supervision (does NOT advance the clock, §2.2.4). */
  readonly sourceEncounterId: string | null;
  /**
   * Whether `sourceEncounterId` resolved through M8's `SignedEncountersReader` to a SIGNED encounter on
   * this patient authored by `supervisingRnMembershipId` in this org (§2.3). Resolved by `../consumers`;
   * irrelevant (and ignored) when `sourceEncounterId` is null.
   */
  readonly sourceEncounterValid: boolean;
  readonly supervisoryAt: IsoInstant;
  readonly attestationMode: AideSupervisoryAttestationMode;
  readonly aidePerformanceSatisfactory: boolean;
  readonly correctiveActions: string | null;
  /** `discipline_care_plan.supervisory_cadence_days_override`. */
  readonly cadenceDaysOverride: number | null;
}

/** The pure decision an `aide_supervisory_visit` INSERT produces (§2.2.4). */
export interface SupervisoryVisitDecision {
  /** The `aide_supervisory_visit.cadence_days_at_insert` column value (the cadence actually applied). */
  readonly cadenceDaysAtInsert: number;
  /** The row's own `next_due_at`. */
  readonly nextDueAt: IsoInstant;
  /** Whether the parent plan's `next_supervisory_due_at` re-arms (false for a phone-only supervision). */
  readonly advancesClock: boolean;
  readonly effects: ReadonlyArray<DisciplinePlanSideEffect>;
}

/**
 * §2.2.4 / §4.2 — validate and decide an `aide_supervisory_visit` INSERT. Raises the exact §4.2 codes:
 * `PLAN_NOT_ACTIVE` (409), `AIDE_NOT_ON_PLAN` (422), `NOT_AIDE_SUPERVISOR` (403),
 * `INVALID_ENCOUNTER_REFERENCE` (422), `CORRECTIVE_ACTIONS_REQUIRED` (422). Emits
 * `m15.aide_supervisory.completed` (idempotency key `supervisoryVisitId`, §2.4) which M30/M33/M36 consume;
 * the parent plan's clock effect is only declared when the attestation actually advances it.
 */
export function decideRecordSupervisoryVisit(
  facts: SupervisoryVisitFacts,
): SupervisoryVisitDecision {
  require_(
    facts.planStatus === "active" || facts.planStatus === "draft_revising",
    "PLAN_NOT_ACTIVE",
    "a supervisory visit may only be recorded on a live Aide POC",
  );
  require_(
    facts.planAideMembershipId !== null && facts.planAideMembershipId === facts.aideMembershipId,
    "AIDE_NOT_ON_PLAN",
    "the supervised aide is not the aide assigned to this Aide POC",
  );
  require_(
    facts.planSupervisingRnMembershipId !== null &&
      facts.planSupervisingRnMembershipId === facts.supervisingRnMembershipId,
    "NOT_AIDE_SUPERVISOR",
    "only the plan's supervising RN may attest a 418.76(h) supervisory visit",
  );
  // A supplied encounter reference must be a SIGNED M8 encounter on this patient authored by the
  // supervising RN (§2.3). Null is the documented phone-supervision path — legal, but clock-neutral.
  if (facts.sourceEncounterId !== null) {
    require_(
      facts.sourceEncounterValid,
      "INVALID_ENCOUNTER_REFERENCE",
      "sourceEncounterId is not a signed encounter authored by the supervising RN for this patient",
    );
  }
  if (!facts.aidePerformanceSatisfactory) {
    require_(
      (facts.correctiveActions ?? "").trim().length >= TEXT_MINIMUMS.correctiveActions,
      "CORRECTIVE_ACTIONS_REQUIRED",
      `corrective actions of at least ${TEXT_MINIMUMS.correctiveActions} characters are required when aide performance is unsatisfactory`,
    );
  }

  const cadenceDaysAtInsert = effectiveCadenceDays(facts.cadenceDaysOverride);
  const nextDueAt = computeNextSupervisoryDueAt(facts.supervisoryAt, facts.cadenceDaysOverride);
  const advancesClock = advancesSupervisoryClock(facts.attestationMode, facts.sourceEncounterId);

  return {
    cadenceDaysAtInsert,
    nextDueAt,
    advancesClock,
    effects: [
      ...(advancesClock
        ? ([{ kind: "recompute_supervisory_due", nextDueAt }] as const)
        : ([] as const)),
      { kind: "audit" },
      { kind: "outbox", event: "m15.aide_supervisory.completed" },
    ],
  };
}

/** The clock facts the §7.1 ladder decides over — the plan columns the cadence path maintains. */
export interface SupervisoryClockFacts {
  readonly planId: DisciplinePlanId;
  /** `discipline_care_plan.next_supervisory_due_at`; null before the Aide POC's first signature. */
  readonly nextSupervisoryDueAt: IsoInstant | null;
  readonly cadenceDaysOverride: number | null;
}

/**
 * §7.1 — the supervisory ladder as of `now`. `due` is the cadence expiry itself (the plan banner turns
 * red); `gate_engaged` is the 2-day grace past it, past which a new CHHA encounter cannot be signed
 * (`AIDE_SUPERVISORY_OVERDUE`) without a documented Clinical-Supervisor override. `on_time` covers the
 * pre-warning window; the day-12 `warn` alert is derived from `warnAtDays` by the M36 alert builder
 * (M15-T06), which reads the same `supervisoryEscalationDays` ladder.
 *
 * Returns null only when the plan has no armed clock (pre-first-signature) — the caller treats that as
 * "no supervisory obligation yet", which is exactly the §7.1 state before the POC is signed.
 */
export function evaluateSupervisoryCadence(
  facts: SupervisoryClockFacts,
  now: IsoInstant,
): SupervisoryCadenceState | null {
  if (facts.nextSupervisoryDueAt === null) return null;
  const cadenceDays = effectiveCadenceDays(facts.cadenceDaysOverride);
  const ladder = supervisoryEscalationDays(cadenceDays);
  const nowMs = Date.parse(now);
  const dueMs = Date.parse(facts.nextSupervisoryDueAt);
  // The gate engages `encounterSignGateAtDays - overdueAtDays` days past the due instant (2 at the
  // 14-day default); the warn mark sits the same distance before it.
  const graceMs = (ladder.encounterSignGateAtDays - ladder.overdueAtDays) * MS_PER_DAY;
  const warnMs = (ladder.overdueAtDays - ladder.warnAtDays) * MS_PER_DAY;

  const status: SupervisoryCadenceState["status"] =
    nowMs >= dueMs + graceMs
      ? "gate_engaged"
      : nowMs >= dueMs
        ? "overdue"
        : nowMs >= dueMs - warnMs
          ? "due"
          : "on_time";

  return { planId: facts.planId, nextDueAt: facts.nextSupervisoryDueAt, cadenceDays, status };
}

/**
 * §7.1 / §8.7 — the CHHA encounter-sign gate. `true` means a new `chha_visit` encounter may NOT be signed
 * without a documented Clinical-Supervisor override. Fail-CLOSED: an unresolvable cadence state (the M15
 * outage path in §8.7) blocks rather than allows, so an unsupervised aide's visit never quietly bills.
 */
export function isSupervisoryGateEngaged(state: SupervisoryCadenceState | null): boolean {
  return state === null ? false : state.status === "gate_engaged";
}

/** Hours a plan is past its `next_supervisory_due_at` as of `now` (0 when not yet due) — §4.3 worklist. */
export function hoursOverdue(nextDueAt: IsoInstant, now: IsoInstant): number {
  const deltaMs = Date.parse(now) - Date.parse(nextDueAt);
  return deltaMs <= 0 ? 0 : Math.floor(deltaMs / 3_600_000);
}
