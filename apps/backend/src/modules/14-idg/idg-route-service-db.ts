// apps/backend/src/modules/14-idg — PRODUCTION IdgRouteService (+ IdgAbacResolver), READ-first (M14L wiring).
//
// The screen-driving READS (meeting schedule, meeting detail, packet digests, action-item worklist, minutes)
// run as real Drizzle queries over the M14-owned tables inside `withOrgContext`, so RLS scopes every row by
// `app.org_id` as the unprivileged `wardenx_app` role. The full WRITE lifecycle (meeting state machine,
// attendance, agenda, decisions, action items, minutes/amendments, recurring policies) is the follow-up; every
// write here fail-closes 501 (`NOT_IMPLEMENTED`) so the interface is satisfied and the mount is real. The
// in-memory `createInMemoryIdgBackend` (`routes/service.ts`) stays the behavioral reference for those writes.
//
// The service ALSO implements {@link IdgAbacResolver}: the §4.7 predicates (`idg_meeting_scope` /
// `quorate_decision` / `per_patient_review_floor_clear`) resolve over the same RLS-scoped dataset.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, asc, eq, gte, lte, notInArray } from "drizzle-orm";
import type {
  IdgAbacResolver,
  MeetingScopeFacts,
  ReviewFloorBreachFact,
} from "./abac-predicates";
import type {
  ActionItemPatchStatus,
  ActionItemView,
  IdgRouteService,
  MeetingScheduleView,
  MeetingView,
  MinutesView,
  PacketDigestView,
} from "./routes/service";

const MTG = schema.idgMeeting;
const ATT = schema.idgAttendance;
const ACT = schema.idgActionItem;
const MIN = schema.idgMinutes;
const PKT = schema.idgPatientPacket;

/** Coerce a Drizzle timestamp (Date or string, depending on column mode) to an ISO string (nullable). */
const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;
/** Same, non-null (a NOT NULL timestamp column). */
const isoReq = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

/** A never-returning stub for the write lifecycle still owed by the M14L follow-up. */
const notImpl = (): never => {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    "IDG writes arrive in the M14L follow-up (the Drizzle write lifecycle)",
    501,
  );
};

/**
 * The production, RLS-backed IdgRouteService + IdgAbacResolver. Reads are real; writes fail-closed 501.
 * Org is bound from the request context by the caller and passed as `orgId` — never the body.
 */
