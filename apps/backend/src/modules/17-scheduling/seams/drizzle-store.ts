// apps/backend/src/modules/17-scheduling/seams/drizzle-store.ts — the Drizzle-backed
// {@link SchedulingSeamStore} the four §4.3 published seams (VisitReader + VisitAssignmentReader +
// PortalVisitReader + VisitMetricsProvider) read through in production (TASK-002; the M21
// `store-drizzle.ts` / M8 `drizzle-store.ts` precedents). The in-memory slice in ./store.ts remains the
// behavioral reference; this adapter reproduces its filters over the real M17 tables.
//
// TENANCY. Every read opens `withOrgContextFromRequest`, which pins `app.org_id` from the CONSUMER'S
// ambient request context (the store methods carry no orgId — the providers' `_orgId` parameter is
// deliberately unused, §3.6). M31 asking for a patient's upcoming visits gets M31's caller's org because
// RLS scoped the statement, not because this file compared anything. Called outside a request scope it
// THROWS rather than reading unscoped — the correct direction for a PHI-adjacent visit surface.
//
// PARTITIONED PARENT. `visit` is PARTITION BY RANGE (service_date) monthly (D14), so every read here
// carries a `service_date` predicate wherever the call gives one (the on-date reads key on it directly;
// the windowed reads bound it from the window's date span — a visit's `service_date` is always the date
// of its `scheduled_started_at`, so the bound is safe and prunes partitions). Only `visitById` fans out
// across leaves: a seam consumer has an id and no time window, and inventing one would silently miss a
// last-month visit (the M21 id-only-lookup trade).
//
// PORTAL SCRUBBING (§4.3). The `PortalVisitSummary` projection is lay-language: `visitPurposeLabel` is
// the same deliberate "Scheduled visit" constant the M17L route service ships (never the raw enum — a
// family portal must not surface `pronouncement`), `scheduler_internal_notes` is never selected, and the
// only identity that crosses is the assigned clinician's display name (membership → user.name, the M2
// membership-repository precedent; `user` is granted to wardenx_app and org scope is applied via the
// RLS-scoped membership join).
//
// ROUTE EFFICIENCY (D10). Proposed miles come from M17's own `route_segment` (tenths-of-mile integers);
// ACTUAL miles are read from M8's `MileagePayrollReader` seam (M8 is authoritative for driven mileage —
// M17's optimizer output is a proposal). An unreadable M8 seam PROPAGATES rather than answering
// `totalActualMiles: 0` — an unreadable mileage ledger is not a clinician who drove zero miles. The
// override rate is derived from data (per-day proposed sequence vs. the actual start order), never seeded.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import type {
  DateRange,
  OnCallRosterEntry,
  PortalVisitSummary,
  VisitAssignmentDto,
  VisitDto,
} from "@wardenx/types";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { getMileagePayrollReader } from "./consumed";
import { createDrizzleOnCallRotationStore } from "./oncall-rotation-store";
import type {
  SchedulingMetricsCounts,
  SchedulingRouteEfficiency,
  SchedulingSeamStore,
} from "./store";

const V = schema.visit;
const RS = schema.routeSegment;
const MEM = schema.memberships;
const U = schema.users;

const iso = (d: Date | string): string => (typeof d === "string" ? d : d.toISOString());
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));
/** The `service_date` partition-prune bound for an instant window (a visit's service_date IS its start date). */
const dateOf = (isoStr: string): string => isoStr.slice(0, 10);

/**
 * §4.3, deliberately: the lay-language portal label the M17L route service ships for EVERY purpose. The raw
 * `visit_purpose` enum never crosses the portal seam — a family-facing surface must not read `pronouncement`
 * or `discharge_visit` off a scheduler vocabulary (the same scrub `portalUpcoming` applies in
 * scheduling-route-service-db.ts).
 */
const PORTAL_VISIT_PURPOSE_LABEL = "Scheduled visit";

/** Visit statuses that count as a CURRENTLY-active assignment (§4.5 D11 — mirrors the in-memory slice). */
const ACTIVE_ASSIGNMENT_STATUSES = ["published", "en_route", "in_visit"] as const;

