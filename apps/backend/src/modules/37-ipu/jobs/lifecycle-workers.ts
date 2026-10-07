// apps/backend/src/modules/37-ipu/jobs/lifecycle-workers.ts — batch 11 (GAP-105 follow-up): the five §4.8 crons
// GAP-105 did not build — reservation-expiry-watchdog, equipment-inspection-watchdog, nursing-note-shift-
// watchdog, transfer-completion-watchdog and postclose-settlement-sweep. Each is a plain async function over
// the same dep bag and the same per-org envelope as `watchdog-workers.ts` (`forEachOrg`: one `withOrgContext`
// tx per org, empty-string system actor so the PHI audit trigger's actor FK reads NULL, one org's failure
// collected and rethrown after the rest ran), 2000-row cap per org per tick, events through the transactional
// outbox in the SAME tx as the write they announce, stateless nag windows keyed by deterministic cycle ids.
import { organizationTimezone } from "@wardenx/db";
import { transitionAdmission } from "@wardenx/inpatient";
import { localDateInTimeZone } from "@wardenx/shared/dates";
import {
  M37_LIFECYCLE_QUEUES,
  M37_LIFECYCLE_QUEUE_PARAMS,
  M37_LIFECYCLE_SCHEDULES,
  NURSING_NOTE_GRACE_MS,
  type NursingNoteCandidate,
  type SignedNoteFact,
  TRANSFER_CONFIRM_WINDOW_MS,
  nursingNoteCandidates,
  planEquipmentInspection,
  planNursingNoteOverdue,
  planPostCloseSettlement,
  planReservationExpiry,
  planTransferCompletion,
} from "./lifecycle-plans";
import {
  closeSettledAdmission,
  endedShiftsWithRns,
  equipmentOnAlertDays,
  expiredReservedBeds,
  occupyingUnitAdmissions,
  releaseReservation,
  settledAdmissions,
  unconfirmedTransfers,
} from "./lifecycle-store";
import { WATCHDOG_REMINDER_WINDOW_MS } from "./watchdog-plans";
import {
  type M37WatchdogJob,
  type M37WorkerDeps,
  M37_WATCHDOG_ROW_LIMIT,
  forEachOrg,
  nowOf,
} from "./watchdog-workers";

// ── reservation-expiry-watchdog (§2.12) ──────────────────────────────────────────────────────────────────

/**
 * Release every bed reservation older than 4 hours: the bed returns to `ready`, the assignment ends and the
 * admission waiting on it steps back to `bed_pending` so a coordinator can place it again. Announces
 * `m37.bed.reservation_expired` once per released hold — the release itself is the idempotency (a re-run finds
 * the bed `ready`), and the event is published only by the call that wrote it.
 */
export async function runReservationExpiryWatchdogCron(deps: M37WorkerDeps): Promise<void> {
  const nowMs = nowOf(deps).getTime();
  await forEachOrg(deps, "M37_RESERVATION_EXPIRY_WATCHDOG", async (tx, organizationId) => {
    const beds = await expiredReservedBeds(tx, organizationId, nowMs, M37_WATCHDOG_ROW_LIMIT);
    for (const plan of planReservationExpiry(beds, nowMs)) {
      if (plan.ipuAdmissionId && plan.admissionKind) {
        // The machine owns the legality of `bed_assigned → bed_pending` (and refuses a non-system actor).
        transitionAdmission("bed_assigned", plan.admissionKind, {
          type: "expireReservation",
          isSystemActor: true,
        });
      }
      if (!(await releaseReservation(tx, organizationId, plan, nowMs))) continue;
      await deps.outbox.publish(tx, {
        eventName: "m37.bed.reservation_expired",
        payload: {
          bedId: plan.bedId,
          organizationId,
          unitId: plan.unitId,
          ...(plan.ipuAdmissionId ? { ipuAdmissionId: plan.ipuAdmissionId } : {}),
          reservedAt: new Date(plan.reservedAtMs).toISOString(),
        },
        organizationId,
        aggregateKind: "ipu_bed",
        aggregateId: plan.bedId,
      });
    }
  });
}

// ── equipment-inspection-watchdog (§2.9 D10) ─────────────────────────────────────────────────────────────

/**
 * Raise `m37.equipment.inspection_due` at 14/7/2/0 days before an item's inspection due date and
 * `m37.equipment.inspection_overdue` from +1 day (re-raised weekly). Day-exact on the tenant-local date, so a
 * re-run on the same day publishes the same keyed alerts (M36's correlation id dedupes) and no day is double
 * counted. The assign-to-patient block itself is the `m37.equipment.inspection_current` gate, which reads the
 * due date directly — nothing here has to flip a flag for the block to hold.
 */
