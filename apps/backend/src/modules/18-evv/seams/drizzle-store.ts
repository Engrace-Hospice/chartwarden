// apps/backend/src/modules/18-evv/seams/drizzle-store.ts — the Drizzle-backed {@link EvvSeamStore} the six
// §4.3 published seams (EvvBracketResolver + EvvComplianceReader + EvvAggregatorReferenceReader +
// EvvLocationProvider + EvvMetricsProvider + EvvVerificationProvider) read through in production (TASK-002;
// the M21 `store-drizzle.ts` / M8 `drizzle-store.ts` precedents). The in-memory slice in ./store.ts remains
// the behavioral reference; this adapter reproduces its projections over the real M18 tables (+ the M17
// `visit` aggregate M18 already reads — dependsOn [17], the route-service precedent).
//
// TENANCY. Every read opens `withOrgContextFromRequest`, which pins `app.org_id` from the CONSUMER'S ambient
// request context (the store methods carry no orgId — the providers' `_orgId` parameter is deliberately
// unused, §3.6). Called outside a request scope it THROWS rather than reading unscoped.
//
// PARTITIONED PARENT. `evv_event` is PARTITION BY RANGE (event_at) monthly (D12): the windowed metric reads
// bound `event_at` (partition-pruned); the per-visit bracket/arrival reads are id-keyed and fan out across
// leaves — a seam consumer has a visit id and no time window, and inventing one would silently miss a
// last-month bracket (the M21 id-only-lookup trade; `evv_event_org_visit_idx` carries the per-leaf cost).
// Event reads that feed a bracket take only ACTIVE rows (`superseded_by_event_id IS NULL`; the D2 per-leaf
// active-pair invariant makes that at most one check-in + one check-out per visit). The INDEX behind that
// invariant keys on `superseded_at` instead (0236/F-088) — the two are written in the same transaction and
// differ only for the few statements inside a correction, where the index must already treat the original
// as gone so the replacement can insert, and these reads must not yet.
//
// COORDINATES (D10, GAP-032). GPS coordinates exist ONLY as `evv_event.coords_cipher`. The
// coordinate-bearing `EvvLocationProvider` reads follow the M18L route service's posture EXACTLY
// (`clinicianCurrentLocation`): both now recover the stored coordinate through the shared `../coords`
// codec — the same one the capture wrote it with — and both return `lat: null`/`lng: null` when the
// payload is absent or unparseable. They previously ZEROED both fields behind a `TODO(D10)`, which a
// caller could not distinguish from a genuine coordinate. ⚠️ The column is NOT encrypted despite its name:
// it holds `base64("lat,lng")` and the per-tenant DEK pipeline is still deferred (see ../coords.ts) —
// decoding base64 is not decryption and nothing here closes that. Every other projection is
// coordinate-free; the portal verification surface is timestamp + lay identity only (§4.6).
//
// METRICS HONESTY (UI-003). The route service's `metrics()` HARDCODES `complianceRate: 1` /
// `lateCheckoutRate: 0` — a known audit finding this store must NOT copy. Here every tally is computed from
// schema: compliance classifies the window's completed visits off their active event pair + missing-
// resolution rows; late-checkout counts the visits whose missing-checkout row auto-closed when the late
// check-out finally arrived (`closed_system_checkout_received`, M18-F09/ADR-0022 — the only schema fact that
// says "the checkout came, late"; a still-open row is a MISSING checkout and surfaces as
// `unresolved_missing` in the compliance breakdown instead, never in this numerator). Where a fact genuinely
// has no schema source the shape stays an honest zero-DENOMINATOR pair the provider's vacuous-window rules
// already handle — nothing here answers a fixed rate.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContextFromRequest } from "@wardenx/tenancy";
import type {
  EvvAggregatorSubmissionDto,
  EvvBracketDto,
  EvvComplianceDto,
  EvvEventDto,
  EvvLocationDto,
  EvvMissingResolutionDto,
} from "@wardenx/types";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { decodeStoredCoords } from "../coords";
import type {
  EvvAggregatorWindowCounts,
  EvvArrival,
  EvvComplianceState,
  EvvDeviceCoverage,
  EvvMetricWindowCounts,
  EvvSeamStore,
  EvvVerificationSummary,
} from "./store";