export function createDbIdgBackend(db: DbClient): IdgRouteService & IdgAbacResolver {
  /** Resolve a meeting under the caller's tenant (RLS-scoped) — used to guard child reads with 404 non-leak. */
  async function meetingExists(tx: DbClient, id: string): Promise<boolean> {
    const [row] = await tx.select({ id: MTG.id }).from(MTG).where(eq(MTG.id, id)).limit(1);
    return !!row;
  }

  return {
    // ── schedule + meeting reads ─────────────────────────────────────────────────────────────────────────
    async listSchedule(orgId, q): Promise<MeetingScheduleView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
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
              gte(MTG.scheduledStart, q.from as never),
              lte(MTG.scheduledStart, q.to as never),
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
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const [m] = await tx
          .select({
            id: MTG.id,
            organizationId: MTG.organizationId,
            locationId: MTG.locationId,
            status: MTG.status,
            scheduledStart: MTG.scheduledStart,
            scheduledEnd: MTG.scheduledEnd,
            actualEnd: MTG.actualEnd,
          })
          .from(MTG)
          .where(eq(MTG.id, id))
          .limit(1);
        if (!m) throw new NotFoundError("idg_meeting");
        return {
          id: m.id,
          organizationId: m.organizationId,
          locationId: m.locationId,
          status: m.status,
          scheduledStart: isoReq(m.scheduledStart),
          scheduledEnd: isoReq(m.scheduledEnd),
          // `adjournedAt` is the meeting's actual end (the machine stamps it at ADJOURN); null until adjourned.
          adjournedAt: m.status === "adjourned" ? iso(m.actualEnd) : null,
        };
      });
    },

    // ── packet reads (partitioned parent; digest carries no narrative → no SUD payload to redact) ──────────
    async listPackets(orgId, meetingId): Promise<PacketDigestView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        if (!(await meetingExists(tx as DbClient, meetingId))) throw new NotFoundError("idg_meeting");
        const rows = await tx
          .select({ id: PKT.id, patientId: PKT.patientId, frozenAt: PKT.frozenAt })
          .from(PKT)
          .where(eq(PKT.idgMeetingId, meetingId));
        return rows.map((r) => ({
          packetId: r.id,
          meetingId,
          patientId: r.patientId,
          frozenAt: iso(r.frozenAt),
        }));
      });
    },
    async getPacket(orgId, meetingId, patientId): Promise<PacketDigestView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        if (!(await meetingExists(tx as DbClient, meetingId))) throw new NotFoundError("idg_meeting");
        const [r] = await tx
          .select({ id: PKT.id, frozenAt: PKT.frozenAt })
          .from(PKT)
          .where(and(eq(PKT.idgMeetingId, meetingId), eq(PKT.patientId, patientId)))
          .limit(1);
        if (!r) throw new NotFoundError("idg_patient_packet");
        return { packetId: r.id, meetingId, patientId, frozenAt: iso(r.frozenAt) };
      });
    },

    // ── action-item worklist ───────────────────────────────────────────────────────────────────────────
    async listActionItems(orgId, userId, q): Promise<ActionItemView[]> {
      // `assignee=me` resolves to the caller's membership (the session userId is the membership id here).
      const assignee = q.assignee === "me" ? userId : q.assignee;
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const filters = [
          assignee !== undefined ? eq(ACT.assignedToMembershipId, assignee) : undefined,
          q.status !== undefined ? eq(ACT.status, q.status) : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        const rows = await tx
          .select({
            id: ACT.id,
            meetingId: ACT.idgMeetingId,
            decisionId: ACT.idgDecisionId,
            patientId: ACT.patientId,
            assignedToMembershipId: ACT.assignedToMembershipId,
            status: ACT.status,
            dueDate: ACT.dueDate,
            linkedArtifactKind: ACT.linkedArtifactKind,
          })
          .from(ACT)
          .where(filters.length ? and(...filters) : undefined);
        return rows.map((r) => ({
          id: r.id,
          meetingId: r.meetingId,
          decisionId: r.decisionId,
          patientId: r.patientId,
          assignedToMembershipId: r.assignedToMembershipId,
          status: r.status,
          dueDate: iso(r.dueDate) ?? "",
          linkedArtifactKind: r.linkedArtifactKind,
        }));
      });
    },

    // ── minutes ──────────────────────────────────────────────────────────────────────────────────────────
    async getMinutes(orgId, meetingId): Promise<MinutesView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        if (!(await meetingExists(tx as DbClient, meetingId))) throw new NotFoundError("idg_meeting");
        const [r] = await tx
          .select({ id: MIN.id, status: MIN.status })
          .from(MIN)
          .where(eq(MIN.idgMeetingId, meetingId))
          .limit(1);
        // No minutes row until one is opened (a write, owed to the follow-up) → 404 non-leak.
        if (!r) throw new NotFoundError("idg_minutes");
        return { id: r.id, meetingId, status: r.status };
      });
    },

    // ── IdgAbacResolver (§4.7) — org-scoped reads; null / empty ⇒ predicate fails closed ─────────────────
    async loadMeetingScope(orgId, meetingId): Promise<MeetingScopeFacts | null> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const [m] = await tx
          .select({ organizationId: MTG.organizationId, locationId: MTG.locationId })
          .from(MTG)
          .where(eq(MTG.id, meetingId))
          .limit(1);
        return m ? { organizationId: m.organizationId, locationId: m.locationId } : null;
      });
    },
    async loadPresentDisciplines(orgId, meetingId): Promise<readonly string[] | null> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        if (!(await meetingExists(tx as DbClient, meetingId))) return null;
        // The disciplines PRESENT (not absent/excused) — the quorum present-set.
        const rows = await tx
          .select({ discipline: ATT.discipline })
          .from(ATT)
          .where(
            and(
              eq(ATT.idgMeetingId, meetingId),
              notInArray(ATT.status, ["absent", "excused"] as never),
            ),
          );
        return rows.map((r) => r.discipline);
      });
    },
    async loadReviewFloorBreaches(
      _orgId,
      _meetingId,
      _proposedTransition,
      _newScheduledStart,
    ): Promise<readonly ReviewFloorBreachFact[]> {
      // TODO(M14L write follow-up): compute the per-patient 15-day review-floor breaches (last_idg_reviewed_at
      // + 15d vs. the proposed CANCEL/RESCHEDULE) from idg_patient_packet. The gated transitions are writes
      // (→ 501) today, so no floor is crossed; mirror the in-memory "clear" default until the math lands.
      return [];
    },

    // ── Writes — the M14L follow-up Drizzle lifecycle. Fail-closed 501 until then. ─────────────────────────
    createRecurringPolicy: async () => notImpl(),
    updateRecurringPolicy: async () => notImpl(),
    cancelMeeting: async () => notImpl(),
    rescheduleMeeting: async () => notImpl(),
    buildPackets: async () => notImpl(),
    startMeeting: async () => notImpl(),
    adjournMeeting: async () => notImpl(),
    recordAttendance: async () => notImpl(),
    updateAttendance: async () => notImpl(),
    removeAttendance: async () => notImpl(),
    addAgendaItem: async () => notImpl(),
    updateAgendaItem: async () => notImpl(),
    removeAgendaItem: async () => notImpl(),
    recordDecision: async () => notImpl(),
    updateDecision: async () => notImpl(),
    supersedeDecision: async () => notImpl(),
    createActionItem: async () => notImpl(),
    updateActionItem: async (_o: string, _u: string, _id: string, _s: ActionItemPatchStatus) => notImpl(),
    removeActionItem: async () => notImpl(),
    submitAmendment: async () => notImpl(),
  };
}
