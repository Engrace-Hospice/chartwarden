// apps/backend/src/modules/14-idg/seams/drizzle-store.ts — the FULL Drizzle implementation of M14's
// seam store (TASK-002; previously a partial overlay that spread the in-memory slice).
//
// Every {@link IdgSeamStore} method now answers from the real `idg_*` tables — nothing falls back to
// the in-memory Map. `decisionsForCarePlan` (formerly the one refused read, via the retired
// IdgSeamSchemaGapError) answers over `idg_decision.care_plan_id` since mig 0155: the write path
// stamps the link at record time from the patient's ACTIVE plan (M7 CarePlanReader seam), and a row
// whose link is NULL simply never matches — an honest under-count, never a fabricated link.
//
// TENANCY, two shapes (the M21 store-drizzle precedent):
//   • `packetById` / `decisionsForMeeting` / `meetingsForLocation` / `cadenceForAdmission` take NO
//     org argument — they run under the CONSUMER'S ambient request context via
//     `withOrgContextFromRequest`, so RLS pins `app.org_id` from whoever is asking (M22's render
//     caller's org, never a tenant switch). Called outside a request scope they THROW rather than
//     read unscoped — the correct direction for a PHI surface.
//   • `cadenceCountsForOrg` takes an explicit `organizationId` (the M30 recompute worker has no
//     request scope) — it SELF-SCOPES via `withOrgContext`, with the explicit `organization_id`
//     predicate as the second wall.
//
// PARTITIONED PARENT. `idg_patient_packet` is RANGE-partitioned on `built_at` (D12), so the id-only
// `packetById` fans out across every partition — the seam consumer has an id and no time window, and
// inventing one would silently miss last month's packet (the M21 trade, taken knowingly).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import type {
  DisciplineKey,
  DisciplineViewBlock,
  IdgDecisionDto,
  IdgMeetingDigest,
  PacketSnapshot,
} from "@wardenx/types";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, notInArray, sql } from "drizzle-orm";
import type { IdgCadenceAdherence, IdgSeamStore, StoredIdgPacket } from "./store";

const M = schema.idgMeeting;
const ATT = schema.idgAttendance;
const DEC = schema.idgDecision;
const PKT = schema.idgPatientPacket;

/** The actor id the org-level read's withOrgContext envelope carries — an aggregate read has no acting user. */
const IDG_READER_SYSTEM_USER_ID = "";

/** Coerce a Drizzle timestamp to an ISO instant (non-null column). */
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);
/** Same, nullable. */
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));

const MS_PER_DAY = 86_400_000;

/** Project an `idg_decision` row (patient-scoped) onto the §4.8 read DTO. */
const decisionDto = (r: typeof DEC.$inferSelect): IdgDecisionDto => ({
  id: r.id,
  organizationId: r.organizationId,
  meetingId: r.idgMeetingId,
  // Callers filter to patient-scoped rows before projecting (the DTO's patientId is non-null; a
  // patient-less team-note carries no seam projection — the same line the outbox draws: neither
  // `m14.decision.recorded_open` nor `idg.decision_recorded` emits for a null patient).
  patientId: r.patientId as string,
  decisionKind: r.decisionKind,
  status: r.status,
  wasQuorate: r.wasQuorate,
  recordedByMembershipId: r.recordedByMembershipId,
  recordedAt: iso(r.recordedAt),
  emittedAt: isoN(r.emittedAt),
  supersededByDecisionId: r.supersededByDecisionId ?? null,
});

/**
 * Build the production Drizzle-backed {@link IdgSeamStore}. No in-memory fallback: every method —
 * including the by-care-plan read, since mig 0155 — answers from M14's tables.
 */