const EVENT = schema.evvEvent;
const MR = schema.evvMissingResolution;
const AGG = schema.evvAggregatorSubmission;
const DEVICE = schema.evvDevice;
const VISIT = schema.visit;
const MEM = schema.memberships;
const U = schema.users;

const iso = (d: Date | string): string => (typeof d === "string" ? d : d.toISOString());
/** The `service_date` partition-prune bound for an instant (a visit's service_date IS its start date). */
const dateOf = (isoStr: string): string => isoStr.slice(0, 10);
const n = (v: string | number | null | undefined): number => Number(v ?? 0);

/** The EvvLocationProvider recency bound the seam contract documents (the "last 12h" shift window, §4.3). */
const LOCATION_RECENCY_MS = 12 * 3_600_000;

/** The D6 close statuses that reify a DOCUMENTED missing bracket. `closed_visit_voided` is deliberately
 * absent: a voided visit has no service to document, so it classifies `no_evv_path`/`not_required`, not
 * `documented_missing` (ADR-0008 — only a still-`open` row blocks billing). */
const DOCUMENTED_CLOSE_STATUSES = [
  "closed_clinician_attested",
  "closed_supervisor_override",
  "closed_documented_at_encounter",
  "closed_system_checkout_received",
] as const;

/** Map an `evv_event` row to the coordinate-free §4.3 wire projection (the route-service mapping, verbatim). */
function toEventDto(e: typeof EVENT.$inferSelect): EvvEventDto {
  return {
    id: e.id,
    organizationId: e.organizationId,
    visitId: e.visitId,
    patientId: e.patientId,
    kind: e.kind,
    serviceTypeCode: e.serviceTypeCode,
    postingMembershipId: e.postingMembershipId,
    postingDisciplineAtRecording: e.postingDisciplineAtRecording,
    evvDeviceId: e.evvDeviceId,
    capturedAt: iso(e.capturedAt),
    recordedAt: iso(e.recordedAt),
    gpsQuality: e.gpsQuality,
    offlineCapture: e.offlineCapture,
    replacesEventId: e.replacesEventId ?? null,
    supersededByEventId: e.supersededByEventId ?? null,
  } as EvvEventDto;
}

/** Map an `evv_missing_resolution` row to the §4.3 traceability projection. */
function toResolutionDto(r: typeof MR.$inferSelect): EvvMissingResolutionDto {
  return {
    id: r.id,
    visitId: r.visitId,
    kind: r.kind,
    status: r.status,
    resolvedByMembershipId: r.resolvedByMembershipId ?? null,
    resolvedAt: r.resolvedAt === null ? null : iso(r.resolvedAt),
  } as EvvMissingResolutionDto;
}

/** Map an `evv_aggregator_submission` row to the §4.3 wire projection (the route-service mapping, verbatim). */
function toSubmissionDto(s: typeof AGG.$inferSelect): EvvAggregatorSubmissionDto {
  return {
    id: s.id,
    visitId: s.visitId,
    stateCode: s.stateCode,
    aggregatorVendor: s.aggregatorVendor,
    status: s.status,
    aggregatorTransactionId: s.aggregatorTransactionId ?? null,
    attemptCount: s.attemptCount,
  } as EvvAggregatorSubmissionDto;
}

/** The per-visit bracket/compliance classification shared by the bracket, per-visit-state, and windowed
 * reads — ONE place for the ADR-0008 semantics. */
function classify(input: {
  hasCheckIn: boolean;
  hasCheckOut: boolean;
  hasOpenResolution: boolean;
  hasDocumentedClose: boolean;
}): { bracketState: EvvBracketDto["bracketState"]; compliance: EvvComplianceState } {
  if (input.hasCheckIn && input.hasCheckOut) {
    return { bracketState: "present", compliance: "compliant" };
  }
  if (input.hasOpenResolution) {
    return { bracketState: "missing_open", compliance: "unresolved_missing" };
  }
  if (input.hasDocumentedClose) {
    return { bracketState: "missing_documented", compliance: "documented_missing" };
  }
  // No events, no resolution trail (or a voided-visit close only) → the visit has no EVV path
  // (open-model / non-EVV service) → not required. Mirrors the in-memory `complianceFromBracket` default.
  return { bracketState: "no_evv_path", compliance: "not_required" };
}

