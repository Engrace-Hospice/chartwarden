// @wardenx/hope — the Symptom-Follow-Up-Visit engine (M10-T03; §2.2.3, §2.3, D3, D4). PURE, IO-free.
// Three concerns:
//   • creation  — `planSfvCreation`: when J2051 fires (D4), produce the one `symptom_follow_up_visit`
//     descriptor with the D3 due-date (signed_at + 2 calendar days, org-TZ).
//   • completion — `planSfvCompletion`: the open/overdue → completed transition guard (a signed RFA-04
//     row completes its source SFV; rejects double-completion and past-due-without-override).
//   • watchdog   — `decideSfvWatchdogStatus`: the cron-side open → overdue → missed time-based decay.
// The recording service (M10-T06) composes creation/completion over the write tx; the `sfv-watchdog`
// cron (M10-T06) composes the watchdog. The schema's `uniq_sfv_per_triggering_assessment` index makes
// the one-SFV-per-source rule a hard invariant; these pure machines decide it first.
import type {
  HopeAssessmentId,
  HopeSfvStatus,
  IsoInstant,
  SymptomFollowUpVisitId,
} from "@wardenx/types";
import { require_ } from "../errors";
import { DEFAULT_SFV_ALERT_CADENCE, type SfvAlertCadence } from "../scheduling/alert-cadence";
import { addCalendarDays, endOfOrgDayInstant, orgLocalDate } from "../scheduling/time";

/** D3 — calendar days from the triggering assessment's `signed_at` within which the SFV is due. CMS
 * regulatory floor; not tenant-configurable (computed from `signed_at`, org-TZ-aware). */
export const SFV_DUE_CALENDAR_DAYS = 2;

/** §2.2.3 — calendar days an `overdue` SFV decays to `missed` after its `due_at` passes. */
export const SFV_MISSED_AFTER_DAYS = 7;

/** A `symptom_follow_up_visit` row the recording service should INSERT when J2051 fires (D4). The
 * tenancy/who-where columns are joined from the triggering assessment by the service; this descriptor
 * carries the lifecycle-defining fields. */
export interface SfvDescriptor {
  readonly triggeringAssessmentId: HopeAssessmentId;
  readonly triggeredAt: IsoInstant;
  readonly dueAt: IsoInstant;
  readonly alertCadence: SfvAlertCadence;
}

/** Facts the recording service injects after a HOPE assessment with `j2051_trigger_fired=true` signs. */
export interface SfvCreationFacts {
  readonly triggeringAssessmentId: HopeAssessmentId;
  /** The triggering assessment's `signed_at` — the D3 anchor (NOT `created_at`, so a long-running draft
   * cannot satisfy the window without the clinical signature). */
  readonly signedAt: IsoInstant;
  readonly timeZone: string;
  readonly alertCadence?: SfvAlertCadence;
}

/**
 * D3 / D4 — plan the single SFV for a triggering assessment. `due_at` is the END of the org-local day
 * `signed_at + 2 calendar days` (the "within 2 calendar days" CMS floor). Deterministic; the caller
 * inserts exactly one row (the unique index enforces one-per-source).
 */
export function planSfvCreation(facts: SfvCreationFacts): SfvDescriptor {
  const dueDate = addCalendarDays(
    orgLocalDate(facts.signedAt, facts.timeZone),
    SFV_DUE_CALENDAR_DAYS,
  );
  return {
    triggeringAssessmentId: facts.triggeringAssessmentId,
    triggeredAt: facts.signedAt,
    dueAt: endOfOrgDayInstant(dueDate, facts.timeZone),
    alertCadence: facts.alertCadence ?? DEFAULT_SFV_ALERT_CADENCE,
  };
}

/** The minimal projection of an open SFV the completion path validates against. */
export interface SfvCompletionTarget {
  readonly id: SymptomFollowUpVisitId;
  readonly status: HopeSfvStatus;
  readonly dueAt: IsoInstant;
}

/** The in-transaction effect a validated SFV completion produces (the service applies it as DB writes). */
export interface SfvCompletionPlan {
  readonly sfvId: SymptomFollowUpVisitId;
  readonly completingAssessmentId: HopeAssessmentId;
}

/**
 * §2.2.3 — complete an SFV with the signed RFA-04 row that addressed it. Guards (in §4.4 order):
 *   - SFV must not already be `completed`            → 409 `M10_SFV_ALREADY_COMPLETED`
 *   - capture is not past `due_at` (+grace) unless an admin override is supplied → 409 `M10_SFV_PAST_DUE`
 * `overdue` and `missed` SFVs may still be completed (the obligation persists; lateness is recorded), but
 * a `missed`/past-due completion needs the admin override flag — the surveyor sees both the miss and the
 * eventual completion. Pure: the service writes `status='completed'`, `completing_assessment_id`.
 */
export function planSfvCompletion(
  target: SfvCompletionTarget,
  completingAssessmentId: HopeAssessmentId,
  completedAt: IsoInstant,
  options: { readonly adminOverride?: boolean } = {},
): SfvCompletionPlan {
  require_(
    target.status !== "completed",
    "M10_SFV_ALREADY_COMPLETED",
    `Symptom-follow-up-visit ${target.id} is already completed.`,
  );
  const pastDue = Date.parse(completedAt) > Date.parse(target.dueAt);
  require_(
    !pastDue || options.adminOverride === true,
    "M10_SFV_PAST_DUE",
    `Symptom-follow-up-visit ${target.id} is past due (${target.dueAt}); an admin override is required to complete it late.`,
  );
  return { sfvId: target.id, completingAssessmentId };
}

/**
 * §2.2.3 — the watchdog cron's time-based decay for an `open`/`overdue` SFV as of `asOfInstant`:
 *   open|overdue, `asOf` > due_at + {@link SFV_MISSED_AFTER_DAYS} → `missed` (terminal; fires `sfv_missed`)
 *   open,         `asOf` > due_at                                → `overdue`
 *   otherwise no change.
 * Returns the SAME status when no transition applies (the cron only writes on change). `completed` and
 * `missed` are terminal and pass through unchanged.
 */
export function decideSfvWatchdogStatus(input: {
  readonly current: HopeSfvStatus;
  readonly dueAt: IsoInstant;
  readonly asOfInstant: IsoInstant;
  readonly timeZone: string;
}): HopeSfvStatus {
  if (input.current === "completed" || input.current === "missed") return input.current;
  const asOf = Date.parse(input.asOfInstant);
  const missedAt = Date.parse(
    endOfOrgDayInstant(
      addCalendarDays(orgLocalDate(input.dueAt, input.timeZone), SFV_MISSED_AFTER_DAYS),
      input.timeZone,
    ),
  );
  if (asOf > missedAt) return "missed";
  if (asOf > Date.parse(input.dueAt)) return "overdue";
  return input.current;
}