export async function runEquipmentInspectionWatchdogCron(deps: M37WorkerDeps): Promise<void> {
  const now = nowOf(deps);
  await forEachOrg(deps, "M37_EQUIPMENT_INSPECTION_WATCHDOG", async (tx, organizationId) => {
    const timezone = await organizationTimezone(tx, organizationId);
    const today = localDateInTimeZone(now, timezone);
    const items = await equipmentOnAlertDays(tx, organizationId, today, M37_WATCHDOG_ROW_LIMIT);
    for (const plan of planEquipmentInspection(items, today)) {
      await deps.outbox.publish(tx, {
        eventName:
          plan.kind === "due" ? "m37.equipment.inspection_due" : "m37.equipment.inspection_overdue",
        payload:
          plan.kind === "due"
            ? {
                equipmentId: plan.equipmentId,
                organizationId,
                daysUntilDue: plan.daysUntilDue,
                dueDate: plan.dueDate,
              }
            : {
                equipmentId: plan.equipmentId,
                organizationId,
                dueDate: plan.dueDate,
                daysOverdue: plan.daysOverdue,
              },
        organizationId,
        aggregateKind: "ipu_equipment",
        aggregateId: plan.equipmentId,
      });
    }
  });
}

// ── nursing-note-shift-watchdog (§5.14) ──────────────────────────────────────────────────────────────────

/**
 * For each shift whose end + 30-minute grace passed within the last nag window, every GIP/IRC patient in the
 * unit since before the shift began must have a q-shift nursing note: an encounter signed by one of the
 * shift's assigned RNs inside `[shift_start, shift_end + 30 min]`. M8 is read ONLY through its org-explicit
 * `signedEncountersForPatientSince` seam (one call per patient, from the earliest shift start in play) — an
 * unbound seam fails the tick loudly rather than reading "no notes" and paging for every patient.
 */
export async function runNursingNoteShiftWatchdogCron(deps: M37WorkerDeps): Promise<void> {
  const nowMs = nowOf(deps).getTime();
  const reader = deps.signedEncounters;
  if (!reader) {
    throw new Error(
      "M37_WORKER_PORT_UNBOUND: signedEncounters — the nursing-note shift watchdog needs M8's SignedEncountersReader",
    );
  }
  await forEachOrg(deps, "M37_NURSING_NOTE_SHIFT_WATCHDOG", async (tx, organizationId) => {
    const dueEndTo = nowMs - NURSING_NOTE_GRACE_MS;
    const shifts = await endedShiftsWithRns(
      tx,
      organizationId,
      dueEndTo - WATCHDOG_REMINDER_WINDOW_MS,
      dueEndTo,
      M37_WATCHDOG_ROW_LIMIT,
    );
    const admissions = await occupyingUnitAdmissions(
      tx,
      organizationId,
      [...new Set(shifts.map((s) => s.unitId))],
      M37_WATCHDOG_ROW_LIMIT,
    );
    const candidates = nursingNoteCandidates(shifts, admissions, nowMs).slice(
      0,
      M37_WATCHDOG_ROW_LIMIT,
    );
    const notes = await signedNotesFor(reader, organizationId, candidates);
    for (const overdue of planNursingNoteOverdue(candidates, notes)) {
      await deps.outbox.publish(tx, {
        eventName: "m37.nursing_note.shift_overdue",
        payload: {
          ipuAdmissionId: overdue.ipuAdmissionId,
          organizationId,
          shiftId: overdue.shiftId,
          unitId: overdue.unitId,
          shiftEndAt: new Date(overdue.shiftEndMs).toISOString(),
        },
        organizationId,
        aggregateKind: "ipu_admission",
        aggregateId: overdue.ipuAdmissionId,
      });
    }
  });
}

async function signedNotesFor(
  reader: NonNullable<M37WorkerDeps["signedEncounters"]>,
  organizationId: string,
  candidates: readonly NursingNoteCandidate[],
): Promise<Map<string, readonly SignedNoteFact[]>> {
  const earliestStart = new Map<string, number>();
  for (const c of candidates) {
    const prior = earliestStart.get(c.patientId);
    if (prior === undefined || c.shiftStartMs < prior)
      earliestStart.set(c.patientId, c.shiftStartMs);
  }
  const out = new Map<string, readonly SignedNoteFact[]>();
  for (const [patientId, startMs] of earliestStart) {
    const digests = await reader.signedEncountersForPatientSince(
      organizationId,
      patientId,
      new Date(startMs).toISOString(),
    );
    out.set(
      patientId,
      digests.map((d) => ({
        signedAtMs: new Date(d.signedAt).getTime(),
        signedByMembershipId: d.signedByMembershipId,
      })),
    );
  }
  return out;
}

