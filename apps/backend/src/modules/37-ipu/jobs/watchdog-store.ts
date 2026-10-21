// apps/backend/src/modules/37-ipu/jobs/watchdog-store.ts — GAP-105 (#174): the Drizzle reads/writes behind the
// five remaining §4.8 crons. ORG-scoped, caller-owned `withOrgContext` tx — this file never opens its own
// tenancy envelope (`watchdog-workers.ts` owns that), and every read is RLS-filtered to that org on top of
// the explicit `organization_id` predicate.
import { type DbClient, schema } from "@chartwarden/db";
import type { CensusAdmissionFact, CensusIncidentCounts } from "@chartwarden/inpatient";
import type { IpuCensusSnapshotPayload } from "@chartwarden/types";
import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type {
  ActiveRestraintFact,
  GipAdmissionFact,
  IrcEpisodeFact,
  TurnoverBedFact,
} from "./watchdog-plans";

const ADM = schema.ipuAdmission;
const IRC = schema.ircEpisode;
const REMOTE = schema.ipuRemoteInpatientEpisode;
const SNAPSHOT = schema.ipuCensusSnapshot;
const RESTRAINT = schema.ipuRestraintEvent;
const BED = schema.ipuBed;
const BED_EVENT = schema.ipuBedCleaningEvent;
const UNIT = schema.inpatientUnit;

/** Admission states in which the patient still occupies the bed. */
const OCCUPYING_STATES = ["active", "transferring"] as const;

// ── IRC ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface OpenIrcEpisode extends IrcEpisodeFact {
  readonly id: string;
  readonly ipuAdmissionId: string;
  readonly version: number;
}

/** Every non-closed IRC episode in the org, with the tenant-local date it started on. */
export async function openIrcEpisodes(
  tx: DbClient,
  organizationId: string,
  timezone: string,
  limit: number,
): Promise<OpenIrcEpisode[]> {
  const rows = await tx
    .select({
      id: IRC.id,
      ipuAdmissionId: IRC.ipuAdmissionId,
      count: IRC.consecutiveDayCount,
      state: IRC.state,
      extension: IRC.capOverrideExtensionDays,
      carriedOverDays: IRC.carriedOverDays,
      version: IRC.version,
      startedLocalDate: sql<string>`(${IRC.startedAt} AT TIME ZONE ${timezone})::date::text`,
    })
    .from(IRC)
    .where(and(eq(IRC.organizationId, organizationId), sql`${IRC.state} <> 'closed'`))
    .orderBy(IRC.startedAt)
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    ipuAdmissionId: r.ipuAdmissionId,
    consecutiveDayCount: r.count,
    state: r.state,
    overrideExtensionDays: r.extension ?? 0,
    startedLocalDate: r.startedLocalDate,
    carriedOverDays: r.carriedOverDays,
    version: Number(r.version),
  }));
}

/**
 * Persist an advanced episode. Optimistic on `version`: an override (`overrideIrcCap`) racing this write
 * bumps the version, so the loser updates nothing and the next hourly tick re-derives from the winner's row.
 * Returns whether this call applied the change.
 */
export async function advanceIrcEpisode(
  tx: DbClient,
  episode: { readonly id: string; readonly version: number },
  next: { readonly consecutiveDayCount: number; readonly state: IrcEpisodeFact["state"] },
): Promise<boolean> {
  const updated = await tx
    .update(IRC)
    .set({
      consecutiveDayCount: next.consecutiveDayCount,
      state: next.state,
      updatedAt: new Date(),
      version: episode.version + 1,
    })
    .where(
      and(eq(IRC.id, episode.id), eq(IRC.version, episode.version), sql`${IRC.state} <> 'closed'`),
    )
    .returning({ id: IRC.id });
  return updated.length > 0;
}

// ── census ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ServiceDateBounds {
  readonly startMs: number;
  readonly endMs: number;
}

/** The half-open `[tenant-local midnight, next tenant-local midnight)` of a service date, as UTC ms. */
export async function serviceDateBounds(
  tx: DbClient,
  serviceDate: string,
  timezone: string,
): Promise<ServiceDateBounds> {
  const [row] = await tx
    .select({
      startMs: sql<number>`extract(epoch from (${serviceDate}::date::timestamp AT TIME ZONE ${timezone})) * 1000`,
      endMs: sql<number>`extract(epoch from ((${serviceDate}::date + 1)::timestamp AT TIME ZONE ${timezone})) * 1000`,
    })
    .from(sql`(select 1) as one`);
  if (!row) throw new Error("M37_CENSUS: could not resolve the service-date bounds");
  return { startMs: Number(row.startMs), endMs: Number(row.endMs) };
}

