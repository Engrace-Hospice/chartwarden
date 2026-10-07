// apps/backend/src/modules/37-ipu/jobs/lifecycle-plans.ts — batch 11 (GAP-105 follow-up): the pure decisions
// behind the five §4.8 crons GAP-105 did not build — reservation-expiry-watchdog, equipment-inspection-
// watchdog, nursing-note-shift-watchdog, transfer-completion-watchdog and postclose-settlement-sweep. Same
// contract as `watchdog-plans.ts`: no IO and no clock reads (`nowMs` and every fact are injected), so each
// decision is unit-testable without Redis or a database, and the queue catalog is data kept out of the shared
// `jobs/index.ts`.
import {
  INSPECTION_DUE_WARN_DAYS,
  RESERVATION_HOLD_HOURS,
  isReservationExpired,
} from "@wardenx/inpatient";
import type { IpuAdmissionKind, IpuAdmissionState, IpuShiftRole } from "@wardenx/types";
import { WATCHDOG_REMINDER_WINDOW_MS, daysBetweenIsoDates, reminderCycle } from "./watchdog-plans";

// ── §4.8 queue catalog (no ':' in a BullMQ queue name) ───────────────────────────────────────────────────

export const M37_LIFECYCLE_QUEUES = {
  /** Every 15 minutes: releases bed reservations whose 4-hour hold lapsed (§2.12). */
  reservationExpiryWatchdog: "ipu.reservation-expiry-watchdog",
  /** Nightly: biomed inspection due at 14/7/2/0 days, overdue from +1 (§2.9, D10). */
  equipmentInspectionWatchdog: "ipu.equipment-inspection-watchdog",
  /** Every 15 minutes: shifts that ended 30 minutes ago with no q-shift nursing note (§5.14). */
  nursingNoteShiftWatchdog: "ipu.nursing-note-shift-watchdog",
  /** Hourly: `transferring` admissions unconfirmed after 1 hour (§2.2). */
  transferCompletionWatchdog: "ipu.transfer-completion-watchdog",
  /** Daily: settled admissions older than T+7 close (§2.2 `postCloseSettlement`). */
  postCloseSettlementSweep: "ipu.post-close-settlement-sweep",
} as const;

export const M37_LIFECYCLE_SCHEDULES = {
  reservationExpiryWatchdog: "*/15 * * * *",
  equipmentInspectionWatchdog: "30 8 * * *",
  nursingNoteShiftWatchdog: "*/15 * * * *",
  transferCompletionWatchdog: "5 * * * *",
  postCloseSettlementSweep: "45 8 * * *",
} as const;

export const M37_LIFECYCLE_QUEUE_PARAMS = {
  reservationExpiryWatchdog: {
    priority: 2,
    attempts: 3,
    backoff: "exponential 60s",
    concurrency: 1,
  },
  equipmentInspectionWatchdog: {
    priority: 3,
    attempts: 3,
    backoff: "exponential 120s",
    concurrency: 1,
  },
  nursingNoteShiftWatchdog: {
    priority: 2,
    attempts: 3,
    backoff: "exponential 60s",
    concurrency: 1,
  },
  transferCompletionWatchdog: {
    priority: 2,
    attempts: 3,
    backoff: "exponential 60s",
    concurrency: 1,
  },
  postCloseSettlementSweep: {
    priority: 3,
    attempts: 3,
    backoff: "exponential 120s",
    concurrency: 1,
  },
} as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ── reservation expiry (§2.12) ───────────────────────────────────────────────────────────────────────────

export interface ReservedBedFact {
  readonly bedId: string;
  readonly unitId: string;
  /** When the bed entered `reserved` (`cleaning_status_changed_at`). */
  readonly reservedAtMs: number;
  /** The bed's live `ipu_bed_assignment` and the admission it belongs to, if any. */
  readonly assignment: {
    readonly assignmentId: string;
    readonly ipuAdmissionId: string;
    readonly admissionKind: IpuAdmissionKind;
    readonly admissionState: IpuAdmissionState;
  } | null;
}

export interface ReservationReleasePlan {
  readonly bedId: string;
  readonly unitId: string;
  readonly reservedAtMs: number;
  /** The live assignment to end, and the admission to step back to `bed_pending`. Null: an orphan hold. */
  readonly assignmentId: string | null;
  readonly ipuAdmissionId: string | null;
  readonly admissionKind: IpuAdmissionKind | null;
}

/**
 * §2.12 — the reservations this tick releases. A hold is released when it is older than 4 hours AND the
 * admission it was made for is still waiting in `bed_assigned` (or there is no live assignment at all — an
 * orphaned hold nothing will ever consume). A reserved bed whose live assignment belongs to an admission in
 * ANY OTHER state is an inconsistency this cron must not "fix" by freeing a bed a patient may occupy: it is
 * skipped and left for a person.
 */
