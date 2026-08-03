// @wardenx/inpatient — M37-T03, §2.12 D13. The pure `ipu_bed.cleaning_status` turnover state machine plus
// the turnover-SLA and reservation-hold clocks. IO-free and deterministic: the service/route layer
// (M37-T11) loads the bed under RLS, checks the `If-Match` version, calls `transitionBedCleaning`, then
// writes the returned `ipu_bed_cleaning_event` row + the new status + any outbox in one tx. Per-event facts
// (elapsed time, actor) are resolved upstream and injected as plain data.
//
// The §2.12 mermaid graph:
//   [*] ─bedCreated──────→ ready           (room creation seeds the bed at `ready`)
//   ready ─reserve───────→ reserved        (an incoming admission is bed_assigned)
//   reserved ─occupy─────→ occupied        (the admission goes active)
//   reserved ─expireReservation→ ready     (the 4h reservation lapsed; reservation-expiry-watchdog)
//   occupied ─dischargeDirty→ discharged_dirty  (admission discharged/transferred/deceased+body released)
//   discharged_dirty ─startCleaning→ cleaning    (housekeeping check-in)
//   cleaning ─completeCleaning→ ready       (housekeeping check-out)
//   ready ─retire────────→ retired          (Org Admin) ; retired is terminal
import type { IpuBedCleaningStatus } from "@wardenx/types";
import { IpuStateError, requireIpu } from "../errors";

/** The bed a room seeds at (§2.12 initial state). */
export const INITIAL_BED_CLEANING_STATUS: IpuBedCleaningStatus = "ready";

/** §2.12 platform-floor turnover SLA (minutes from `discharged_dirty` to `ready`); tenants tighten-only. */
export const TURNOVER_SLA_FLOOR_MINUTES = 120;
/** §2.12 — the lowest a tenant may tighten the turnover SLA to (1 hour). */
export const TURNOVER_SLA_MIN_MINUTES = 60;
/** §2.12 — a `reserved` bed holds the reservation this many hours before the expiry watchdog releases it. */
export const RESERVATION_HOLD_HOURS = 4;

/** A §2.12 bed-cleaning transition event. */
export type BedCleaningEvent =
  | "reserve"
  | "occupy"
  | "dischargeDirty"
  | "startCleaning"
  | "completeCleaning"
  | "retire"
  | "expireReservation";

/** The legal §2.12 transition graph (from → events accepted). `retired` is terminal. */
export const BED_CLEANING_GRAPH: Readonly<Record<IpuBedCleaningStatus, readonly BedCleaningEvent[]>> = {
  ready: ["reserve", "retire"],
  reserved: ["occupy", "expireReservation"],
  occupied: ["dischargeDirty"],
  discharged_dirty: ["startCleaning"],
  cleaning: ["completeCleaning"],
  retired: [],
};

/** The target status each event lands on. */
const BED_CLEANING_TARGET: Readonly<Record<BedCleaningEvent, IpuBedCleaningStatus>> = {
  reserve: "reserved",
  occupy: "occupied",
  dischargeDirty: "discharged_dirty",
  startCleaning: "cleaning",
  completeCleaning: "ready",
  retire: "retired",
  expireReservation: "ready",
};

/** The deterministic result of a bed-cleaning transition — the new status + the `ipu_bed_cleaning_event` row. */
export interface BedCleaningTransition {
  readonly from: IpuBedCleaningStatus;
  readonly to: IpuBedCleaningStatus;
  readonly event: BedCleaningEvent;
  /** Whether this transition completed a turnover (`discharged_dirty → … → ready`), for the census counter. */
  readonly completesTurnover: boolean;
}

/**
 * Apply a §2.12 bed-cleaning event. Throws {@link IpuStateError} `ILLEGAL_BED_CLEANING_TRANSITION` when the
 * event is not accepted from `from` (the D13 graph; `retired` is terminal, and a stale `If-Match` race where
 * two housekeepers collide surfaces here after the first writer wins). Returns the new status + the event to
 * persist as an `ipu_bed_cleaning_event` row.
 */
export function transitionBedCleaning(
  from: IpuBedCleaningStatus,
  event: BedCleaningEvent,
): BedCleaningTransition {
  if (!BED_CLEANING_GRAPH[from].includes(event)) {
    throw new IpuStateError(
      "ILLEGAL_BED_CLEANING_TRANSITION",
      `ipu_bed cannot ${event} from '${from}' (§2.12 graph; 'retired' is terminal).`,
    );
  }
  return {
    from,
    to: BED_CLEANING_TARGET[event],
    event,
    completesTurnover: event === "completeCleaning",
  };
}

/**
 * §2.12 — normalize a tenant's configured turnover-SLA minutes. The platform floor is 2 hours; tenants may
 * tighten to as little as 1 hour but never loosen above the floor. Throws `TURNOVER_SLA_NOT_TIGHTENING` on a
 * loosening attempt (the migration CHECK `turnover_sla_minutes <= 120` is the schema backstop).
 */
export function normalizeTurnoverSlaMinutes(configuredMinutes: number): number {
  requireIpu(
    configuredMinutes <= TURNOVER_SLA_FLOOR_MINUTES,
    "TURNOVER_SLA_NOT_TIGHTENING",
    `A turnover SLA may not loosen above the ${TURNOVER_SLA_FLOOR_MINUTES}-minute platform floor.`,
  );
  return Math.max(TURNOVER_SLA_MIN_MINUTES, configuredMinutes);
}

/**
 * §2.12 — has a bed exceeded its turnover SLA without reaching `ready`? The `bed-cleaning-sla-watchdog` cron
 * calls this every 15 minutes for beds in `discharged_dirty`/`cleaning`. A bed already at `ready`/`reserved`/
 * `occupied`/`retired` is never overdue.
 */
export function isTurnoverOverdue(
  status: IpuBedCleaningStatus,
  dischargedDirtyAtMs: number,
  nowMs: number,
  slaMinutes: number,
): boolean {
  if (status !== "discharged_dirty" && status !== "cleaning") return false;
  return nowMs - dischargedDirtyAtMs > slaMinutes * 60_000;
}

/**
 * §2.12 — has a `reserved` bed's 4-hour hold lapsed? The `reservation-expiry-watchdog` releases such beds
 * back to `ready`. Only meaningful for a bed in `reserved`.
 */
export function isReservationExpired(
  status: IpuBedCleaningStatus,
  reservedAtMs: number,
  nowMs: number,
  holdHours: number = RESERVATION_HOLD_HOURS,
): boolean {
  if (status !== "reserved") return false;
  return nowMs - reservedAtMs > holdHours * 3_600_000;
}