/**
 * Thrown by `onCallRoster` for a tenant that has NEVER entered an `oncall_rotation_entry` row (GAP-029: M17
 * now owns that table). An empty array here would be a lie with teeth: M19's shift-sync reconciler reads `[]`
 * as "nobody is on call tonight" and cancels every scheduled shift, while a THROW lands in its §2.7 class-D-C
 * "M17 unreadable" branch (the roster path goes silent and the last committed shifts stand). A tenant that
 * has not adopted the M17 rotation therefore stays on its hand-scheduled shifts; the first rotation row
 * makes the roster authoritative for that tenant.
 */
export class SchedulingOnCallRosterUnavailableError extends Error {
  constructor() {
    super(
      "VisitAssignmentReader.tonightsOnCallRoster: this tenant has no M17 on-call rotation entries — the roster read is unreadable (not empty) until one is entered (M19 shift-sync treats this throw as its §2.7 class-D-C degraded path)",
    );
    this.name = "SchedulingOnCallRosterUnavailableError";
  }
}

/** The `visit` columns the {@link VisitDto} projection selects (the M17L VISIT_COLS superset). */
const VISIT_DTO_COLS = {
  id: V.id,
  organizationId: V.organizationId,
  providerEntityId: V.providerEntityId,
  locationId: V.locationId,
  patientId: V.patientId,
  admissionId: V.admissionId,
  patientAddressId: V.patientAddressId,
  externalFacilityId: V.externalFacilityId,
  assignedMembershipId: V.assignedMembershipId,
  assignedDisciplineAtAssignment: V.assignedDisciplineAtAssignment,
  visitPurpose: V.visitPurpose,
  visitSetting: V.visitSetting,
  scheduledStartedAt: V.scheduledStartedAt,
  scheduledEndedAt: V.scheduledEndedAt,
  serviceDate: V.serviceDate,
  actualStartedAt: V.actualStartedAt,
  actualEndedAt: V.actualEndedAt,
  status: V.status,
  evvBracketState: V.evvBracketState,
  encounterId: V.encounterId,
} as const;

type VisitDtoRow = {
  id: string;
  organizationId: string;
  providerEntityId: string;
  locationId: string;
  patientId: string;
  admissionId: string;
  patientAddressId: string | null;
  externalFacilityId: string | null;
  assignedMembershipId: string;
  assignedDisciplineAtAssignment: string;
  visitPurpose: string;
  visitSetting: string;
  scheduledStartedAt: Date;
  scheduledEndedAt: Date;
  serviceDate: string;
  actualStartedAt: Date | null;
  actualEndedAt: Date | null;
  status: string;
  evvBracketState: string | null;
  encounterId: string | null;
};

/** Project a `visit` row onto the §4.3 read DTO (never the Drizzle row itself). */
function toVisitDto(r: VisitDtoRow): VisitDto {
  return {
    id: r.id,
    organizationId: r.organizationId,
    providerEntityId: r.providerEntityId,
    locationId: r.locationId,
    patientId: r.patientId,
    admissionId: r.admissionId,
    patientAddressId: r.patientAddressId,
    externalFacilityId: r.externalFacilityId,
    assignedMembershipId: r.assignedMembershipId,
    assignedDisciplineAtAssignment: r.assignedDisciplineAtAssignment,
    visitPurpose: r.visitPurpose,
    visitSetting: r.visitSetting,
    scheduledStartedAt: iso(r.scheduledStartedAt),
    scheduledEndedAt: iso(r.scheduledEndedAt),
    serviceDate: r.serviceDate,
    actualStartedAt: isoN(r.actualStartedAt),
    actualEndedAt: isoN(r.actualEndedAt),
    status: r.status,
    evvBracketState: r.evvBracketState,
    encounterId: r.encounterId,
  } as VisitDto;
}

/** Project a `visit` row onto the narrower §4.5 D11 caseload-contribution DTO. */
function toAssignmentDto(r: VisitDtoRow): VisitAssignmentDto {
  return {
    visitId: r.id,
    patientId: r.patientId,
    assignedMembershipId: r.assignedMembershipId,
    scheduledStartedAt: iso(r.scheduledStartedAt),
    scheduledEndedAt: iso(r.scheduledEndedAt),
    status: r.status,
  } as VisitAssignmentDto;
}