/** One bucket the day's census is keyed on: an own unit XOR a remote (arranged) facility. */
export interface CensusBucket {
  readonly unitId: string | null;
  readonly remoteFacilityId: string | null;
  /** `ipu_census_snapshot.provider_entity_id` is NOT NULL; taken from the bucket's own admissions. */
  readonly providerEntityId: string;
  readonly admissions: readonly CensusAdmissionFact[];
}

function isCensusLevel(kind: string): kind is "gip" | "irc" {
  return kind === "gip" || kind === "irc";
}

/** Group facts by their bucket key, keeping the lexicographically-smallest provider entity per bucket. */
function bucketize(
  facts: readonly (CensusAdmissionFact & {
    readonly unitId: string | null;
    readonly remoteFacilityId: string | null;
    readonly providerEntityId: string;
  })[],
): CensusBucket[] {
  const buckets = new Map<string, CensusBucket>();
  for (const f of facts) {
    const key = f.unitId ? `u:${f.unitId}` : `r:${f.remoteFacilityId}`;
    const existing = buckets.get(key);
    const fact: CensusAdmissionFact = {
      level: f.level,
      isArranged: f.isArranged,
      activeAtEndOfDay: f.activeAtEndOfDay,
      activeAnyPortionOfDay: f.activeAnyPortionOfDay,
    };
    buckets.set(key, {
      unitId: f.unitId,
      remoteFacilityId: f.remoteFacilityId,
      providerEntityId:
        existing && existing.providerEntityId < f.providerEntityId
          ? existing.providerEntityId
          : f.providerEntityId,
      admissions: [...(existing?.admissions ?? []), fact],
    });
  }
  return [...buckets.values()];
}

/**
 * Every (own unit | remote facility) that had a GIP/IRC patient for ANY portion of the service date, with its
 * admission facts (§2.13 D14, D15). A bucket with no admission that day writes nothing — a snapshot needs a
 * provider entity (NOT NULL) and only an admission carries one at this boundary — and a missing row reads as
 * zero bed-days to every consumer, which is the same answer a zero-valued row would give.
 *
 * Own-unit occupancy runs from `activated_at` to the FIRST entry into discharged / deceased / transferred
 * (read from the state history), NOT to `closed_at`: an admission closes T+7 after discharge, so using
 * `closed_at` would bill a week of bed-days for a bed that was empty.
 */
export async function censusBuckets(
  tx: DbClient,
  organizationId: string,
  bounds: ServiceDateBounds,
): Promise<CensusBucket[]> {
  const dayStart = new Date(bounds.startMs);
  const dayEnd = new Date(bounds.endMs);

  const own = await tx
    .select({
      unitId: ADM.unitId,
      providerEntityId: ADM.providerEntityId,
      kind: ADM.kind,
      activatedAt: ADM.activatedAt,
      // Raw, table-qualified identifiers: with a single FROM table Drizzle renders column refs UNQUALIFIED,
      // and inside a correlated subquery `"ipu_admission_id" = "id"` binds both sides to the inner table.
      occupancyEndedAt: sql<Date | null>`(
        select min(h.at) from ipu_admission_state_history h
        where h.ipu_admission_id = ipu_admission.id
          and h.to_state in ('discharged','deceased','transferred')
      )`,
    })
    .from(ADM)
    .where(
      and(
        eq(ADM.organizationId, organizationId),
        isNotNull(ADM.unitId),
        inArray(ADM.kind, ["gip", "irc"]),
        isNotNull(ADM.activatedAt),
        lt(ADM.activatedAt, dayEnd),
        or(isNull(ADM.closedAt), gt(ADM.closedAt, dayStart)),
      ),
    );

  const remote = await tx
    .select({
      remoteFacilityId: REMOTE.remoteFacilityId,
      providerEntityId: REMOTE.providerEntityId,
      kind: REMOTE.kind,
      startedAt: REMOTE.startedAt,
      endedAt: REMOTE.endedAt,
    })
    .from(REMOTE)
    .where(
      and(
        eq(REMOTE.organizationId, organizationId),
        inArray(REMOTE.kind, ["gip", "irc"]),
        lt(REMOTE.startedAt, dayEnd),
        or(isNull(REMOTE.endedAt), gt(REMOTE.endedAt, dayStart)),
      ),
    );

  const facts = [
    ...own.flatMap((r) => {
      if (!r.activatedAt || !isCensusLevel(r.kind)) return [];
      const endedMs = r.occupancyEndedAt ? new Date(r.occupancyEndedAt).getTime() : null;
      const window = occupancyWindow(r.activatedAt.getTime(), endedMs, bounds);
      if (!window.activeAnyPortionOfDay) return [];
      return [
        {
          level: r.kind,
          isArranged: false,
          ...window,
          unitId: r.unitId,
          remoteFacilityId: null,
          providerEntityId: r.providerEntityId,
        },
      ];
    }),
    ...remote.flatMap((r) => {
      if (!isCensusLevel(r.kind)) return [];
      const window = occupancyWindow(r.startedAt.getTime(), r.endedAt?.getTime() ?? null, bounds);
      if (!window.activeAnyPortionOfDay) return [];
      return [
        {
          level: r.kind,
          isArranged: true,
          ...window,
          unitId: null,
          remoteFacilityId: r.remoteFacilityId,
          providerEntityId: r.providerEntityId,
        },
      ];
    }),
  ];
  return bucketize(facts);
}