/**
 * Project an event-metadata row to the D10 location DTO (GAP-032). Recovers the stored coordinate through
 * the same codec the capture wrote it with; an absent or unparseable payload yields an explicit null pair,
 * never a zeroed one — the route service's posture, now that both sides agree.
 */
function toLocationDto(r: {
  membershipId: string;
  eventId: string;
  visitId: string;
  accuracyM: number;
  capturedAt: Date;
  coordsCipher?: string | null;
}): EvvLocationDto {
  const coords = decodeStoredCoords(r.coordsCipher);
  return {
    membershipId: r.membershipId,
    eventId: r.eventId,
    visitId: r.visitId,
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
    accuracyM: r.accuracyM,
    capturedAt: iso(r.capturedAt),
  } as EvvLocationDto;
}

/** Build the Drizzle-backed §4.3 EVV seam store (production; injected via `registerEvvSeams`). */
export function createDrizzleEvvSeamStore(db: DbClient): EvvSeamStore {
  /** The per-visit bracket facts (active event pair + resolution trail) the three per-visit reads share. */
  async function bracketFacts(
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
    visitId: string,
  ): Promise<{
    checkIn: typeof EVENT.$inferSelect | null;
    checkOut: typeof EVENT.$inferSelect | null;
    resolutions: Array<typeof MR.$inferSelect>;
  }> {
    const events = await tx
      .select()
      .from(EVENT)
      .where(and(eq(EVENT.visitId, visitId), isNull(EVENT.supersededByEventId)))
      .orderBy(desc(EVENT.eventAt));
    const resolutions = await tx
      .select()
      .from(MR)
      .where(eq(MR.visitId, visitId))
      .orderBy(desc(MR.detectedAt));
    return {
      checkIn: events.find((e) => e.kind === "check_in") ?? null,
      checkOut: events.find((e) => e.kind === "check_out") ?? null,
      resolutions,
    };
  }

  return {
    // ── bracket reads (EvvBracketResolver — M8's finalize-time contract) ───────────────────────────────
    async bracketForVisit(visitId) {
      return withOrgContextFromRequest(db, async (tx): Promise<EvvBracketDto | null> => {
        // The visit anchor is the RLS-scoped existence check: absent / cross-tenant → null (the seam's
        // non-leaking absent), where the route surface throws its own 404.
        const [visitRow] = await tx
          .select({ id: VISIT.id })
          .from(VISIT)
          .where(eq(VISIT.id, visitId))
          .limit(1);
        if (!visitRow) return null;
        const { checkIn, checkOut, resolutions } = await bracketFacts(tx, visitId);
        const open = resolutions.find((r) => r.status === "open") ?? null;
        const documented =
          resolutions.find((r) =>
            (DOCUMENTED_CLOSE_STATUSES as readonly string[]).includes(r.status),
          ) ?? null;
        const { bracketState } = classify({
          hasCheckIn: checkIn !== null,
          hasCheckOut: checkOut !== null,
          hasOpenResolution: open !== null,
          hasDocumentedClose: documented !== null,
        });
        const traced = open ?? documented ?? resolutions[0] ?? null;
        return {
          visitId,
          checkInEvent: checkIn ? toEventDto(checkIn) : null,
          checkOutEvent: checkOut ? toEventDto(checkOut) : null,
          bracketState,
          missingResolution: traced ? toResolutionDto(traced) : null,
        } as EvvBracketDto;
      });
    },

    // ── compliance reads (EvvComplianceReader) ─────────────────────────────────────────────────────────
    async complianceStateForVisit(visitId) {
      return withOrgContextFromRequest(db, async (tx): Promise<EvvComplianceState> => {
        const { checkIn, checkOut, resolutions } = await bracketFacts(tx, visitId);
        return classify({
          hasCheckIn: checkIn !== null,
          hasCheckOut: checkOut !== null,
          hasOpenResolution: resolutions.some((r) => r.status === "open"),
          hasDocumentedClose: resolutions.some((r) =>
            (DOCUMENTED_CLOSE_STATUSES as readonly string[]).includes(r.status),
          ),
        }).compliance;
      });
    },

    async complianceCountsForWindow(window, filters) {
      return withOrgContextFromRequest(db, async (tx): Promise<EvvComplianceDto> => {
        // Population = the window's COMPLETED visits (the billable population ADR-0008 gates; a cancelled/
        // no-show row has no service to verify). Window keyed on the scheduled start, service_date-pruned.
        const conds = [
          eq(VISIT.status, "completed"),
          gte(VISIT.scheduledStartedAt, new Date(window.from)),
          lte(VISIT.scheduledStartedAt, new Date(window.to)),
          gte(VISIT.serviceDate, dateOf(window.from)),
          lte(VISIT.serviceDate, dateOf(window.to)),
        ];
        if (filters?.discipline !== undefined) {
          conds.push(eq(VISIT.assignedDisciplineAtAssignment, filters.discipline));
        }
        const visits = await tx
          .select({ id: VISIT.id })
          .from(VISIT)
          .where(and(...conds));
        if (visits.length === 0) {
          return {
            compliant: 0,
            documentedMissing: 0,
            unresolvedMissing: 0,
            notRequired: 0,
            total: 0,
          };
        }
        const ids = visits.map((v) => v.id);
        // Two batched reads over the id set (inArray — never an N+1): the active event pair + the
        // resolution trail, classified per visit by the shared ADR-0008 rules.
        const events = await tx
          .select({ visitId: EVENT.visitId, kind: EVENT.kind })
          .from(EVENT)
          .where(and(inArray(EVENT.visitId, ids), isNull(EVENT.supersededByEventId)));
        const resolutions = await tx
          .select({ visitId: MR.visitId, status: MR.status })
          .from(MR)
          .where(inArray(MR.visitId, ids));

        const pair = new Map<string, { checkIn: boolean; checkOut: boolean }>();
        for (const e of events) {
          const p = pair.get(e.visitId) ?? { checkIn: false, checkOut: false };
          if (e.kind === "check_in") p.checkIn = true;
          if (e.kind === "check_out") p.checkOut = true;
          pair.set(e.visitId, p);
        }
        const open = new Set<string>();
        const documented = new Set<string>();
        for (const r of resolutions) {
          if (r.status === "open") open.add(r.visitId);
          else if ((DOCUMENTED_CLOSE_STATUSES as readonly string[]).includes(r.status)) {
            documented.add(r.visitId);
          }
        }

        const counts = { compliant: 0, documentedMissing: 0, unresolvedMissing: 0, notRequired: 0 };
        for (const id of ids) {
          const p = pair.get(id) ?? { checkIn: false, checkOut: false };
          const verdict = classify({
            hasCheckIn: p.checkIn,
            hasCheckOut: p.checkOut,
            hasOpenResolution: open.has(id),
            hasDocumentedClose: documented.has(id),
          }).compliance;
          if (verdict === "compliant") counts.compliant++;
          else if (verdict === "documented_missing") counts.documentedMissing++;
          else if (verdict === "unresolved_missing") counts.unresolvedMissing++;
          else counts.notRequired++;
        }
        return { ...counts, total: ids.length };
      });
    },

    // ── aggregator reads (EvvAggregatorReferenceReader) ────────────────────────────────────────────────
    async submissionForVisit(visitId) {
      return withOrgContextFromRequest(
        db,
        async (tx): Promise<EvvAggregatorSubmissionDto | null> => {
          // THE submission is the newest non-cancelled row (the §3.2 Phase-E partial UNIQUE admits one active
          // per state); when every row was cancelled the newest cancelled one is still the honest M25
          // denial-back-link answer.
          const [active] = await tx
            .select()
            .from(AGG)
            .where(and(eq(AGG.visitId, visitId), sql`${AGG.status} <> 'cancelled'`))
            .orderBy(desc(AGG.createdAt))
            .limit(1);
          if (active) return toSubmissionDto(active);
          const [latest] = await tx
            .select()
            .from(AGG)
            .where(eq(AGG.visitId, visitId))
            .orderBy(desc(AGG.createdAt))
            .limit(1);
          return latest ? toSubmissionDto(latest) : null;
        },
      );
    },

    // ── location reads (EvvLocationProvider — the only coordinate-bearing surface, D10) ────────────────
    async lastKnownLocationForClinician(membershipId) {
      return withOrgContextFromRequest(db, async (tx): Promise<EvvLocationDto | null> => {
        const cutoff = new Date(Date.now() - LOCATION_RECENCY_MS);
        const [row] = await tx
          .select({
            membershipId: EVENT.postingMembershipId,
            eventId: EVENT.id,
            visitId: EVENT.visitId,
            accuracyM: EVENT.accuracyM,
            capturedAt: EVENT.capturedAt,
            coordsCipher: EVENT.coordsCipher, // GAP-032 — decoded by toLocationDto
          })
          .from(EVENT)
          .where(and(eq(EVENT.postingMembershipId, membershipId), gte(EVENT.eventAt, cutoff)))
          .orderBy(desc(EVENT.eventAt))
          .limit(1);
        return row ? toLocationDto(row) : null;
      });
    },

    async lastKnownLocationsForOrgShift() {
      return withOrgContextFromRequest(db, async (tx): Promise<EvvLocationDto[]> => {
        const cutoff = new Date(Date.now() - LOCATION_RECENCY_MS);
        const rows = await tx
          .select({
            membershipId: EVENT.postingMembershipId,
            eventId: EVENT.id,
            visitId: EVENT.visitId,
            accuracyM: EVENT.accuracyM,
            capturedAt: EVENT.capturedAt,
            coordsCipher: EVENT.coordsCipher, // GAP-032 — decoded by toLocationDto
          })
          .from(EVENT)
          .where(gte(EVENT.eventAt, cutoff))
          .orderBy(desc(EVENT.eventAt));
        // Newest-first dedupe to one row per clinician (the route service's latestByMember pattern).
        const latestByMember = new Map<string, (typeof rows)[number]>();
        for (const r of rows) {
          if (!latestByMember.has(r.membershipId)) latestByMember.set(r.membershipId, r);
        }
        return [...latestByMember.values()].map(toLocationDto);
      });
    },

    // ── metric reads (EvvMetricsProvider) — REAL tallies, never the route service's hardcoded 1/0 ──────
    async metricWindowCounts(window) {
      return withOrgContextFromRequest(db, async (tx): Promise<EvvMetricWindowCounts> => {
        const from = new Date(window.from);
        const to = new Date(window.to);
        // Per-event tallies — one partition-pruned scan of the window's events.
        const [ev] = await tx
          .select({
            total: sql<string>`count(*)`,
            deviations: sql<string>`count(*) filter (where ${EVENT.gpsQuality} = 'outside_geofence')`,
            spoof: sql<string>`count(*) filter (where ${EVENT.gpsQuality} = 'suspected_spoof')`,
          })
          .from(EVENT)
          .where(and(gte(EVENT.eventAt, from), lte(EVENT.eventAt, to)));
        // Denominator for late-checkout: the window's completed (billable) visits — the same population
        // the compliance breakdown classifies.
        const [vs] = await tx
          .select({ total: sql<string>`count(*)` })
          .from(VISIT)
          .where(
            and(
              eq(VISIT.status, "completed"),
              gte(VISIT.scheduledStartedAt, from),
              lte(VISIT.scheduledStartedAt, to),
              gte(VISIT.serviceDate, dateOf(window.from)),
              lte(VISIT.serviceDate, dateOf(window.to)),
            ),
          );
        // Numerator: visits whose missing-checkout row AUTO-CLOSED when the late check-out arrived
        // (closed_system_checkout_received, M18-F09/ADR-0022) — the only schema fact that means "the
        // checkout came, after the grace window". A still-open missing-checkout is a MISSING checkout
        // (unresolved_missing in the compliance breakdown), not a late one, and is deliberately excluded.
        const [late] = await tx
          .select({ visits: sql<string>`count(distinct ${MR.visitId})` })
          .from(MR)
          .where(
            and(
              eq(MR.kind, "missing_checkout"),
              eq(MR.status, "closed_system_checkout_received"),
              gte(MR.detectedAt, from),
              lte(MR.detectedAt, to),
            ),
          );
        return {
          lateCheckoutVisits: n(late?.visits),
          totalVisits: n(vs?.total),
          geofenceDeviationEvents: n(ev?.deviations),
          suspectedSpoofEvents: n(ev?.spoof),
          totalEvents: n(ev?.total),
        };
      });
    },

    async aggregatorWindowCounts(window, filters) {
      return withOrgContextFromRequest(db, async (tx): Promise<EvvAggregatorWindowCounts> => {
        const conds = [
          gte(AGG.createdAt, new Date(window.from)),
          lte(AGG.createdAt, new Date(window.to)),
        ];
        if (filters?.stateCode !== undefined) conds.push(eq(AGG.stateCode, filters.stateCode));
        const [row] = await tx
          .select({
            accepted: sql<string>`count(*) filter (where ${AGG.status} = 'accepted')`,
            total: sql<string>`count(*)`,
          })
          .from(AGG)
          .where(and(...conds));
        return { accepted: n(row?.accepted), total: n(row?.total) };
      });
    },

    async deviceRegistrationCoverage() {
      return withOrgContextFromRequest(db, async (tx): Promise<EvvDeviceCoverage> => {
        // Denominator: the org's ACTIVE memberships (RLS-scoped). The membership row carries no clinician-
        // role discriminator M18 can reach, so non-field staff are counted — the coverage snapshot reads
        // conservative (never inflated), which is the right direction for a registration-coverage figure.
        const [mem] = await tx
          .select({ total: sql<string>`count(*)` })
          .from(MEM)
          .where(eq(MEM.status, "active"));
        const [dev] = await tx
          .select({ covered: sql<string>`count(distinct ${DEVICE.membershipId})` })
          .from(DEVICE)
          .where(eq(DEVICE.status, "approved"));
        return {
          totalActiveClinicians: n(mem?.total),
          cliniciansWithApprovedDevice: n(dev?.covered),
        };
      });
    },

    // ── verification reads (EvvVerificationProvider — timestamp + lay identity only, NO coordinates) ───
    async arrivalForVisit(visitId) {
      return withOrgContextFromRequest(db, async (tx): Promise<EvvArrival | null> => {
        const [checkIn] = await tx
          .select({
            capturedAt: EVENT.capturedAt,
            postingMembershipId: EVENT.postingMembershipId,
            postingDiscipline: EVENT.postingDisciplineAtRecording,
          })
          .from(EVENT)
          .where(
            and(
              eq(EVENT.visitId, visitId),
              eq(EVENT.kind, "check_in"),
              isNull(EVENT.supersededByEventId),
            ),
          )
          .orderBy(desc(EVENT.eventAt))
          .limit(1);
        if (!checkIn) return null;
        // Lay identity: the FIRST NAME only (membership → user.name, the RLS-scoped membership join). The
        // capture pipeline stores posting_discipline_at_recording as "" (route-service compromise #2), so
        // the visit's captured assignment discipline is the honest fallback.
        const [who] = await tx
          .select({ name: U.name })
          .from(MEM)
          .leftJoin(U, eq(U.id, MEM.userId))
          .where(eq(MEM.id, checkIn.postingMembershipId))
          .limit(1);
        let discipline = checkIn.postingDiscipline;
        if (discipline === "") {
          const [v] = await tx
            .select({ discipline: VISIT.assignedDisciplineAtAssignment })
            .from(VISIT)
            .where(eq(VISIT.id, visitId))
            .limit(1);
          discipline = v?.discipline ?? "";
        }
        const firstName = (who?.name ?? "").trim().split(/\s+/)[0] ?? "";
        return {
          arrivedAt: iso(checkIn.capturedAt),
          clinicianFirstName: firstName,
          discipline,
        } as EvvArrival;
      });
    },

    async verificationSummaryForVisit(visitId) {
      return withOrgContextFromRequest(db, async (tx): Promise<EvvVerificationSummary | null> => {
        const events = await tx
          .select({ kind: EVENT.kind, capturedAt: EVENT.capturedAt })
          .from(EVENT)
          .where(and(eq(EVENT.visitId, visitId), isNull(EVENT.supersededByEventId)))
          .orderBy(asc(EVENT.eventAt));
        const checkIn = events.find((e) => e.kind === "check_in") ?? null;
        const checkOut = events.find((e) => e.kind === "check_out") ?? null;
        // The post-visit summary exists only once the bracket is COMPLETE — a half-bracket is the arrival
        // surface's business, not a summary.
        if (!checkIn || !checkOut) return null;
        const arrivedAt = new Date(checkIn.capturedAt).getTime();
        const departedAt = new Date(checkOut.capturedAt).getTime();
        return {
          arrivedAt: iso(checkIn.capturedAt),
          departedAt: iso(checkOut.capturedAt),
          durationMinutes: Math.max(0, Math.round((departedAt - arrivedAt) / 60_000)),
        } as EvvVerificationSummary;
      });
    },
  };
}