// ── transfer-completion-watchdog (§2.2) ──────────────────────────────────────────────────────────────────

/** Raise `m37.ipu_admission.transfer_unconfirmed` for each `transferring` admission past 1 hour, once per 6-hour cycle. */
export async function runTransferCompletionWatchdogCron(deps: M37WorkerDeps): Promise<void> {
  const nowMs = nowOf(deps).getTime();
  await forEachOrg(deps, "M37_TRANSFER_COMPLETION_WATCHDOG", async (tx, organizationId) => {
    const transfers = await unconfirmedTransfers(
      tx,
      organizationId,
      nowMs,
      TRANSFER_CONFIRM_WINDOW_MS,
      M37_WATCHDOG_ROW_LIMIT,
    );
    for (const due of planTransferCompletion(transfers, nowMs)) {
      await deps.outbox.publish(tx, {
        eventName: "m37.ipu_admission.transfer_unconfirmed",
        payload: {
          ipuAdmissionId: due.ipuAdmissionId,
          organizationId,
          initiatedAt: new Date(due.initiatedAtMs).toISOString(),
          reminderCycle: due.cycle,
        },
        organizationId,
        aggregateKind: "ipu_admission",
        aggregateId: due.ipuAdmissionId,
      });
    }
  });
}

// ── postclose-settlement-sweep (§2.2) ────────────────────────────────────────────────────────────────────

/**
 * Close `discharged | transferred | deceased` admissions at T+7 once every child row is settled (§2.2
 * `postCloseSettlement`), through the admission machine with the typed system actor; publishes
 * `m37.ipu_admission.closed` in the same tx. A re-run finds the admission `closed` and skips it.
 */
export async function runPostCloseSettlementSweepCron(deps: M37WorkerDeps): Promise<void> {
  const nowMs = nowOf(deps).getTime();
  await forEachOrg(deps, "M37_POST_CLOSE_SETTLEMENT_SWEEP", async (tx, organizationId) => {
    const settled = await settledAdmissions(tx, organizationId, nowMs, M37_WATCHDOG_ROW_LIMIT);
    for (const fact of planPostCloseSettlement(settled, nowMs)) {
      transitionAdmission(fact.state, fact.kind, {
        type: "postCloseSettlement",
        isSystemActor: true,
        noOpenChildRows: true,
      });
      if (!(await closeSettledAdmission(tx, organizationId, fact, nowMs))) continue;
      await deps.outbox.publish(tx, {
        eventName: "m37.ipu_admission.closed",
        payload: { ipuAdmissionId: fact.ipuAdmissionId, organizationId },
        organizationId,
        aggregateKind: "ipu_admission",
        aggregateId: fact.ipuAdmissionId,
      });
    }
  });
}

// ── the job table (read by `cron-workers.ts`, which owns the BullMQ construction) ────────────────────────

export const M37_LIFECYCLE_JOBS: readonly M37WatchdogJob[] = [
  {
    queue: M37_LIFECYCLE_QUEUES.reservationExpiryWatchdog,
    schedule: M37_LIFECYCLE_SCHEDULES.reservationExpiryWatchdog,
    params: M37_LIFECYCLE_QUEUE_PARAMS.reservationExpiryWatchdog,
    run: runReservationExpiryWatchdogCron,
  },
  {
    queue: M37_LIFECYCLE_QUEUES.equipmentInspectionWatchdog,
    schedule: M37_LIFECYCLE_SCHEDULES.equipmentInspectionWatchdog,
    params: M37_LIFECYCLE_QUEUE_PARAMS.equipmentInspectionWatchdog,
    run: runEquipmentInspectionWatchdogCron,
  },
  {
    queue: M37_LIFECYCLE_QUEUES.nursingNoteShiftWatchdog,
    schedule: M37_LIFECYCLE_SCHEDULES.nursingNoteShiftWatchdog,
    params: M37_LIFECYCLE_QUEUE_PARAMS.nursingNoteShiftWatchdog,
    run: runNursingNoteShiftWatchdogCron,
  },
  {
    queue: M37_LIFECYCLE_QUEUES.transferCompletionWatchdog,
    schedule: M37_LIFECYCLE_SCHEDULES.transferCompletionWatchdog,
    params: M37_LIFECYCLE_QUEUE_PARAMS.transferCompletionWatchdog,
    run: runTransferCompletionWatchdogCron,
  },
  {
    queue: M37_LIFECYCLE_QUEUES.postCloseSettlementSweep,
    schedule: M37_LIFECYCLE_SCHEDULES.postCloseSettlementSweep,
    params: M37_LIFECYCLE_QUEUE_PARAMS.postCloseSettlementSweep,
    run: runPostCloseSettlementSweepCron,
  },
];