export function planReservationExpiry(
  beds: readonly ReservedBedFact[],
  nowMs: number,
): ReservationReleasePlan[] {
  const plans: ReservationReleasePlan[] = [];
  for (const b of beds) {
    if (!isReservationExpired("reserved", b.reservedAtMs, nowMs, RESERVATION_HOLD_HOURS)) continue;
    if (b.assignment && b.assignment.admissionState !== "bed_assigned") continue;
    plans.push({
      bedId: b.bedId,
      unitId: b.unitId,
      reservedAtMs: b.reservedAtMs,
      assignmentId: b.assignment?.assignmentId ?? null,
      ipuAdmissionId: b.assignment?.ipuAdmissionId ?? null,
      admissionKind: b.assignment?.admissionKind ?? null,
    });
  }
  return plans;
}

// ── equipment inspection (§2.9, D10) ─────────────────────────────────────────────────────────────────────

/**
 * Spec §2.9 raises `inspection_overdue` "at +1 day overdue". An equipment item whose inspection nobody records
 * stays a block-severity hazard (it cannot be assigned to a patient), and one alert followed by silence would
 * hide it; the conservative reading re-raises it weekly (+1, +8, +15 ...).
 */
export const INSPECTION_OVERDUE_REPEAT_DAYS = 7;

export interface EquipmentInspectionFact {
  readonly equipmentId: string;
  /** `next_inspection_due_date` (an ISO date). */
  readonly dueDate: string;
}

export type EquipmentInspectionPlan =
  | {
      readonly kind: "due";
      readonly equipmentId: string;
      readonly dueDate: string;
      readonly daysUntilDue: number;
    }
  | {
      readonly kind: "overdue";
      readonly equipmentId: string;
      readonly dueDate: string;
      readonly daysOverdue: number;
    };

/** True when `daysUntil` (due − today, tenant-local) lands on an alert day. */
export function inspectionAlertKind(daysUntil: number): "due" | "overdue" | null {
  if (INSPECTION_DUE_WARN_DAYS.includes(daysUntil)) return "due";
  const overdue = -daysUntil;
  if (overdue >= 1 && (overdue - 1) % INSPECTION_OVERDUE_REPEAT_DAYS === 0) return "overdue";
  return null;
}

/** §2.9 — which equipment items owe an alert on tenant-local `todayLocalDate`. Day-exact, so a re-run is a no-op. */
export function planEquipmentInspection(
  items: readonly EquipmentInspectionFact[],
  todayLocalDate: string,
): EquipmentInspectionPlan[] {
  const plans: EquipmentInspectionPlan[] = [];
  for (const item of items) {
    const daysUntil = daysBetweenIsoDates(todayLocalDate, item.dueDate);
    const kind = inspectionAlertKind(daysUntil);
    if (kind === "due") {
      plans.push({
        kind,
        equipmentId: item.equipmentId,
        dueDate: item.dueDate,
        daysUntilDue: daysUntil,
      });
    } else if (kind === "overdue") {
      plans.push({
        kind,
        equipmentId: item.equipmentId,
        dueDate: item.dueDate,
        daysOverdue: -daysUntil,
      });
    }
  }
  return plans;
}

// ── nursing-note shift coverage (§5.14) ──────────────────────────────────────────────────────────────────

/** §5.14 — the cron fires "end of each shift + 30 min grace". */
export const NURSING_NOTE_GRACE_MS = 30 * MINUTE_MS;

/** RN-equivalent roles (`@wardenx/inpatient` `RN_EQUIVALENT_ROLES`) — the nurses a q-shift note is owed by. */
export const NURSING_NOTE_ROLES: readonly IpuShiftRole[] = ["rn", "charge_rn", "np_in_rn_role"];

export interface EndedShiftFact {
  readonly shiftId: string;
  readonly unitId: string;
  readonly shiftStartMs: number;
  readonly shiftEndMs: number;
  /** Memberships with a confirmed/completed RN-equivalent assignment on the shift. */
  readonly rnMembershipIds: readonly string[];
}

export interface UnitAdmissionFact {
  readonly ipuAdmissionId: string;
  readonly patientId: string;
  readonly unitId: string;
  readonly activatedAtMs: number;
}

export interface NursingNoteCandidate {
  readonly shiftId: string;
  readonly unitId: string;
  readonly shiftStartMs: number;
  readonly shiftEndMs: number;
  readonly rnMembershipIds: readonly string[];
  readonly ipuAdmissionId: string;
  readonly patientId: string;
}

export interface SignedNoteFact {
  readonly signedAtMs: number;
  readonly signedByMembershipId: string;
}

/**
 * §5.14 — the (patient × shift) pairs whose note is due to be checked THIS tick: the shift's grace period
 * ended no more than one nag window ago (the tick is stateless — the correlation key `shiftId:admission`
 * collapses the two ticks a window can catch), the shift had an RN to write the note, and the patient was
 * already in the unit when the shift began (a patient admitted mid-shift is not flagged: conservative).
 */
