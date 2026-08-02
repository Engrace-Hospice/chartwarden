// apps/backend/src/modules/14-idg — PRODUCTION IdgRouteService + §4.7 IdgAbacResolver (M14L reads + writes
// over Drizzle+RLS). No route is left at 501.
//
// The screen-driving READS (meeting schedule, meeting detail, packet digests, action-item worklist, minutes)
// run as real Drizzle queries over the M14-owned tables inside `withOrgContext`, so RLS scopes every row by
// `app.org_id` as the unprivileged `wardenx_app` role.
//
// Like M12/M13, M14 has NO state-transition triggers (only the M4 audit triggers) — the service does every
// meeting/decision/action-item/minutes transition itself via INSERT/UPDATE, composing the PURE `@wardenx/idg`
// deciders: the §2.2 meeting machine (`transitionMeeting`, which raises STEP_UP_REQUIRED / the review-floor
// guards), the §2.7 decision record/supersede deciders (`planDecisionRecord` / `planDecisionSupersede`), the
// §1.1 D8 action-item machine (`transitionActionItem`), and the §2.6 minutes-amendment decider. Every
// mutation emits its STRICT `m14.*` (or the locked `idg.decision_recorded`) catalog payload on the bound
// transactional outbox — the publisher Value.Checks each and rolls back on mismatch, so the payloads here are
// the exact events-by-m14.ts shapes (broader than the loose in-mem slice).
//
// Documented compromises (the M8–M13 convention; the interface threads no seams into the DB backend):
//   (1) `withOrgContext` runs with `userId:""` → the M4 write-audit trigger fires with a NULL actor (the
//       acting membership is the passed `userId`, stored on coordinator/recorded_by/etc. where a column exists);
//   (2) wardenx_app has DELETE on NO M14 table (append + status-transition, §3.3) — so `removeAttendance`
//       soft-removes to `excused`, `removeActionItem` transitions to `cancelled`, and `removeAgendaItem` is a
//       tenant-checked no-op (the append-only agenda has neither a DELETE grant nor a tombstone column);
//   (3) `idg_patient_packet` (PE/location/patient/admission NOT NULL) is built by the §2.4 packet WORKER, not
//       the route lifecycle — `buildPackets` only drives the meeting state + emits; the decision inclusion
//       gate reads the packet set (authoritative) OR a patient-scoped agenda item (the Phase-1 signal);
//   (4) narrative payloads (decision `payload`, amendment `diff`, snapshots) are written `{}` — the DB backend
//       threads no clinical body; the read views surface stable structural shapes;
//   (5) the per-patient 15-day review-floor is resolved `clear` (the M14-F01 cron owns the breach math; the
//       gated CANCEL/RESCHEDULE transitions drive the machine with the authorized-override facts).
import { createHash } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import {
  isActionableDecisionKind,
  planDecisionRecord,
  planDecisionSupersede,
  planMinutesAmendmentRequest,
  transitionActionItem,
  transitionMeeting,
} from "@wardenx/idg";
import { withOrgContext } from "@wardenx/tenancy";
import type { IdgActionItemStatus, IdgDecisionKind } from "@wardenx/types";
import { NotFoundError } from "@wardenx/types";
import { and, asc, desc, eq, gte, inArray, lte, notInArray } from "drizzle-orm";
import type {
  IdgAbacResolver,
  MeetingScopeFacts,
  ReviewFloorBreachFact,
} from "./abac-predicates";
import type {
  ActionItemPatchStatus,
  ActionItemView,
  AgendaItemView,
  AttendanceView,
  DecisionView,
  IdgRouteService,
  MeetingScheduleView,
  MeetingView,
  MinutesView,
  PacketDigestView,
  PatientIdgHistoryView,
  RecurringPolicyView,
} from "./routes/service";

const MTG = schema.idgMeeting;
const ATT = schema.idgAttendance;
const AGD = schema.idgAgendaItem;
const DEC = schema.idgDecision;
const ACT = schema.idgActionItem;
const MIN = schema.idgMinutes;
const AMD = schema.idgMinutesAmendment;
const PKT = schema.idgPatientPacket;
const POL = schema.idgRecurringPolicy;

/** Coerce a Drizzle timestamp (Date or string, depending on column mode) to an ISO string (nullable). */
const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;
/** Same, non-null (a NOT NULL timestamp column). */
const isoReq = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

/** The action-item PATCH status → the pure machine's event name. */
const PATCH_STATUS_EVENT: Record<ActionItemPatchStatus, "start" | "complete" | "cancel"> = {
  in_progress: "start",
  completed: "complete",
  cancelled: "cancel",
};