export function createDrizzleIdgSeamStore(db: DbClient): IdgSeamStore {
  return {
    // ── packet reads (IdgPacketProvider) ───────────────────────────────────────────────────────────
    async packetById(packetId): Promise<StoredIdgPacket | null> {
      return withOrgContextFromRequest(db, async (tx) => {
        const t = tx as unknown as DbClient;
        const [r] = await t.select().from(PKT).where(eq(PKT.id, packetId)).limit(1);
        if (!r) return null;
        return {
          packetId: r.id,
          meetingId: r.idgMeetingId,
          patientId: r.patientId,
          // The worker persists the §2.4 D1 snapshot / §2.5 D7 view blocks as jsonb; the columns are
          // typed `jsonb` so the stored shapes are re-asserted here (the write path is the guarantor).
          snapshot: r.builtSnapshot as PacketSnapshot,
          disciplineViews: r.disciplineViews as Record<DisciplineKey, DisciplineViewBlock>,
          coverSummaryLayer1: r.coverSummaryLayer1,
          coverSummaryLayer2: r.coverSummaryLayer2 ?? null,
          frozenAt: isoN(r.frozenAt),
        };
      });
    },

    // ── decision reads (IdgDecisionProvider) ───────────────────────────────────────────────────────
    async decisionsForCarePlan(carePlanId): Promise<ReadonlyArray<IdgDecisionDto>> {
      // Answers over `idg_decision.care_plan_id` (mig 0155): stamped at record time from the
      // patient's ACTIVE plan via M7's CarePlanReader seam — never derived from the decision's
      // patient here, which would return every decision for the PATIENT (including ones for a prior
      // plan) and silently corrupt M30's decision-to-careplan-update latency measure. A row whose
      // link is NULL (pre-0155, or no active plan resolved at record time) simply never matches.
      return withOrgContextFromRequest(db, async (tx) => {
        const t = tx as unknown as DbClient;
        const rows = await t
          .select()
          .from(DEC)
          // Patient-scoped only: the DTO's `patientId` is non-null, matching the outbox emit line.
          .where(and(eq(DEC.carePlanId, carePlanId), isNotNull(DEC.patientId)))
          .orderBy(asc(DEC.recordedAt));
        return rows.map(decisionDto);
      });
    },
    async decisionsForMeeting(meetingId): Promise<ReadonlyArray<IdgDecisionDto>> {
      return withOrgContextFromRequest(db, async (tx) => {
        const t = tx as unknown as DbClient;
        const rows = await t
          .select()
          .from(DEC)
          // Patient-scoped only: the DTO's `patientId` is non-null, matching the outbox emit line.
          .where(and(eq(DEC.idgMeetingId, meetingId), isNotNull(DEC.patientId)))
          .orderBy(asc(DEC.recordedAt));
        return rows.map(decisionDto);
      });
    },

    // ── schedule reads (IdgScheduleProvider) ───────────────────────────────────────────────────────
    async meetingsForLocation(locationId, range): Promise<ReadonlyArray<IdgMeetingDigest>> {
      return withOrgContextFromRequest(db, async (tx) => {
        const t = tx as unknown as DbClient;
        const rows = await t
          .select()
          .from(M)
          .where(
            and(
              eq(M.locationId, locationId),
              // Inclusive both ends — the in-memory slice's `>= fromIso && <= toIso` semantics
              // (also the route service's listSchedule window shape).
              gte(M.scheduledStart, new Date(range.fromIso)),
              lte(M.scheduledStart, new Date(range.toIso)),
            ),
          )
          .orderBy(asc(M.scheduledStart));
        if (rows.length === 0) return [];
        const ids = rows.map((r) => r.id);
        // Digest counts in two batched round-trips, never an N+1.
        const decCounts = await t
          .select({ meetingId: DEC.idgMeetingId, n: sql<number>`count(*)::int` })
          .from(DEC)
          .where(inArray(DEC.idgMeetingId, ids))
          .groupBy(DEC.idgMeetingId);
        // "Attendees" = the quorum present-set (not absent/excused) — the same filter the route
        // service's presentDisciplines applies; a no-show is not an attendee.
        const attCounts = await t
          .select({ meetingId: ATT.idgMeetingId, n: sql<number>`count(*)::int` })
          .from(ATT)
          .where(
            and(
              inArray(ATT.idgMeetingId, ids),
              notInArray(ATT.status, ["absent", "excused"] as never),
            ),
          )
          .groupBy(ATT.idgMeetingId);
        const decBy = new Map(decCounts.map((c) => [c.meetingId, Number(c.n) || 0]));
        const attBy = new Map(attCounts.map((c) => [c.meetingId, Number(c.n) || 0]));
        return rows.map(
          (r): IdgMeetingDigest => ({
            id: r.id,
            organizationId: r.organizationId,
            locationId: r.locationId,
            status: r.status,
            scheduledStart: iso(r.scheduledStart),
            scheduledEnd: iso(r.scheduledEnd),
            // The route service's toMeetingView line: adjourned-at is `actual_end`, only once adjourned.
            adjournedAt: r.status === "adjourned" ? isoN(r.actualEnd) : null,
            decisionCount: decBy.get(r.id) ?? 0,
            attendeeCount: attBy.get(r.id) ?? 0,
          }),
        );
      });
    },

    async cadenceForAdmission(admissionId): Promise<IdgCadenceAdherence | null> {
      return withOrgContextFromRequest(db, async (tx) => {
        const t = tx as unknown as DbClient;
        const pkts = await t
          .select({
            meetingId: PKT.idgMeetingId,
            builtAt: PKT.builtAt,
            frozenAt: PKT.frozenAt,
            sinceCursorIso: PKT.sinceCursorIso,
          })
          .from(PKT)
          .where(eq(PKT.admissionId, admissionId));
        // No visible IDG context under the consumer's tenant ⇒ null (the provider maps it to the
        // vacuously-compliant shape).
        if (pkts.length === 0) return null;

        // One packet per meeting — the latest build wins (a rebuild inserts a fresh partition row);
        // the getPatientIdgHistory dedupe, verbatim.
        const byMeeting = new Map<string, { builtAt: Date; frozenAt: Date | null }>();
        let startMs = Number.POSITIVE_INFINITY;
        for (const p of pkts) {
          // The admission anchor is the EARLIEST `since_cursor_iso` — the first packet's cursor is
          // the admission's `activated_at` by construction (§2.4 D1 meta.sinceCursorIso: "last IDG
          // adjourned_at OR admission.activated_at"), an M14-owned fact so no M6 table is read.
          const cursorMs = Date.parse(p.sinceCursorIso);
          if (!Number.isNaN(cursorMs) && cursorMs < startMs) startMs = cursorMs;
          const prev = byMeeting.get(p.meetingId);
          if (!prev || p.builtAt > prev.builtAt) {
            byMeeting.set(p.meetingId, { builtAt: p.builtAt, frozenAt: p.frozenAt });
          }
        }
        // Defensive: an unparseable cursor (never written by the builder) falls back to the earliest
        // build instant — later than activation, so it can only UNDER-count the day span, never score
        // a breach that did not happen.
        if (!Number.isFinite(startMs)) {
          startMs = Math.min(...pkts.map((p) => p.builtAt.getTime()));
        }

        // A COMPLETED review = a meeting whose packet froze (`adjournMeeting` stamps `frozen_at` at
        // the commit point — the review-completion fact the write path actually maintains).
        const reviewsMs = [...byMeeting.values()]
          .map((v) => v.frozenAt)
          .filter((d): d is Date => d !== null)
          .map((d) => d.getTime())
          .sort((a, b) => a - b);

        // ★ INTERPRETATION (flagged): `longestGapDays` spans admission-start → first review, each
        //   consecutive review pair, AND last review → now (the OPEN gap counts) — an admission
        //   overdue TODAY must not read compliant just because its past gaps were clean. Zero reviews
        //   ⇒ the whole span so far is the gap. Revisit against the M14-F01 cron once its breach math
        //   lands (compromise #5 in idg-route-service-db.ts).
        const nowMs = Date.now();
        const anchors = [startMs, ...reviewsMs, nowMs];
        let longestGapMs = 0;
        for (let i = 1; i < anchors.length; i += 1) {
          const gap = (anchors[i] ?? 0) - (anchors[i - 1] ?? 0);
          if (gap > longestGapMs) longestGapMs = gap;
        }
        return {
          admissionId,
          // Day 1 is the admission day (floor of the elapsed span, plus one).
          admissionDayCount: Math.max(1, Math.floor((nowMs - startMs) / MS_PER_DAY) + 1),
          reviewCount: reviewsMs.length,
          longestGapDays: Math.max(0, Math.floor(longestGapMs / MS_PER_DAY)),
        };
      });
    },

    /**
     * Last meeting that took place and reviewed this patient. "Took place" = `status = 'adjourned'` AND a
     * real `actual_start` (a scheduled / live / cancelled meeting never counts); "reviewed" = a FROZEN
     * packet row for the patient (freeze is stamped at adjournment). Self-scopes under the explicit org
     * (`withOrgContext`, RLS) with `organization_id` as the second wall. Selects id/instant/status only.
     */
    lastMeetingForPatient(organizationId, patientId) {
      return withOrgContext(
        db,
        { organizationId, userId: IDG_READER_SYSTEM_USER_ID },
        async (tx) => {
          const [row] = await tx
            .select({ id: M.id, actualStart: M.actualStart, status: M.status })
            .from(M)
            .where(
              and(
                eq(M.organizationId, organizationId),
                eq(M.status, "adjourned"),
                isNotNull(M.actualStart),
                sql`exists (select 1 from ${PKT} where ${PKT.organizationId} = ${organizationId}
                  and ${PKT.idgMeetingId} = ${M.id} and ${PKT.patientId} = ${patientId}
                  and ${PKT.frozenAt} is not null)`,
              ),
            )
            .orderBy(desc(M.actualStart))
            .limit(1);
          if (!row || row.actualStart === null) return null;
          return { meetingId: row.id, heldAt: iso(row.actualStart), status: row.status };
        },
      );
    },

    /**
     * ORG-LEVEL IDG meeting-cadence tally over a SCHEDULED-START window — M30's
     * `idg_cadence_adherence` input. Denominator = meetings SCHEDULED to start inside `[from, to)` —
     * the cadence cycles that came due — numerator = those actually convened within their scheduled
     * slot.
     *
     * ★ INTERPRETATION (flagged): "within cadence" is read as `actual_start IS NOT NULL AND
     *   actual_start <= scheduled_end`, i.e. the meeting happened inside the window it was scheduled
     *   for. Two alternatives were rejected: counting `status = 'completed'` alone would score a
     *   meeting convened days late as adherent, and allowing any `actual_start` would do the same. A
     *   cancelled or never-convened meeting stays in the DENOMINATOR — a cadence cycle that was
     *   skipped is exactly what this measure exists to catch, so it must not drop out of the
     *   population. Revisit if the CoP 418.56 IDG-cadence guidance is more specific.
     *
     * Returns the PAIR, never a rate: an empty window (0/0) must SUPPRESS rather than score perfect
     * cadence.
     */
    cadenceCountsForOrg(organizationId, window) {
      return withOrgContext(
        db,
        { organizationId, userId: IDG_READER_SYSTEM_USER_ID },
        async (tx) => {
          const [row] = await tx
            .select({
              denominator: sql<number>`count(*)::int`,
              numerator: sql<number>`count(*) filter (where ${M.actualStart} is not null and ${M.actualStart} <= ${M.scheduledEnd})::int`,
            })
            .from(M)
            .where(
              and(
                eq(M.organizationId, organizationId),
                gte(M.scheduledStart, new Date(window.from)),
                lt(M.scheduledStart, new Date(window.to)),
              ),
            );
          return {
            numerator: Number(row?.numerator) || 0,
            denominator: Number(row?.denominator) || 0,
          };
        },
      );
    },
  };
}