export function nursingNoteCandidates(
  shifts: readonly EndedShiftFact[],
  admissions: readonly UnitAdmissionFact[],
  nowMs: number,
): NursingNoteCandidate[] {
  const out: NursingNoteCandidate[] = [];
  for (const shift of shifts) {
    if (shift.rnMembershipIds.length === 0) continue; // an uncovered shift is rn_uncovered's alert, not this
    const dueAtMs = shift.shiftEndMs + NURSING_NOTE_GRACE_MS;
    const sinceDue = nowMs - dueAtMs;
    if (sinceDue < 0 || sinceDue >= WATCHDOG_REMINDER_WINDOW_MS) continue;
    for (const a of admissions) {
      if (a.unitId !== shift.unitId || a.activatedAtMs > shift.shiftStartMs) continue;
      out.push({
        shiftId: shift.shiftId,
        unitId: shift.unitId,
        shiftStartMs: shift.shiftStartMs,
        shiftEndMs: shift.shiftEndMs,
        rnMembershipIds: shift.rnMembershipIds,
        ipuAdmissionId: a.ipuAdmissionId,
        patientId: a.patientId,
      });
    }
  }
  return out;
}

/**
 * §5.14 — a pair is overdue when no encounter signed by one of the shift's assigned RNs landed in
 * `[shift_start, shift_end + 30 min]`.
 */
export function planNursingNoteOverdue(
  candidates: readonly NursingNoteCandidate[],
  notesByPatient: ReadonlyMap<string, readonly SignedNoteFact[]>,
): NursingNoteCandidate[] {
  return candidates.filter((c) => {
    const notes = notesByPatient.get(c.patientId) ?? [];
    const windowEnd = c.shiftEndMs + NURSING_NOTE_GRACE_MS;
    return !notes.some(
      (n) =>
        n.signedAtMs >= c.shiftStartMs &&
        n.signedAtMs <= windowEnd &&
        c.rnMembershipIds.includes(n.signedByMembershipId),
    );
  });
}

// ── transfer completion (§2.2) ───────────────────────────────────────────────────────────────────────────

/** §2.2 — "cron `transfer-completion-watchdog` runs at +1h to flag unconfirmed transfers". */
export const TRANSFER_CONFIRM_WINDOW_MS = HOUR_MS;
/** An unconfirmed transfer is re-raised every 6 hours (the patient is in limbo between two sites). */
export const TRANSFER_REMINDER_REPEAT_MS = 6 * HOUR_MS;
/** Wide enough that an hourly tick cannot miss a cycle (the cron period is 60 minutes). */
export const TRANSFER_REMINDER_WINDOW_MS = 70 * MINUTE_MS;

export interface TransferringFact {
  readonly ipuAdmissionId: string;
  readonly initiatedAtMs: number;
}

export interface TransferUnconfirmedPlan {
  readonly ipuAdmissionId: string;
  readonly initiatedAtMs: number;
  readonly cycle: number;
}

export function planTransferCompletion(
  transfers: readonly TransferringFact[],
  nowMs: number,
): TransferUnconfirmedPlan[] {
  const plans: TransferUnconfirmedPlan[] = [];
  for (const t of transfers) {
    const cycle = reminderCycle(
      t.initiatedAtMs + TRANSFER_CONFIRM_WINDOW_MS,
      nowMs,
      TRANSFER_REMINDER_REPEAT_MS,
      TRANSFER_REMINDER_WINDOW_MS,
    );
    if (cycle === null) continue;
    plans.push({ ipuAdmissionId: t.ipuAdmissionId, initiatedAtMs: t.initiatedAtMs, cycle });
  }
  return plans;
}

// ── post-close settlement (§2.2) ─────────────────────────────────────────────────────────────────────────

/** §2.2 — the T+7 reconciliation window between a stay ending and its closure. */
export const POST_CLOSE_SETTLEMENT_DAYS = 7;

export interface SettledAdmissionFact {
  readonly ipuAdmissionId: string;
  readonly kind: IpuAdmissionKind;
  readonly state: Extract<IpuAdmissionState, "discharged" | "transferred" | "deceased">;
  /** The instant the T+7 clock starts: the terminal state entry (a death: or the body release closing, if later). */
  readonly settledAtMs: number;
  readonly openIrcEpisodes: number;
  readonly activeRestraints: number;
  /** A death's `ipu_body_release` not yet `closed` (always false for a non-death stay). */
  readonly bodyReleaseOpen: boolean;
}

/** §2.2 — admissions past T+7 with no open child row. */
export function planPostCloseSettlement(
  admissions: readonly SettledAdmissionFact[],
  nowMs: number,
): SettledAdmissionFact[] {
  return admissions.filter(
    (a) =>
      nowMs - a.settledAtMs >= POST_CLOSE_SETTLEMENT_DAYS * DAY_MS &&
      a.openIrcEpisodes === 0 &&
      a.activeRestraints === 0 &&
      !a.bodyReleaseOpen,
  );
}
