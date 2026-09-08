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

/** ADR-0018 D1 — calendar days from the triggering assessment's VISIT/ASSESSMENT date within which
 * the SFV is due. CMS regulatory floor; not tenant-configurable; org-TZ-aware. The clock anchors to
 * the assessment date, NEVER the signature timestamp — anchoring to `signed_at` let delayed signing
 * extend the federal deadline (silently under-reporting HQRP non-compliance). */
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
  /** The triggering assessment's VISIT/ASSESSMENT date (`target_date`) — the ADR-0018 D1 anchor for
   * `due_at`. Never `signed_at`: a late signature must not extend the 2-calendar-day window. */
  readonly assessmentDate: IsoInstant;
  /** The triggering assessment's `signed_at` — when the J2051 trigger actually fired (`triggered_at`);
   * the SFV row cannot exist before the clinical signature, but the DEADLINE never moves with it. */
  readonly signedAt: IsoInstant;
  readonly timeZone: string;
  readonly alertCadence?: SfvAlertCadence;
}

/**
 * ADR-0018 D1 / D4 — plan the single SFV for a triggering assessment. `due_at` is the END of the
 * org-local day `assessment date + 2 calendar days` (the "within 2 calendar days" CMS floor).
 * Deterministic; the caller inserts exactly one row (the unique index enforces one-per-source).
 */
export function planSfvCreation(facts: SfvCreationFacts): SfvDescriptor {
  const dueDate = addCalendarDays(
    orgLocalDate(facts.assessmentDate, facts.timeZone),
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
 *   - SFV must not already be `completed`/`withdrawn` → 409
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
  require_(
    target.status !== "withdrawn",
    "M10_SFV_WITHDRAWN",
    `Symptom-follow-up-visit ${target.id} was withdrawn because the J2051 trigger no longer applies.`,
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
 * Returns the SAME status when no transition applies (the cron only writes on change). `completed`,
 * `withdrawn`, and `missed` are terminal and pass through unchanged.
 */
export function decideSfvWatchdogStatus(input: {
  readonly current: HopeSfvStatus;
  readonly dueAt: IsoInstant;
  readonly asOfInstant: IsoInstant;
  readonly timeZone: string;
}): HopeSfvStatus {
  if (input.current === "completed" || input.current === "withdrawn" || input.current === "missed")
    return input.current;
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