function occupancyWindow(
  startMs: number,
  endMs: number | null,
  bounds: ServiceDateBounds,
): { activeAnyPortionOfDay: boolean; activeAtEndOfDay: boolean } {
  const end = endMs ?? Number.POSITIVE_INFINITY;
  return {
    activeAnyPortionOfDay: startMs < bounds.endMs && end > bounds.startMs,
    // End-of-day head-count: still in the bed when the service date closes.
    activeAtEndOfDay: startMs < bounds.endMs && end >= bounds.endMs,
  };
}

/** The M37-owned incident counts for one own unit on the service date (fall/infection are M30's — see worker). */
export async function unitIncidentCounts(
  tx: DbClient,
  organizationId: string,
  unitId: string,
  bounds: ServiceDateBounds,
): Promise<CensusIncidentCounts> {
  const dayStart = new Date(bounds.startMs);
  const dayEnd = new Date(bounds.endMs);
  const [turnover] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(BED_EVENT)
    .innerJoin(BED, eq(BED.id, BED_EVENT.bedId))
    .where(
      and(
        eq(BED_EVENT.organizationId, organizationId),
        eq(BED.unitId, unitId),
        eq(BED_EVENT.toStatus, "ready"),
        eq(BED_EVENT.fromStatus, "cleaning"),
        sql`${BED_EVENT.at} >= ${dayStart}`,
        lt(BED_EVENT.at, dayEnd),
      ),
    );
  const [restraints] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(RESTRAINT)
    .innerJoin(ADM, eq(ADM.id, RESTRAINT.ipuAdmissionId))
    .where(
      and(
        eq(RESTRAINT.organizationId, organizationId),
        eq(ADM.unitId, unitId),
        sql`${RESTRAINT.appliedAt} >= ${dayStart}`,
        lt(RESTRAINT.appliedAt, dayEnd),
      ),
    );
  return {
    roomTurnoverCount: turnover?.n ?? 0,
    restraintIncidentCount: restraints?.n ?? 0,
    // M30 projections (incident reports) are not M37 rows and M37 has no seam to read them yet.
    fallIncidentCount: 0,
    infectionSurveillanceEventCount: 0,
  };
}

/**
 * Insert the snapshot unless one already exists for its key. The table's UNIQUE constraint spans two
 * nullable columns (`unit_id`, `remote_facility_id`), and Postgres treats NULLs as distinct, so it cannot
 * arbitrate a re-run on its own — the existence check does, inside the org's tx. Returns whether a row was
 * written (the caller publishes `snapshot_taken` only then, which is what makes a re-run emit nothing).
 */
export async function insertCensusSnapshotIfAbsent(
  tx: DbClient,
  payload: IpuCensusSnapshotPayload,
): Promise<boolean> {
  const sameBucket = payload.unitId
    ? eq(SNAPSHOT.unitId, payload.unitId)
    : and(isNull(SNAPSHOT.unitId), eq(SNAPSHOT.remoteFacilityId, payload.remoteFacilityId ?? ""));
  const [existing] = await tx
    .select({ id: SNAPSHOT.id })
    .from(SNAPSHOT)
    .where(
      and(
        eq(SNAPSHOT.organizationId, payload.organizationId),
        eq(SNAPSHOT.serviceDate, payload.serviceDate),
        sameBucket,
      ),
    )
    .limit(1);
  if (existing) return false;
  await tx.insert(SNAPSHOT).values({
    organizationId: payload.organizationId,
    serviceDate: payload.serviceDate,
    unitId: payload.unitId,
    remoteFacilityId: payload.remoteFacilityId,
    providerEntityId: payload.providerEntityId,
    censusCountGip: payload.censusCountGip,
    censusCountIrc: payload.censusCountIrc,
    censusCountArrangedGip: payload.censusCountArrangedGip,
    censusCountArrangedIrc: payload.censusCountArrangedIrc,
    bedDaysGip: payload.bedDaysGip,
    bedDaysIrc: payload.bedDaysIrc,
    bedDaysArrangedGip: payload.bedDaysArrangedGip,
    bedDaysArrangedIrc: payload.bedDaysArrangedIrc,
    roomTurnoverCount: payload.roomTurnoverCount,
    restraintIncidentCount: payload.restraintIncidentCount,
    fallIncidentCount: payload.fallIncidentCount,
    infectionSurveillanceEventCount: payload.infectionSurveillanceEventCount,
  });
  return true;
}

