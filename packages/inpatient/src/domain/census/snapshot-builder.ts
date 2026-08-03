// @wardenx/inpatient — M37-T10, §2.13 D14. Builds the `m37.census.snapshot_taken` payload (one per
// org × unit/remote-facility × date) from the day's admission facts + incident counts. Pure & IO-free —
// the census-snapshot-builder cron loads the facts under RLS and injects them. The payload is consumed by
// M23 (per-diem), M26 (inpatient cap), M27 (Worksheet S-3), M33 (MV refresh).
import type { IpuCensusSnapshotPayload } from "@wardenx/types";

/** The level-of-care discriminator the census buckets by. */
export type CensusLevel = "gip" | "irc";

/** One admission's contribution to a (unit/remote × date) census bucket. */
export interface CensusAdmissionFact {
  readonly level: CensusLevel;
  /** True for an ipu_remote_inpatient_episode (arranged inpatient care, D15); false for an own-unit admission. */
  readonly isArranged: boolean;
  /** Active at end-of-day → counts in the census_count_* head-count. */
  readonly activeAtEndOfDay: boolean;
  /** Active any portion of the service date → counts a bed-day. */
  readonly activeAnyPortionOfDay: boolean;
}

/** The incident/turnover counts folded into the snapshot (resolved from M37 rows + M30 projections). */
export interface CensusIncidentCounts {
  readonly roomTurnoverCount: number;
  readonly restraintIncidentCount: number;
  readonly fallIncidentCount: number;
  readonly infectionSurveillanceEventCount: number;
}

/** The (org × unit/remote × date) key the snapshot is stamped with. */
export interface CensusSnapshotKey {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly serviceDate: string; // ISO date
  readonly unitId: string | null;
  readonly remoteFacilityId: string | null;
}

/**
 * §2.13 — assemble the census snapshot payload. Head-counts (`census_count_*`) count admissions active at
 * end-of-day; bed-days (`bed_days_*`) count admissions active any portion of the day (the service-day rule).
 * Own-unit admissions land in the `gip`/`irc` buckets; arranged (remote-IPU) admissions land in the
 * `arranged_gip`/`arranged_irc` buckets.
 */
export function buildCensusSnapshotPayload(
  key: CensusSnapshotKey,
  admissions: readonly CensusAdmissionFact[],
  incidents: CensusIncidentCounts,
): IpuCensusSnapshotPayload {
  const count = (pred: (a: CensusAdmissionFact) => boolean) => admissions.filter(pred).length;

  return {
    organizationId: key.organizationId,
    providerEntityId: key.providerEntityId,
    serviceDate: key.serviceDate,
    unitId: key.unitId,
    remoteFacilityId: key.remoteFacilityId,
    censusCountGip: count((a) => !a.isArranged && a.level === "gip" && a.activeAtEndOfDay),
    censusCountIrc: count((a) => !a.isArranged && a.level === "irc" && a.activeAtEndOfDay),
    censusCountArrangedGip: count((a) => a.isArranged && a.level === "gip" && a.activeAtEndOfDay),
    censusCountArrangedIrc: count((a) => a.isArranged && a.level === "irc" && a.activeAtEndOfDay),
    bedDaysGip: count((a) => !a.isArranged && a.level === "gip" && a.activeAnyPortionOfDay),
    bedDaysIrc: count((a) => !a.isArranged && a.level === "irc" && a.activeAnyPortionOfDay),
    bedDaysArrangedGip: count((a) => a.isArranged && a.level === "gip" && a.activeAnyPortionOfDay),
    bedDaysArrangedIrc: count((a) => a.isArranged && a.level === "irc" && a.activeAnyPortionOfDay),
    roomTurnoverCount: incidents.roomTurnoverCount,
    restraintIncidentCount: incidents.restraintIncidentCount,
    fallIncidentCount: incidents.fallIncidentCount,
    infectionSurveillanceEventCount: incidents.infectionSurveillanceEventCount,
  };
}