/**
 * The window tallies behind `VisitMetricsProvider`, over an already-open tenant tx. Shared by the request-
 * scoped store method and {@link onTimeVisitCountsForOrg} so the on-time semantics live in one place.
 */
async function schedulingMetricsCountsIn(
  tx: DbClient,
  window: Parameters<SchedulingSeamStore["metricsCounts"]>[0],
  filters?: Parameters<SchedulingSeamStore["metricsCounts"]>[1],
): Promise<SchedulingMetricsCounts> {
  const conds = [
    gte(V.scheduledStartedAt, new Date(window.from)),
    lte(V.scheduledStartedAt, new Date(window.to)),
    gte(V.serviceDate, dateOf(window.from)),
    lte(V.serviceDate, dateOf(window.to)),
  ];
  if (filters?.discipline !== undefined) {
    conds.push(eq(V.assignedDisciplineAtAssignment, filters.discipline));
  }
  // One scan, the per-tally split done in SQL (the M21 costTotals precedent) — the semantics are the
  // in-memory slice's, verbatim: on-time = started at/before the scheduled start; published = past the
  // proposal stage; the provider does all division.
  const [row] = await tx
    .select({
      total: sql<string>`count(*)`,
      onTime: sql<string>`count(*) filter (where ${V.actualStartedAt} is not null and ${V.actualStartedAt} <= ${V.scheduledStartedAt})`,
      noShow: sql<string>`count(*) filter (where ${V.status} = 'no_show')`,
      published: sql<string>`count(*) filter (where ${V.status} <> 'proposed')`,
      rescheduled: sql<string>`count(*) filter (where ${V.status} = 'rescheduled')`,
    })
    .from(V)
    .where(and(...conds));
  const n = (v: string | number | null | undefined): number => Number(v ?? 0);
  return {
    totalScheduled: n(row?.total),
    onTimeCount: n(row?.onTime),
    noShowCount: n(row?.noShow),
    publishedCount: n(row?.published),
    rescheduledCount: n(row?.rescheduled),
  };
}

/**
 * GAP-090 — org-explicit on-time-visit tally for M30's `visit_on_time_rate` recompute. The published
 * `VisitMetricsProvider` runs under `withOrgContextFromRequest`, which throws `no ambient request context`
 * inside a worker; this opens its own `withOrgContext` envelope on the job's org instead (the
 * `complianceStatesForVisitsForOrg` / `admissionSchedulingContextForOrg` shape). Aggregate counts only.
 */
export async function onTimeVisitCountsForOrg(
  db: DbClient,
  organizationId: string,
  window: Parameters<SchedulingSeamStore["metricsCounts"]>[0],
  filters?: Parameters<SchedulingSeamStore["metricsCounts"]>[1],
): Promise<{ readonly numerator: number; readonly denominator: number }> {
  const counts = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
    schedulingMetricsCountsIn(tx as unknown as DbClient, window, filters),
  );
  return { numerator: counts.onTimeCount, denominator: counts.totalScheduled };
}