// ── restraint ────────────────────────────────────────────────────────────────────────────────────────────

/** Every active restraint in the org with the instant its reassessment clock last restarted. */
export async function activeRestraints(
  tx: DbClient,
  organizationId: string,
  limit: number,
): Promise<ActiveRestraintFact[]> {
  const rows = await tx
    .select({
      restraintEventId: RESTRAINT.id,
      ipuAdmissionId: RESTRAINT.ipuAdmissionId,
      intervalMinutes: RESTRAINT.reassessmentIntervalMinutes,
      appliedAt: RESTRAINT.appliedAt,
      lastReassessedAt: sql<Date | null>`(
        select max(r.reassessed_at) from ipu_restraint_reassessment r
        where r.restraint_event_id = ipu_restraint_event.id
      )`,
    })
    .from(RESTRAINT)
    .where(and(eq(RESTRAINT.organizationId, organizationId), eq(RESTRAINT.state, "active")))
    .orderBy(RESTRAINT.appliedAt)
    .limit(limit);
  return rows.map((r) => ({
    restraintEventId: r.restraintEventId,
    ipuAdmissionId: r.ipuAdmissionId,
    intervalMinutes: r.intervalMinutes,
    lastAssessedAtMs: Math.max(
      r.appliedAt.getTime(),
      r.lastReassessedAt ? new Date(r.lastReassessedAt).getTime() : 0,
    ),
  }));
}

// ── bed cleaning ─────────────────────────────────────────────────────────────────────────────────────────

/** Beds waiting on housekeeping (`discharged_dirty` / `cleaning`), with when they entered `discharged_dirty`. */
export async function bedsAwaitingTurnover(
  tx: DbClient,
  organizationId: string,
  limit: number,
): Promise<TurnoverBedFact[]> {
  const rows = await tx
    .select({
      bedId: BED.id,
      unitId: BED.unitId,
      status: BED.cleaningStatus,
      changedAt: BED.cleaningStatusChangedAt,
      sla: UNIT.turnoverSlaMinutes,
      dirtyAt: sql<Date | null>`(
        select max(e.at) from ipu_bed_cleaning_event e
        where e.bed_id = ipu_bed.id and e.to_status = 'discharged_dirty'
      )`,
    })
    .from(BED)
    .innerJoin(UNIT, eq(UNIT.id, BED.unitId))
    .where(
      and(
        eq(BED.organizationId, organizationId),
        inArray(BED.cleaningStatus, ["discharged_dirty", "cleaning"]),
      ),
    )
    .orderBy(BED.cleaningStatusChangedAt)
    .limit(limit);
  return rows.map((r) => ({
    bedId: r.bedId,
    unitId: r.unitId,
    status: r.status,
    // No `discharged_dirty` event (a bed seeded straight into the state) → the last status change is the
    // best available clock start; it can only be later than the true one, so it never over-alerts.
    dischargedDirtyAtMs: (r.dirtyAt ? new Date(r.dirtyAt) : r.changedAt).getTime(),
    configuredSlaMinutes: r.sla,
  }));
}

// ── GIP staleness ────────────────────────────────────────────────────────────────────────────────────────

/** Active GIP admissions with the instant their last reassessment (else attestation, else activation) landed. */
export async function gipAdmissionsForSweep(
  tx: DbClient,
  organizationId: string,
  limit: number,
): Promise<GipAdmissionFact[]> {
  const rows = await tx
    .select({
      ipuAdmissionId: ADM.id,
      activatedAt: ADM.activatedAt,
      openedAt: ADM.openedAt,
      attestedAt: sql<Date | null>`(
        select max(c.attested_at) from gip_admission_criteria c
        where c.ipu_admission_id = ipu_admission.id
      )`,
      reassessedAt: sql<Date | null>`(
        select max(g.assessed_at) from gip_criteria_reassessment g
        where g.ipu_admission_id = ipu_admission.id
      )`,
    })
    .from(ADM)
    .where(
      and(
        eq(ADM.organizationId, organizationId),
        eq(ADM.kind, "gip"),
        inArray(ADM.state, [...OCCUPYING_STATES]),
      ),
    )
    .orderBy(ADM.openedAt)
    .limit(limit);
  return rows.map((r) => {
    const reassessed = r.reassessedAt ? new Date(r.reassessedAt).getTime() : null;
    const anchor =
      reassessed ??
      (r.attestedAt ? new Date(r.attestedAt).getTime() : (r.activatedAt ?? r.openedAt).getTime());
    return {
      ipuAdmissionId: r.ipuAdmissionId,
      lastAssessedAtMs: anchor,
      hasReassessment: reassessed !== null,
    };
  });
}