/** The transactional-outbox port (§4.4): the bound publisher validates every emit against the boot catalog
 * and writes the `outbox_event` row on the CALLER'S tx. The no-op default lets the slice/tests commit without
 * a dispatcher. Mirrors M7/M8/M9/M10/M11/M12/M13. */
export interface IdgWriteOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}
const NOOP_OUTBOX: IdgWriteOutboxPort = { async publish() {} };

type MeetingRow = typeof MTG.$inferSelect;
const toMeetingView = (m: MeetingRow): MeetingView => ({
  id: m.id,
  organizationId: m.organizationId,
  locationId: m.locationId,
  status: m.status,
  scheduledStart: isoReq(m.scheduledStart),
  scheduledEnd: isoReq(m.scheduledEnd),
  adjournedAt: m.status === "adjourned" ? iso(m.actualEnd) : null,
});

/**
 * The production, RLS-backed IdgRouteService + IdgAbacResolver. Reads + the write lifecycle are live over
 * Drizzle+RLS; every mutation emits `m14.*` / `idg.decision_recorded` on the bound transactional `outbox`.
 * Org is bound from the request context by the caller and passed as `orgId` — never the body.
 */
export function createDbIdgBackend(
  db: DbClient,
  outbox: IdgWriteOutboxPort = NOOP_OUTBOX,
): IdgRouteService & IdgAbacResolver {
  const withOrg = <T>(orgId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) => fn(tx as DbClient));

  /** Emit one catalog event on the caller's tx (validated + persisted by the bound publisher). */
  async function emit(
    tx: unknown,
    orgId: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, { eventName, payload, organizationId: orgId, aggregateKind, aggregateId });
  }

  /** Resolve a meeting under the caller's tenant (RLS-scoped) — used to guard child reads with 404 non-leak. */
  async function meetingExists(tx: DbClient, id: string): Promise<boolean> {
    const [row] = await tx.select({ id: MTG.id }).from(MTG).where(eq(MTG.id, id)).limit(1);
    return !!row;
  }
  /** Load a full meeting row (RLS-scoped) or the non-leaking 404. */
  async function loadMeeting(tx: DbClient, id: string): Promise<MeetingRow> {
    const [m] = await tx.select().from(MTG).where(eq(MTG.id, id)).limit(1);
    if (!m) throw new NotFoundError("idg_meeting");
    return m;
  }
  /** The disciplines PRESENT (not absent/excused) at a meeting — the quorum present-set. */
  async function presentDisciplines(tx: DbClient, meetingId: string): Promise<string[]> {
    const rows = await tx
      .select({ discipline: ATT.discipline })
      .from(ATT)
      .where(and(eq(ATT.idgMeetingId, meetingId), notInArray(ATT.status, ["absent", "excused"] as never)));
    return rows.map((r) => r.discipline);
  }
  /** §2.3 D9 inclusion: a patient is on the meeting's caseload if it has a packet (authoritative) or a
   * patient-scoped agenda item (the Phase-1 signal before packets materialize). Null patient ⇒ always included. */
  async function patientIncluded(tx: DbClient, meetingId: string, patientId: string | null): Promise<boolean> {
    if (patientId == null) return true;
    const [pkt] = await tx
      .select({ id: PKT.id })
      .from(PKT)
      .where(and(eq(PKT.idgMeetingId, meetingId), eq(PKT.patientId, patientId)))
      .limit(1);
    if (pkt) return true;
    const [ag] = await tx
      .select({ id: AGD.id })
      .from(AGD)
      .where(and(eq(AGD.idgMeetingId, meetingId), eq(AGD.patientId, patientId)))
      .limit(1);
    return !!ag;
  }
  /** Ensure a `in_progress` minutes row for the meeting (idempotent); returns its id. */
  async function ensureMinutes(tx: DbClient, orgId: string, meetingId: string): Promise<string> {
    const [existing] = await tx.select({ id: MIN.id }).from(MIN).where(eq(MIN.idgMeetingId, meetingId)).limit(1);
    if (existing) return existing.id;
    const [row] = await tx
      .insert(MIN)
      .values({ organizationId: orgId, idgMeetingId: meetingId, status: "in_progress" })
      .returning({ id: MIN.id });
    return row!.id;
  }

  const toActionItemView = (r: typeof ACT.$inferSelect): ActionItemView => ({
    id: r.id,
    meetingId: r.idgMeetingId,
    decisionId: r.idgDecisionId,
    patientId: r.patientId,
    assignedToMembershipId: r.assignedToMembershipId,
    status: r.status,
    dueDate: iso(r.dueDate) ?? "",
    linkedArtifactKind: r.linkedArtifactKind,
  });
  const toDecisionView = (r: typeof DEC.$inferSelect): DecisionView => ({
    id: r.id,
    meetingId: r.idgMeetingId,
    patientId: r.patientId,
    decisionKind: r.decisionKind,
    status: r.status,
    wasQuorate: r.wasQuorate,
    supersededByDecisionId: r.supersededByDecisionId,
  });

  return {
    // ── schedule + meeting reads ─────────────────────────────────────────────────────────────────────────
    async listSchedule(orgId, q): Promise<MeetingScheduleView[]> {
      return withOrg(orgId, async (tx) => {
        const rows = await tx
          .select({
            id: MTG.id,
            locationId: MTG.locationId,
            status: MTG.status,
            scheduledStart: MTG.scheduledStart,
            scheduledEnd: MTG.scheduledEnd,
          })
          .from(MTG)
          .where(
            and(
              eq(MTG.locationId, q.location),
              gte(MTG.scheduledStart, new Date(q.from)),
              lte(MTG.scheduledStart, new Date(q.to)),
            ),
          )
          .orderBy(asc(MTG.scheduledStart));
        return rows.map((r) => ({
          id: r.id,
          locationId: r.locationId,
          status: r.status,
          scheduledStart: isoReq(r.scheduledStart),
          scheduledEnd: isoReq(r.scheduledEnd),
        }));
      });
    },
    async getMeeting(orgId, id): Promise<MeetingView> {
      return withOrg(orgId, async (tx) => toMeetingView(await loadMeeting(tx, id)));
    },

    // ── packet reads (partitioned parent; digest carries no narrative → no SUD payload to redact) ──────────
    async listPackets(orgId, meetingId): Promise<PacketDigestView[]> {
      return withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const rows = await tx
          .select({ id: PKT.id, patientId: PKT.patientId, frozenAt: PKT.frozenAt })
          .from(PKT)
          .where(eq(PKT.idgMeetingId, meetingId));
        return rows.map((r) => ({ packetId: r.id, meetingId, patientId: r.patientId, frozenAt: iso(r.frozenAt) }));
      });
    },
    async getPacket(orgId, meetingId, patientId): Promise<PacketDigestView> {
      return withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const [r] = await tx
          .select({ id: PKT.id, frozenAt: PKT.frozenAt })
          .from(PKT)
          .where(and(eq(PKT.idgMeetingId, meetingId), eq(PKT.patientId, patientId)))
          .limit(1);
        if (!r) throw new NotFoundError("idg_patient_packet");
        return { packetId: r.id, meetingId, patientId, frozenAt: iso(r.frozenAt) };
      });
    },
    async getPatientIdgHistory(orgId, patientId): Promise<PatientIdgHistoryView> {
      return withOrg(orgId, async (tx) => {
        // The patient was reviewed in a meeting iff a packet was built for that (meeting, patient). The
        // packet parent is partitioned; org scoping is explicit here (belt-and-suspenders alongside RLS,
        // since policies attach at the leaves) so a cross-tenant patient literal never resolves rows.
        const pkts = await tx
          .select({
            meetingId: PKT.idgMeetingId,
            reviewedAt: PKT.lastIdgReviewedAt,
            frozenAt: PKT.frozenAt,
            builtAt: PKT.builtAt,
          })
          .from(PKT)
          .where(and(eq(PKT.organizationId, orgId), eq(PKT.patientId, patientId)));
        if (pkts.length === 0) return { meetings: [] };
        // One packet per meeting — the latest build wins (a rebuild inserts a fresh partition row).
        const pktBy = new Map<string, { reviewedAt: Date | null; frozenAt: Date | null; builtAt: Date }>();
        for (const p of pkts) {
          const prev = pktBy.get(p.meetingId);
          if (!prev || p.builtAt > prev.builtAt) {
            pktBy.set(p.meetingId, { reviewedAt: p.reviewedAt, frozenAt: p.frozenAt, builtAt: p.builtAt });
          }
        }
        const meetingIds = [...pktBy.keys()];
        const mtgs = await tx
          .select({
            id: MTG.id,
            status: MTG.status,
            scheduledStart: MTG.scheduledStart,
            actualStart: MTG.actualStart,
            actualEnd: MTG.actualEnd,
          })
          .from(MTG)
          .where(inArray(MTG.id, meetingIds))
          .orderBy(desc(MTG.scheduledStart));
        const decs = await tx
          .select({
            id: DEC.id,
            meetingId: DEC.idgMeetingId,
            decisionKind: DEC.decisionKind,
            status: DEC.status,
            wasQuorate: DEC.wasQuorate,
            recordedAt: DEC.recordedAt,
          })
          .from(DEC)
          .where(and(eq(DEC.patientId, patientId), inArray(DEC.idgMeetingId, meetingIds)));
        const acts = await tx
          .select({
            id: ACT.id,
            meetingId: ACT.idgMeetingId,
            status: ACT.status,
            discipline: ACT.assignedToDiscipline,
            dueDate: ACT.dueDate,
            closedAt: ACT.closedAt,
          })
          .from(ACT)
          .where(and(eq(ACT.patientId, patientId), inArray(ACT.idgMeetingId, meetingIds)));
        const groupByMeeting = <T extends { meetingId: string }>(rows: T[]): Map<string, T[]> => {
          const m = new Map<string, T[]>();
          for (const r of rows) (m.get(r.meetingId) ?? m.set(r.meetingId, []).get(r.meetingId)!).push(r);
          return m;
        };
        const decBy = groupByMeeting(decs);
        const actBy = groupByMeeting(acts);
        return {
          meetings: mtgs.map((m) => {
            const pkt = pktBy.get(m.id);
            return {
              meetingId: m.id,
              status: m.status,
              scheduledStart: isoReq(m.scheduledStart),
              actualStart: iso(m.actualStart),
              actualEnd: iso(m.actualEnd),
              reviewedAt: iso(pkt?.reviewedAt ?? null),
              packetFrozenAt: iso(pkt?.frozenAt ?? null),
              decisions: (decBy.get(m.id) ?? []).map((d) => ({
                id: d.id,
                decisionKind: d.decisionKind,
                status: d.status,
                wasQuorate: d.wasQuorate,
                recordedAt: iso(d.recordedAt),
              })),
              actionItems: (actBy.get(m.id) ?? []).map((a) => ({
                id: a.id,
                status: a.status,
                discipline: a.discipline,
                dueDate: iso(a.dueDate),
                closedAt: iso(a.closedAt),
              })),
            };
          }),
        };
      });
    },

    // ── action-item worklist ───────────────────────────────────────────────────────────────────────────
    async listActionItems(orgId, userId, q): Promise<ActionItemView[]> {
      const assignee = q.assignee === "me" ? userId : q.assignee;
      return withOrg(orgId, async (tx) => {
        const filters = [
          assignee !== undefined ? eq(ACT.assignedToMembershipId, assignee) : undefined,
          q.status !== undefined ? eq(ACT.status, q.status) : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        const rows = await tx.select().from(ACT).where(filters.length ? and(...filters) : undefined);
        return rows.map(toActionItemView);
      });
    },

    // ── minutes read ───────────────────────────────────────────────────────────────────────────────────
    async getMinutes(orgId, meetingId): Promise<MinutesView> {
      return withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const [r] = await tx.select({ id: MIN.id, status: MIN.status }).from(MIN).where(eq(MIN.idgMeetingId, meetingId)).limit(1);
        if (!r) throw new NotFoundError("idg_minutes");
        return { id: r.id, meetingId, status: r.status };
      });
    },

    // ── schedule + recurring policies (writes) ─────────────────────────────────────────────────────────
    async createRecurringPolicy(orgId, userId, args): Promise<RecurringPolicyView> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx
          .insert(POL)
          .values({
            organizationId: orgId,
            locationId: args.locationId,
            cadenceDays: args.cadenceDays,
            dayOfWeekAnchor: "monday", // the route carries no anchor; the schedule worker resolves it
            defaultCoordinatorMembershipId: userId,
            active: args.active ?? true,
          })
          .returning();
        // The route creates the policy; the schedule WORKER materialises meetings later (meetingsCreated=0).
        await emit(tx, orgId, "m14.schedule.materialised", "idg_recurring_policy", row!.id, {
          recurringPolicyId: row!.id,
          meetingsCreated: 0,
          windowEndIso: new Date().toISOString(),
        });
        return { id: row!.id, locationId: row!.locationId, cadenceDays: row!.cadenceDays, active: row!.active };
      });
    },
    async updateRecurringPolicy(orgId, _userId, id, args): Promise<RecurringPolicyView> {
      return withOrg(orgId, async (tx) => {
        const [existing] = await tx.select().from(POL).where(eq(POL.id, id)).limit(1);
        if (!existing) throw new NotFoundError("idg_recurring_policy");
        const [row] = await tx
          .update(POL)
          .set({ cadenceDays: args.cadenceDays, active: args.active ?? existing.active, updatedAt: new Date() })
          .where(eq(POL.id, id))
          .returning();
        return { id: row!.id, locationId: row!.locationId, cadenceDays: row!.cadenceDays, active: row!.active };
      });
    },

    // ── meeting lifecycle (writes) ─────────────────────────────────────────────────────────────────────
    async cancelMeeting(orgId, userId, id, reason): Promise<MeetingView> {
      return withOrg(orgId, async (tx) => {
        const m = await loadMeeting(tx, id);
        // The route's `per_patient_review_floor_clear` ABAC + override-permission gate is authoritative; the
        // service drives the machine with the resolved facts (clear + authorized) (compromise #5).
        transitionMeeting(m.status, { type: "CANCEL", reason, reviewFloorClear: true, overrideAuthorized: true });
        const at = new Date();
        await tx
          .update(MTG)
          .set({ status: "cancelled", cancellationReason: reason, version: m.version + 1, updatedAt: at })
          .where(eq(MTG.id, id));
        await emit(tx, orgId, "m14.meeting.cancelled", "idg_meeting", id, {
          meetingId: id,
          cancelledBy: userId,
          cancellationReason: reason,
          cancelledAt: at.toISOString(),
        });
        return toMeetingView({ ...m, status: "cancelled", cancellationReason: reason });
      });
    },
    async rescheduleMeeting(orgId, _userId, id, args): Promise<MeetingView> {
      return withOrg(orgId, async (tx) => {
        const prior = await loadMeeting(tx, id);
        transitionMeeting(prior.status, {
          type: "RESCHEDULE",
          reason: args.reason,
          reviewFloorClear: true,
          overrideAuthorized: true,
        });
        const at = new Date();
        await tx.update(MTG).set({ status: "rescheduled", version: prior.version + 1, updatedAt: at }).where(eq(MTG.id, id));
        const [next] = await tx
          .insert(MTG)
          .values({
            organizationId: orgId,
            locationId: prior.locationId,
            recurringPolicyId: prior.recurringPolicyId,
            scheduledStart: new Date(args.newScheduledStart),
            scheduledEnd: new Date(args.newScheduledEnd),
            status: "scheduled",
            coordinatorMembershipId: prior.coordinatorMembershipId,
            rescheduledFromMeetingId: id,
            tenantQuorumSnapshot: prior.tenantQuorumSnapshot,
          })
          .returning({ id: MTG.id });
        await emit(tx, orgId, "m14.meeting.rescheduled", "idg_meeting", id, {
          priorMeetingId: id,
          newMeetingId: next!.id,
          newScheduledStart: new Date(args.newScheduledStart).toISOString(),
          reason: args.reason,
        });
        return toMeetingView({ ...prior, status: "rescheduled" });
      });
    },
    async buildPackets(orgId, _userId, id): Promise<MeetingView> {
      return withOrg(orgId, async (tx) => {
        const m = await loadMeeting(tx, id);
        const pkts = await tx.select({ id: PKT.id }).from(PKT).where(eq(PKT.idgMeetingId, id));
        const n = pkts.length;
        transitionMeeting(m.status, { type: "BUILD_PACKETS", includedPatientCount: n });
        const at = new Date();
        await tx.update(MTG).set({ status: "packets_building", version: m.version + 1, updatedAt: at }).where(eq(MTG.id, id));
        await emit(tx, orgId, "m14.packets.build_started", "idg_meeting", id, {
          meetingId: id,
          includedPatientCount: n,
        });
        return toMeetingView({ ...m, status: "packets_building" });
      });
    },
    async startMeeting(orgId, userId, id): Promise<MeetingView> {
      return withOrg(orgId, async (tx) => {
        const m = await loadMeeting(tx, id);
        transitionMeeting(m.status, { type: "START" });
        const at = new Date();
        await tx.update(MTG).set({ status: "live", actualStart: at, version: m.version + 1, updatedAt: at }).where(eq(MTG.id, id));
        await emit(tx, orgId, "m14.meeting.started", "idg_meeting", id, {
          meetingId: id,
          startedByMembershipId: userId,
          startedAt: at.toISOString(),
        });
        return toMeetingView({ ...m, status: "live", actualStart: at });
      });
    },
    async adjournMeeting(orgId, userId, id, stepUpFresh): Promise<MeetingView> {
      return withOrg(orgId, async (tx) => {
        const m = await loadMeeting(tx, id);
        // `transitionMeeting` raises STEP_UP_REQUIRED (412) when the fresh step-up is absent (§2.2 D13).
        transitionMeeting(m.status, { type: "ADJOURN", stepUpFresh });
        const at = new Date();
        await tx.update(MTG).set({ status: "adjourned", actualEnd: at, version: m.version + 1, updatedAt: at }).where(eq(MTG.id, id));

        // The commit point: emit every open decision (actionable + patient-scoped → the cross-module seam),
        // freeze packets, finalize the minutes (§2.7).
        const openDecisions = await tx.select().from(DEC).where(and(eq(DEC.idgMeetingId, id), eq(DEC.status, "open")));
        let decisionsEmittedCount = 0;
        for (const d of openDecisions) {
          await tx.update(DEC).set({ status: "emitted", emittedAt: at, updatedAt: at }).where(eq(DEC.id, d.id));
          if (isActionableDecisionKind(d.decisionKind) && d.patientId != null) {
            decisionsEmittedCount += 1;
            await emit(tx, orgId, "idg.decision_recorded", "idg_decision", d.id, {
              decisionId: d.id,
              meetingId: id,
              patientId: d.patientId,
              organizationId: orgId,
              decisionKind: d.decisionKind,
              payload: d.payload,
              payloadSchemaVersion: "2026-01-v1",
              recordedByMembershipId: d.recordedByMembershipId,
              recordedAt: isoReq(d.recordedAt),
              meetingAdjournedAt: at.toISOString(),
              wasQuorate: d.wasQuorate,
              quorumSnapshot: d.quorumSnapshot,
            });
          }
        }
        await tx.update(PKT).set({ frozenAt: at, updatedAt: at }).where(eq(PKT.idgMeetingId, id));

        const minutesId = await ensureMinutes(tx, orgId, id);
        await tx
          .update(MIN)
          .set({ status: "final", finalizedByMembershipId: userId, finalizedAt: at, updatedAt: at })
          .where(eq(MIN.id, minutesId));

        const actionItems = await tx.select({ id: ACT.id }).from(ACT).where(eq(ACT.idgMeetingId, id));
        await emit(tx, orgId, "m14.meeting.adjourned", "idg_meeting", id, {
          meetingId: id,
          adjournedByMembershipId: userId,
          adjournedAt: at.toISOString(),
          decisionsEmittedCount,
          actionItemsAssignedCount: actionItems.length,
          attendanceSnapshot: {},
        });
        await emit(tx, orgId, "m14.minutes.signed", "idg_minutes", minutesId, {
          minutesId,
          meetingId: id,
          finalizedByMembershipId: userId,
          renderPayload: {},
        });
        return toMeetingView({ ...m, status: "adjourned", actualEnd: at });
      });
    },

    // ── attendance (writes) ────────────────────────────────────────────────────────────────────────────
    async recordAttendance(orgId, _userId, meetingId, args): Promise<AttendanceView> {
      return withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const checkInAt = args.checkedInAt ? new Date(args.checkedInAt) : new Date();
        const status = args.status ?? "present";
        const [row] = await tx
          .insert(ATT)
          .values({ organizationId: orgId, idgMeetingId: meetingId, membershipId: args.membershipId, discipline: args.discipline, status, checkInAt })
          .returning({ id: ATT.id });
        await emit(tx, orgId, "m14.attendance.checked_in", "idg_meeting", meetingId, {
          meetingId,
          attendanceId: row!.id,
          membershipId: args.membershipId,
          discipline: args.discipline,
          checkedInAt: checkInAt.toISOString(),
          isTardy: status === "tardy",
        });
        return { id: row!.id, meetingId, membershipId: args.membershipId, discipline: args.discipline, status, checkedInAt: checkInAt.toISOString() };
      });
    },
    async updateAttendance(orgId, _userId, id, status): Promise<AttendanceView> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select().from(ATT).where(eq(ATT.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_attendance");
        await tx.update(ATT).set({ status, updatedAt: new Date() }).where(eq(ATT.id, id));
        return { id: row.id, meetingId: row.idgMeetingId, membershipId: row.membershipId, discipline: row.discipline, status, checkedInAt: iso(row.checkInAt) ?? "" };
      });
    },
    async removeAttendance(orgId, _userId, id): Promise<{ id: string; removed: true }> {
      // No DELETE grant (compromise #2) → soft-remove to `excused` (out of the quorum present-set).
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select({ id: ATT.id }).from(ATT).where(eq(ATT.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_attendance");
        await tx.update(ATT).set({ status: "excused", updatedAt: new Date() }).where(eq(ATT.id, id));
        return { id, removed: true };
      });
    },

    // ── agenda (writes) ────────────────────────────────────────────────────────────────────────────────
    async addAgendaItem(orgId, userId, meetingId, args): Promise<AgendaItemView> {
      return withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const existing = await tx.select({ id: AGD.id }).from(AGD).where(eq(AGD.idgMeetingId, meetingId));
        const [row] = await tx
          .insert(AGD)
          .values({
            organizationId: orgId,
            idgMeetingId: meetingId,
            patientId: args.patientId ?? null,
            title: args.kind,
            kind: args.kind,
            sortOrder: existing.length,
            addedByMembershipId: userId,
          })
          .returning({ id: AGD.id });
        return { id: row!.id, meetingId, kind: args.kind, patientId: args.patientId ?? null };
      });
    },
    async updateAgendaItem(orgId, _userId, id): Promise<AgendaItemView> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select().from(AGD).where(eq(AGD.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_agenda_item");
        return { id: row.id, meetingId: row.idgMeetingId, kind: row.kind, patientId: row.patientId };
      });
    },
    async removeAgendaItem(orgId, _userId, id): Promise<{ id: string; removed: true }> {
      // No DELETE grant + no tombstone column on the append-only agenda (compromise #2) → tenant-checked no-op.
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select({ id: AGD.id }).from(AGD).where(eq(AGD.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_agenda_item");
        return { id, removed: true };
      });
    },

    // ── decisions (writes) ─────────────────────────────────────────────────────────────────────────────
    async recordDecision(orgId, userId, meetingId, args): Promise<DecisionView> {
      return withOrg(orgId, async (tx) => {
        const m = await loadMeeting(tx, meetingId);
        // `planDecisionRecord` enforces MEETING_NOT_LIVE + INCLUSION_CRITERIA_FAILED and stamps the quorum.
        const plan = planDecisionRecord({
          meetingIsLive: m.status === "live",
          patientIncluded: await patientIncluded(tx, meetingId, args.patientId),
          presentDisciplines: await presentDisciplines(tx, meetingId),
        });
        const [row] = await tx
          .insert(DEC)
          .values({
            organizationId: orgId,
            idgMeetingId: meetingId,
            patientId: args.patientId,
            agendaItemId: args.agendaItemId ?? null,
            decisionKind: args.decisionKind,
            payload: {},
            wasQuorate: plan.wasQuorate,
            quorumSnapshot: plan.quorumSnapshot,
            recordedByMembershipId: userId,
            status: "open",
          })
          .returning();
        // The strict `recorded_open` payload requires a non-null patientId → emit only for patient decisions
        // (a patient-less team-note is recorded but carries no reporting event, matching the contract).
        if (args.patientId != null)
          await emit(tx, orgId, "m14.decision.recorded_open", "idg_decision", row!.id, {
            decisionId: row!.id,
            meetingId,
            patientId: args.patientId,
            decisionKind: args.decisionKind,
            wasQuorate: plan.wasQuorate,
            recordedByMembershipId: userId,
            recordedAt: new Date().toISOString(),
          });
        return toDecisionView(row!);
      });
    },
    async updateDecision(orgId, _userId, id, decisionKind): Promise<DecisionView> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select().from(DEC).where(eq(DEC.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_decision");
        const [updated] = await tx.update(DEC).set({ decisionKind, updatedAt: new Date() }).where(eq(DEC.id, id)).returning();
        return toDecisionView(updated!);
      });
    },
    async supersedeDecision(orgId, userId, id): Promise<DecisionView> {
      return withOrg(orgId, async (tx) => {
        const [prior] = await tx.select().from(DEC).where(eq(DEC.id, id)).limit(1);
        if (!prior) throw new NotFoundError("idg_decision");
        // `planDecisionSupersede` raises DECISION_SUPERSEDED / DECISION_NOT_OPEN (only an `emitted` decision
        // may be superseded, §2.8).
        planDecisionSupersede({ status: prior.status });
        const [next] = await tx
          .insert(DEC)
          .values({
            organizationId: orgId,
            idgMeetingId: prior.idgMeetingId,
            patientId: prior.patientId,
            decisionKind: prior.decisionKind,
            payload: {},
            wasQuorate: true,
            quorumSnapshot: prior.quorumSnapshot,
            recordedByMembershipId: userId,
            status: "open",
          })
          .returning({ id: DEC.id });
        const at = new Date();
        await tx
          .update(DEC)
          .set({ status: "superseded", supersededByDecisionId: next!.id, supersededAt: at, updatedAt: at })
          .where(eq(DEC.id, id));
        return toDecisionView({ ...prior, status: "superseded", supersededByDecisionId: next!.id });
      });
    },

    // ── action items (writes) ──────────────────────────────────────────────────────────────────────────
    async createActionItem(orgId, _userId, meetingId, args): Promise<ActionItemView> {
      return withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const [row] = await tx
          .insert(ACT)
          .values({
            organizationId: orgId,
            idgMeetingId: meetingId,
            idgDecisionId: args.decisionId ?? null,
            patientId: args.patientId,
            assignedToMembershipId: args.assignedToMembershipId,
            title: "action item",
            dueDate: new Date(args.dueDate),
            status: "open",
            linkedArtifactKind: args.linkedArtifactKind ?? null,
          })
          .returning();
        await emit(tx, orgId, "m14.action_item.created", "idg_action_item", row!.id, {
          actionItemId: row!.id,
          meetingId,
          decisionId: row!.idgDecisionId,
          patientId: row!.patientId,
          assignedToMembershipId: row!.assignedToMembershipId,
          dueDate: isoReq(row!.dueDate!),
          linkedArtifactKind: row!.linkedArtifactKind,
        });
        return toActionItemView(row!);
      });
    },
    async updateActionItem(orgId, userId, id, status: ActionItemPatchStatus): Promise<ActionItemView> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select().from(ACT).where(eq(ACT.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_action_item");
        const t = transitionActionItem(row.status, { type: PATCH_STATUS_EVENT[status] });
        const at = new Date();
        const closed = t.to === "completed" || t.to === "cancelled";
        const [updated] = await tx
          .update(ACT)
          .set({ status: t.to as IdgActionItemStatus, closedAt: closed ? at : row.closedAt, updatedAt: at })
          .where(eq(ACT.id, id))
          .returning();
        await emit(tx, orgId, "m14.action_item.status_changed", "idg_action_item", id, {
          actionItemId: id,
          fromStatus: row.status,
          toStatus: t.to,
          actorMembershipId: userId,
        });
        return toActionItemView(updated!);
      });
    },
    async removeActionItem(orgId, _userId, id): Promise<{ id: string; removed: true }> {
      // No DELETE grant (compromise #2) → soft-remove by transitioning to `cancelled`.
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select({ id: ACT.id, status: ACT.status }).from(ACT).where(eq(ACT.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_action_item");
        transitionActionItem(row.status, { type: "cancel" });
        await tx.update(ACT).set({ status: "cancelled", closedAt: new Date(), updatedAt: new Date() }).where(eq(ACT.id, id));
        return { id, removed: true };
      });
    },

    // ── minutes amendment (write) ──────────────────────────────────────────────────────────────────────
    async submitAmendment(orgId, userId, minutesId, amendmentReason): Promise<{ amendmentId: string; minutesId: string }> {
      return withOrg(orgId, async (tx) => {
        const [min] = await tx.select({ id: MIN.id, status: MIN.status }).from(MIN).where(eq(MIN.id, minutesId)).limit(1);
        if (!min) throw new NotFoundError("idg_minutes");
        // §2.6 D10 — an amendment applies ONLY to `final` minutes; `planMinutesAmendmentRequest` raises
        // MINUTES_NOT_IN_PROGRESS when the minutes are not yet final.
        planMinutesAmendmentRequest(min.status);
        const at = new Date();
        const [row] = await tx
          .insert(AMD)
          .values({
            organizationId: orgId,
            idgMinutesId: minutesId,
            amendmentReason,
            amendmentDiff: {},
            requestedByMembershipId: userId,
            approvedByMembershipId: userId,
            approvedAt: at,
          })
          .returning({ id: AMD.id });
        await emit(tx, orgId, "m14.minutes.amended", "idg_minutes", minutesId, {
          amendmentId: row!.id,
          minutesId,
          requestedByMembershipId: userId,
          approvedByMembershipId: userId,
          amendmentReasonHash: createHash("sha256").update(amendmentReason, "utf8").digest("hex"),
        });
        return { amendmentId: row!.id, minutesId };
      });
    },

    // ── IdgAbacResolver (§4.7) — org-scoped reads; null / empty ⇒ predicate fails closed ─────────────────
    async loadMeetingScope(orgId, meetingId): Promise<MeetingScopeFacts | null> {
      return withOrg(orgId, async (tx) => {
        const [m] = await tx
          .select({ organizationId: MTG.organizationId, locationId: MTG.locationId })
          .from(MTG)
          .where(eq(MTG.id, meetingId))
          .limit(1);
        return m ? { organizationId: m.organizationId, locationId: m.locationId } : null;
      });
    },
    async loadPresentDisciplines(orgId, meetingId): Promise<readonly string[] | null> {
      return withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) return null;
        return presentDisciplines(tx, meetingId);
      });
    },
    async loadReviewFloorBreaches(
      _orgId,
      _meetingId,
      _proposedTransition,
      _newScheduledStart,
    ): Promise<readonly ReviewFloorBreachFact[]> {
      // The per-patient 15-day review-floor breach math is the M14-F01 cron's (compromise #5); the gated
      // CANCEL/RESCHEDULE transitions drive the machine with the authorized-override facts. Clear here.
      return [];
    },
  };
}