/** Build the Drizzle-backed §4.3 scheduling seam store (production; injected via `registerSchedulingSeams`). */
export function createDrizzleSchedulingSeamStore(db: DbClient): SchedulingSeamStore {
  const rotationStore = createDrizzleOnCallRotationStore(db);
  return {
    // ── visit reads (VisitReader) ──────────────────────────────────────────────────────────────────────
    async visitById(visitId) {
      return withOrgContextFromRequest(db, async (tx): Promise<VisitDto | null> => {
        const [row] = await tx.select(VISIT_DTO_COLS).from(V).where(eq(V.id, visitId)).limit(1);
        return row ? toVisitDto(row as VisitDtoRow) : null;
      });
    },

    async scheduledVisitsForMembershipOnDate(membershipId, date) {
      return withOrgContextFromRequest(db, async (tx): Promise<VisitDto[]> => {
        // Keyed on `service_date` — the partition key AND the in-memory slice's `visitOnDate` filter (all
        // statuses; the day view shows cancelled/no-show rows too, mirroring the behavioral reference).
        const rows = await tx
          .select(VISIT_DTO_COLS)
          .from(V)
          .where(and(eq(V.assignedMembershipId, membershipId), eq(V.serviceDate, date)))
          .orderBy(asc(V.scheduledStartedAt));
        return rows.map((r) => toVisitDto(r as VisitDtoRow));
      });
    },

    async completedVisitsForPatientSince(patientId, sinceIso) {
      return withOrgContextFromRequest(db, async (tx): Promise<VisitDto[]> => {
        const rows = await tx
          .select(VISIT_DTO_COLS)
          .from(V)
          .where(
            and(
              eq(V.patientId, patientId),
              eq(V.status, "completed"),
              // The in-memory reference keys "since" on the SCHEDULED start; the service_date bound is the
              // partition prune for the same instant.
              gte(V.scheduledStartedAt, new Date(sinceIso)),
              gte(V.serviceDate, dateOf(sinceIso)),
            ),
          )
          .orderBy(asc(V.scheduledStartedAt));
        return rows.map((r) => toVisitDto(r as VisitDtoRow));
      });
    },

    // ── assignment reads (VisitAssignmentReader) ───────────────────────────────────────────────────────
    async activeAssignmentsForMembershipOnDate(membershipId, date) {
      return withOrgContextFromRequest(db, async (tx): Promise<VisitAssignmentDto[]> => {
        const rows = await tx
          .select(VISIT_DTO_COLS)
          .from(V)
          .where(
            and(
              eq(V.assignedMembershipId, membershipId),
              eq(V.serviceDate, date),
              inArray(V.status, [...ACTIVE_ASSIGNMENT_STATUSES]),
            ),
          )
          .orderBy(asc(V.scheduledStartedAt));
        return rows.map((r) => toAssignmentDto(r as VisitDtoRow));
      });
    },

    async onCallRoster(asOfIso): Promise<ReadonlyArray<OnCallRosterEntry>> {
      // GAP-029 — M17's own `oncall_rotation_entry` is the source. A tenant that has never entered a
      // rotation row is UNREADABLE (not empty): M19's reconciler reads `[]` as "nobody is on call" and would
      // cancel every shift that tenant scheduled by hand, whereas a throw lands in its §2.7 D-C branch (the
      // last committed shifts stand). See {@link SchedulingOnCallRosterUnavailableError}.
      const read = await rotationStore.rosterAsOf(asOfIso);
      if (read.kind === "none_configured") throw new SchedulingOnCallRosterUnavailableError();
      return read.entries;
    },

    async currentVisitForClinician(membershipId) {
      return withOrgContextFromRequest(db, async (tx): Promise<VisitDto | null> => {
        // At most one `in_visit` row should exist per clinician (the D6 overlap EXCLUDE backstops it); take
        // the most recently started one if data ever disagrees.
        const [row] = await tx
          .select(VISIT_DTO_COLS)
          .from(V)
          .where(and(eq(V.assignedMembershipId, membershipId), eq(V.status, "in_visit")))
          .orderBy(desc(V.actualStartedAt))
          .limit(1);
        return row ? toVisitDto(row as VisitDtoRow) : null;
      });
    },

    // ── portal reads (PortalVisitReader — lay-language, scrubbed) ──────────────────────────────────────
    async upcomingForPatient(patientId, withinHours) {
      return withOrgContextFromRequest(db, async (tx): Promise<PortalVisitSummary[]> => {
        const now = new Date();
        const cutoff = new Date(now.getTime() + withinHours * 3_600_000);
        const rows = await tx
          .select({
            id: V.id,
            scheduledStartedAt: V.scheduledStartedAt,
            scheduledEndedAt: V.scheduledEndedAt,
            visitSetting: V.visitSetting,
            clinicianName: U.name,
          })
          .from(V)
          // The clinician's lay display name (membership → user; the M2 membership-repository join). LEFT
          // joins: a missing user row degrades to an empty name, never drops the visit from the portal.
          .leftJoin(MEM, eq(MEM.id, V.assignedMembershipId))
          .leftJoin(U, eq(U.id, MEM.userId))
          .where(
            and(
              eq(V.patientId, patientId),
              // Only PUBLISHED visits are portal-visible (the route-service posture): a `proposed` row is
              // scheduler-internal and an in-flight/terminal one is not "upcoming".
              eq(V.status, "published"),
              gte(V.scheduledStartedAt, now),
              lte(V.scheduledStartedAt, cutoff),
              gte(V.serviceDate, dateOf(now.toISOString())),
              lte(V.serviceDate, dateOf(cutoff.toISOString())),
            ),
          )
          .orderBy(asc(V.scheduledStartedAt));
        return rows.map(
          (r) =>
            ({
              visitId: r.id,
              scheduledStartedAt: iso(r.scheduledStartedAt),
              scheduledEndedAt: iso(r.scheduledEndedAt),
              visitPurposeLabel: PORTAL_VISIT_PURPOSE_LABEL, // §4.3 — lay-language, never the raw enum
              clinicianDisplayName: r.clinicianName ?? "",
              visitSetting: r.visitSetting,
            }) as PortalVisitSummary,
        );
      });
    },

    // ── metric reads (VisitMetricsProvider) ────────────────────────────────────────────────────────────
    async metricsCounts(window, filters) {
      return withOrgContextFromRequest(db, (tx) =>
        schedulingMetricsCountsIn(tx as unknown as DbClient, window, filters),
      );
    },

    async routeEfficiencyForMembership(membershipId, window) {
      const fromDate = dateOf(window.from);
      const toDate = dateOf(window.to);

      const { proposedTenths, sequencedStarts } = await withOrgContextFromRequest(
        db,
        async (tx) => {
          // Proposed miles: M17's own `route_segment` legs for the clinician's days in the window
          // (tenths-of-mile integers, D10 — a PROPOSAL, never billable mileage).
          const [sumRow] = await tx
            .select({ tenths: sql<string>`coalesce(sum(${RS.proposedMiles}), 0)` })
            .from(RS)
            .where(
              and(
                eq(RS.membershipId, membershipId),
                gte(RS.serviceDate, fromDate),
                lte(RS.serviceDate, toDate),
              ),
            );
          // Override detection input: every visit in the window that carries BOTH an optimizer-proposed
          // sequence index and a real start (partition-pruned by service_date; ordered by actual start so
          // the per-day grouping below preserves the driven order).
          const starts = await tx
            .select({
              serviceDate: V.serviceDate,
              sequenceIndex: V.proposedRouteSequenceIndex,
            })
            .from(V)
            .where(
              and(
                eq(V.assignedMembershipId, membershipId),
                gte(V.serviceDate, fromDate),
                lte(V.serviceDate, toDate),
                isNotNull(V.proposedRouteSequenceIndex),
                isNotNull(V.actualStartedAt),
              ),
            )
            .orderBy(asc(V.actualStartedAt));
          return { proposedTenths: Number(sumRow?.tenths ?? 0), sequencedStarts: starts };
        },
      );

      // Override rate — DERIVED, never seeded: a day is "overridden" when the clinician's actual start
      // order disagrees with the optimizer's proposed sequence. Days with fewer than two sequenced starts
      // cannot be out of order and do not enter the denominator; no eligible day → vacuously 0.
      const byDay = new Map<string, number[]>();
      for (const r of sequencedStarts) {
        const bucket = byDay.get(r.serviceDate) ?? [];
        bucket.push(r.sequenceIndex as number);
        byDay.set(r.serviceDate, bucket);
      }
      let eligibleDays = 0;
      let overriddenDays = 0;
      for (const seqs of byDay.values()) {
        if (seqs.length < 2) continue;
        eligibleDays++;
        let outOfOrder = false;
        for (let i = 1; i < seqs.length; i++) {
          if ((seqs[i] as number) < (seqs[i - 1] as number)) {
            outOfOrder = true;
            break;
          }
        }
        if (outOfOrder) overriddenDays++;
      }

      // Actual miles: M8's `MileagePayrollReader` is AUTHORITATIVE (D10) — resolved through the M1 registry
      // under the same ambient request context. Errors PROPAGATE: an unreadable mileage ledger must not
      // masquerade as zero driven miles.
      const mileage = await getMileagePayrollReader().mileageForPayrollPeriod(membershipId, {
        from: fromDate,
        to: toDate,
      } as DateRange);
      const totalActualMiles = mileage.reduce((acc, m) => acc + m.milesDriven, 0);

      const efficiency: SchedulingRouteEfficiency = {
        totalProposedMiles: proposedTenths / 10,
        totalActualMiles,
        overrideRate: eligibleDays === 0 ? 0 : overriddenDays / eligibleDays,
      };
      return efficiency;
    },
  };
}
