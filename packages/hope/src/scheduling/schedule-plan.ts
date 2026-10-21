// @chartwarden/hope — the timepoint engine (M10-T03; §2, task #6 + #11, D9). PURE, IO-free: it turns an M6
// admission/discharge fact into the set of `hope_timepoint_schedule` row DESCRIPTORS the scheduling
// worker inserts. `planAdmissionTimepoints` materializes the three admission-anchored windows (Admission
// / HUV1 / HUV2) from `admission.activated`; `planDischargeTimepoint` materializes the single Discharge
// RFA window from `admission.discharged` (D9 — the Discharge row is created at discharge time, not at
// admission, because its `discharge_reason` branch cannot be known until discharge actually happens). The
// worker (M10-T06) maps these descriptors onto Drizzle inserts inside one tx; idempotency is enforced by
// the schema's `uniq_hope_sched_admission_rfa_open` partial index, so a re-emitted event is a no-op.
import type { HopeRfaKind, HopeScheduleGeneratedBy, LocalDate } from "@chartwarden/types";
import { DEFAULT_TIMEPOINT_ALERT_CADENCE, type TimepointAlertCadence } from "./alert-cadence";
import {
  type AdmissionAnchoredRfaKind,
  DEFAULT_LATE_GRACE_DAYS,
  type TimepointWindow,
  dischargeWindow,
  windowFor,
} from "./window-calculator";

/** One `hope_timepoint_schedule` row the worker should INSERT (the windows + provenance + cadence; the
 * who/where tenancy columns are joined from the admission by the worker, not decided here). */
export interface TimepointScheduleDescriptor {
  readonly rfaKind: HopeRfaKind;
  readonly generatedBy: HopeScheduleGeneratedBy;
  readonly window: TimepointWindow;
  readonly alertCadence: TimepointAlertCadence;
}

/** The §2 admission-anchored RFA kinds materialized on `admission.activated`, in CMS order. */
export const ADMISSION_TIMEPOINT_RFA_KINDS = [
  "01_admission",
  "02_huv1",
  "03_huv2",
] as const satisfies readonly AdmissionAnchoredRfaKind[];

/** Facts the scheduling worker injects from M6's `admission.activated` outbox event (D9 precedent: the
 * consumer carries the dep; M10 never imports M6 schema). */
export interface AdmissionTimepointFacts {
  /** The SOC / level-of-care anchor date (org-local `yyyy-mm-dd`) the CMS windows count from. */
  readonly anchorDate: LocalDate;
  /** Org timezone for the calendar-day → instant boundary math (D2). */
  readonly timeZone: string;
  /** Tenant late-deadline grace; default {@link DEFAULT_LATE_GRACE_DAYS}. */
  readonly graceDays?: number;
  /** Per-RFA tenant cadence override; default {@link DEFAULT_TIMEPOINT_ALERT_CADENCE}. */
  readonly alertCadence?: TimepointAlertCadence;
}

/**
 * §2 / task #6 — plan the three admission-anchored HOPE timepoint schedule rows (Admission, HUV1, HUV2)
 * for one activated admission. The Discharge RFA is intentionally NOT planned here (D9 — see
 * {@link planDischargeTimepoint}). Deterministic and re-runnable: the same facts always yield the same
 * three descriptors; the worker's unique partial index makes re-emit idempotent.
 */
export function planAdmissionTimepoints(
  facts: AdmissionTimepointFacts,
): readonly TimepointScheduleDescriptor[] {
  const grace = facts.graceDays ?? DEFAULT_LATE_GRACE_DAYS;
  const cadence = facts.alertCadence ?? DEFAULT_TIMEPOINT_ALERT_CADENCE;
  return ADMISSION_TIMEPOINT_RFA_KINDS.map((rfaKind) => ({
    rfaKind,
    generatedBy: "auto_admission" as const,
    window: windowFor(rfaKind, facts.anchorDate, facts.timeZone, grace),
    alertCadence: cadence,
  }));
}

/** Facts the Discharge RFA listener injects from M6's `admission.discharged` outbox event (D9). */
export interface DischargeTimepointFacts {
  /** The discharge date (org-local `yyyy-mm-dd`) the 7-day Discharge window counts from. */
  readonly dischargeDate: LocalDate;
  readonly timeZone: string;
  readonly graceDays?: number;
  readonly alertCadence?: TimepointAlertCadence;
}

/**
 * D9 / task #11 — plan the single Discharge RFA schedule row from `admission.discharged`. The
 * `discharge_reason` Section-Q branch is NOT applied here (it is a recording-boundary guard,
 * {@link assertSectionQForDischarge} in `timepoint-gate.ts`); this only materializes the 7-day window
 * (`generated_by='auto_discharge'`).
 */
export function planDischargeTimepoint(
  facts: DischargeTimepointFacts,
): TimepointScheduleDescriptor {
  return {
    rfaKind: "05_discharge",
    generatedBy: "auto_discharge",
    window: dischargeWindow(
      facts.dischargeDate,
      facts.timeZone,
      facts.graceDays ?? DEFAULT_LATE_GRACE_DAYS,
    ),
    alertCadence: facts.alertCadence ?? DEFAULT_TIMEPOINT_ALERT_CADENCE,
  };
}
