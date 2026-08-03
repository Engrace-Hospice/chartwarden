// @wardenx/inpatient — M37-T08, §2.9 D10. The biomed-inspection due-date calculator + the
// inspection-current gate. An overdue inspection makes the equipment fail the ABAC
// `m37.equipment.inspection_current`, and the assign-to-patient route returns 412 EQUIPMENT_INSPECTION_OVERDUE.
// Pure & IO-free — the caller injects `asOfMs` (no ambient clock).
import type { IpuEquipmentInspectionKind } from "@wardenx/types";
import { IpuStateError, requireIpu } from "../../errors";

const DAY_MS = 86_400_000;

/** §2.9 — the next-due interval (days) for the interval-based inspection kinds. */
export const INSPECTION_INTERVAL_DAYS = { annual_biomed: 365, per_use_safety: 30 } as const;
/** §2.9 — the equipment-inspection-watchdog warn thresholds (days before due). */
export const INSPECTION_DUE_WARN_DAYS: readonly number[] = [14, 7, 2, 0];

/**
 * §2.9 — compute an inspection's `next_inspection_due_date` (ms). annual_biomed = +365d, per_use_safety =
 * +30d; post_repair_safety and recall_response do NOT reset the annual clock — they keep the equipment's
 * existing annual due date (passed as `currentAnnualDueMs`, falling back to +365d if unknown).
 */
export function computeNextInspectionDue(
  inspectionKind: IpuEquipmentInspectionKind,
  inspectedAtMs: number,
  currentAnnualDueMs?: number,
): number {
  switch (inspectionKind) {
    case "annual_biomed":
      return inspectedAtMs + INSPECTION_INTERVAL_DAYS.annual_biomed * DAY_MS;
    case "per_use_safety":
      return inspectedAtMs + INSPECTION_INTERVAL_DAYS.per_use_safety * DAY_MS;
    case "post_repair_safety":
    case "recall_response":
      return currentAnnualDueMs ?? inspectedAtMs + INSPECTION_INTERVAL_DAYS.annual_biomed * DAY_MS;
  }
}

/** §2.9 — whole days until the inspection is due (negative once overdue). */
export function daysUntilDue(nextDueMs: number, asOfMs: number): number {
  return Math.floor((nextDueMs - asOfMs) / DAY_MS);
}

/** §2.9 — is the equipment's biomed inspection current (not past due)? The `m37.equipment.inspection_current` reading. */
export function isInspectionCurrent(nextDueMs: number, asOfMs: number): boolean {
  return asOfMs <= nextDueMs;
}

/**
 * §2.9 — guard the assign-equipment-to-patient path. Throws {@link IpuStateError} `EQUIPMENT_INSPECTION_OVERDUE`
 * (412) when the equipment's biomed inspection is past due.
 */
export function assertInspectionCurrent(nextDueMs: number, asOfMs: number): void {
  requireIpu(
    isInspectionCurrent(nextDueMs, asOfMs),
    "EQUIPMENT_INSPECTION_OVERDUE",
    "The equipment's biomed inspection is overdue; it cannot be assigned to a patient until re-inspected.",
  );
}

/** §2.9 — which warn threshold (14/7/2/0) does today's days-until-due hit, if any (for the watchdog alert)? */
export function inspectionWarnThreshold(nextDueMs: number, asOfMs: number): number | null {
  const days = daysUntilDue(nextDueMs, asOfMs);
  return INSPECTION_DUE_WARN_DAYS.includes(days) ? days : null;
}
