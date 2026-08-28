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
// Documented compromises (the M8–M13 convention; the interface threads no seams into the DB backend —
// with ONE lazy exception: the decision write path resolves M7's CarePlanReader via getSeam, best-effort,
// to stamp `idg_decision.care_plan_id` — see resolveCarePlanIdForDecision):
//   (1) `withOrgContext` runs with `userId:""` → the M4 write-audit trigger fires with a NULL actor (the
//       acting membership is the passed `userId`, stored on coordinator/recorded_by/etc. where a column exists);
//   (2) wardenx_app has DELETE on NO M14 table (append + status-transition, §3.3) — so `removeAttendance`
//       soft-removes to `excused`, `removeActionItem` transitions to `cancelled`, and `removeAgendaItem` is a
//       tenant-checked no-op (the append-only agenda has neither a DELETE grant nor a tombstone column);
//   (3) `idg_patient_packet` (PE/location/patient/admission NOT NULL) is built by the §2.4 packet WORKER, not
//       the route lifecycle — `buildPackets` only drives the meeting state + emits; the decision inclusion
//       gate reads the packet set (authoritative) OR a patient-scoped agenda item (the Phase-1 signal);
//   (4) decision payloads are persisted exactly as route validation accepted them; amendment diffs and
//       packet snapshots remain structural until their dedicated authoring flows land;
//   (5) [GAP-020 CLOSED] the per-patient 15-day review-floor breach math (`computeReviewFloorBreaches`) is
//       real: it reads the PACKET-included set (§2.3 D9's authoritative signal) for the meeting, floors each
//       patient at `packet.since_cursor_iso + 15d` (the packet worker already resolved that cursor to "last
//       review OR admission activation" — no second fact source needed), and a patient is covered iff another
//       NOT-YET-ADJOURNED meeting (`COVERING_MEETING_STATUSES`) that also includes them is scheduled on/before
//       their floor — an adjourned meeting is what the floor is measured FROM, never what satisfies it. An
//       agenda-only inclusion (pre-`BUILD_PACKETS`) has no packet-resolved cursor to check and is NOT
//       evaluated — the same authoritative-vs-Phase-1-signal split `patientIncluded` already draws. `ADJOURN`
//       now really stamps `last_idg_reviewed_at` (previously only `frozen_at` was set, so the floor could
//       never advance — a second, silent half of this same regression). `cancelMeeting`/`rescheduleMeeting`
//       feed the SAME computed facts into the pure `transitionMeeting` guard. [GAP-091 CLOSED] `overrideAuthorized`
//       is no longer hardcoded — it is resolved by the ROUTE's `per_patient_review_floor_clear` ABAC predicate
//       (idg.override_review_floor + a fresh, server-verified step-up; see abac-predicates.ts) and passed
//       through, same as `adjournMeeting`'s `stepUpFresh`. On a real override, `cancelMeeting`/`rescheduleMeeting`
//       emit `m14.review_floor.override_recorded` (breaching set + reason) in the SAME transaction. Still open,
//       deliberately out of scope: the `idg.review-clock-sweep` cron (T-3/T-0/T+1 escalation for a floor that
//       lapses from pure inaction, never touching CANCEL/RESCHEDULE at all — GAP-092).
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
import type { IdgActionItemStatus, IdgDecisionKind, PatientId } from "@wardenx/types";
import { NotFoundError } from "@wardenx/types";
import { and, asc, desc, eq, gte, inArray, lte, ne, notInArray } from "drizzle-orm";
import type { IdgAbacResolver, MeetingScopeFacts, ReviewFloorBreachFact } from "./abac-predicates";
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
import { getCarePlanReader } from "./seams/index";

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

/**
 * Resolve the patient's ACTIVE care plan id through M7's CarePlanReader seam — the
 * `idg_decision.care_plan_id` stamp (mig 0155) for a `care_plan_update` decision. The plan id cannot
 * come off the wire: the §2.6 D4 payload's mutations carry element ids only. The record-time ACTIVE plan is
 * the semantically correct
 * link because it is the plan the mutations will land on by construction: M7's apply-idg-decision
 * consumer refuses any plan that is not the patient's active one (`plan_not_active`, §11 D4/D2).
 * BEST-EFFORT by design: under the boot deny-stub or outside a request scope (the reader's Drizzle
 * store runs `withOrgContextFromRequest`) the read throws — the clinical write still lands with a
 * NULL link, which the by-care-plan seam read simply never matches (an honest miss, never a failed
 * decision or a fabricated link).
 */
async function resolveCarePlanIdForDecision(
  patientId: string | null,
  decisionKind: IdgDecisionKind,
): Promise<string | null> {
  if (decisionKind !== "care_plan_update" || patientId == null) return null;
  try {
    const overdue = await getCarePlanReader().isReviewOverdue(patientId as PatientId);
    return overdue?.planId ?? null;
  } catch {
    return null;
  }
}

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
    await outbox.publish(tx, {
      eventName,
      payload,
      organizationId: orgId,
      aggregateKind,
      aggregateId,
    });
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
      .where(
        and(
          eq(ATT.idgMeetingId, meetingId),
          notInArray(ATT.status, ["absent", "excused"] as never),
        ),
      );
    return rows.map((r) => r.discipline);
  }
  /** §2.3 D9 inclusion: a patient is on the meeting's caseload if it has a packet (authoritative) or a
   * patient-scoped agenda item (the Phase-1 signal before packets materialize). Null patient ⇒ always included. */
  async function patientIncluded(
    tx: DbClient,
    meetingId: string,
    patientId: string | null,
  ): Promise<boolean> {
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
  const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
  /** The `idg_meeting_status` values a meeting can hold and STILL deliver a review that covers a patient's
   * 15-day floor — i.e. everything before it adjourns. This is an ALLOWLIST on purpose. It was previously a
   * `notInArray(["cancelled","rescheduled"])` denylist, which also admitted `adjourned`: since a patient's
   * `since_cursor_iso` is set BY their last adjourned meeting, that meeting always satisfies
   * `scheduledStart <= cursor + 15d`, so every patient with any review history looked permanently covered and
   * the breach set was empty for all but a patient whose ONLY packet was on the meeting being cancelled.
   * An adjourned meeting is a review that already happened — it is what the floor is measured FROM, never
   * what satisfies it. (No lower time bound is needed on top of this: an overdue-but-still-pending meeting
   * remains a real future review, and if it is later cancelled this same guard runs for it.) */
  const COVERING_MEETING_STATUSES = [
    "scheduled",
    "packets_building",
    "packets_ready",
    "live",
  ] as const;
  /** M14-F01 / ADR-0018 D2 (GAP-020) — the per-patient 15-day review-floor breach set a proposed
   * CANCEL/RESCHEDULE would leave uncovered. Scoped to PACKET-included patients (§2.3 D9's authoritative
   * inclusion signal); an agenda-only patient has no packet-resolved review cursor to check (documented, not
   * silent — see the module header). Each packet's `since_cursor_iso` is already the "last review OR
   * admission activation" cursor the §2.4 packet worker resolved when it built the packet, so the floor is
   * just that cursor + 15 days — no second fact source to thread in. A patient is COVERED (no breach) when
   * another NOT-YET-ADJOURNED meeting (`COVERING_MEETING_STATUSES`) that also includes them is scheduled
   * on/before their floor. */
  async function computeReviewFloorBreaches(
    tx: DbClient,
    orgId: string,
    meetingId: string,
    proposedTransition: "cancel" | "reschedule",
    newScheduledStart: string | null,
  ): Promise<ReviewFloorBreachFact[]> {
    const pkts = await tx
      .select({ patientId: PKT.patientId, sinceCursorIso: PKT.sinceCursorIso })
      .from(PKT)
      .where(eq(PKT.idgMeetingId, meetingId));
    if (pkts.length === 0) return [];

    const breaches: ReviewFloorBreachFact[] = [];
    for (const p of pkts) {
      const floorAt = new Date(new Date(p.sinceCursorIso).getTime() + FIFTEEN_DAYS_MS);
      // A RESCHEDULE onto a date still on/before the floor covers the patient with THIS meeting itself.
      if (
        proposedTransition === "reschedule" &&
        newScheduledStart &&
        new Date(newScheduledStart) <= floorAt
      ) {
        continue;
      }
      const [covering] = await tx
        .select({ id: MTG.id })
        .from(PKT)
        .innerJoin(MTG, eq(MTG.id, PKT.idgMeetingId))
        .where(
          and(
            eq(PKT.organizationId, orgId),
            eq(PKT.patientId, p.patientId),
            ne(PKT.idgMeetingId, meetingId),
            inArray(MTG.status, COVERING_MEETING_STATUSES as never),
            lte(MTG.scheduledStart, floorAt),
          ),
        )
        .limit(1);
      if (!covering) breaches.push({ patientId: p.patientId, floorAt: floorAt.toISOString() });
    }
    return breaches;
  }
  /** Ensure a `in_progress` minutes row for the meeting (idempotent); returns its id. */
  async function ensureMinutes(tx: DbClient, orgId: string, meetingId: string): Promise<string> {
    const [existing] = await tx
      .select({ id: MIN.id })
      .from(MIN)
      .where(eq(MIN.idgMeetingId, meetingId))
      .limit(1);
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
  /**
   * The decision METADATA projection. `payload` and `quorumSnapshot` are deliberately absent: the
   * payload is the D4 canonical narrative (rationaleText / mutations / recommendations), denylisted in
   * the §3.3 write-audit trigger, and publishing it on a list read would reopen W-SUD-01 for a surface
   * built not to have to answer it (see `PatientIdgHistoryView`'s "PHI-safe by construction" note).
   */
  const toDecisionView = (r: typeof DEC.$inferSelect): DecisionView => ({
    id: r.id,
    meetingId: r.idgMeetingId,
    patientId: r.patientId,
    agendaItemId: r.agendaItemId,
    decisionKind: r.decisionKind,
    status: r.status,
    wasQuorate: r.wasQuorate,
    recordedByMembershipId: r.recordedByMembershipId,
    recordedAt: isoReq(r.recordedAt),
    supersededByDecisionId: r.supersededByDecisionId,
  });
  const toAttendanceView = (r: typeof ATT.$inferSelect): AttendanceView => ({
    id: r.id,
    meetingId: r.idgMeetingId,
    membershipId: r.membershipId,
    discipline: r.discipline,
    status: r.status,
    checkedInAt: iso(r.checkInAt) ?? "",
  });
  const toAgendaItemView = (r: typeof AGD.$inferSelect): AgendaItemView => ({
    id: r.id,
    meetingId: r.idgMeetingId,
    kind: r.kind,
    patientId: r.patientId,
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
        return rows.map((r) => ({
          packetId: r.id,
          meetingId,
          patientId: r.patientId,
          frozenAt: iso(r.frozenAt),
        }));
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
        const pktBy = new Map<
          string,
          { reviewedAt: Date | null; frozenAt: Date | null; builtAt: Date }
        >();
        for (const p of pkts) {
          const prev = pktBy.get(p.meetingId);
          if (!prev || p.builtAt > prev.builtAt) {
            pktBy.set(p.meetingId, {
              reviewedAt: p.reviewedAt,
              frozenAt: p.frozenAt,
              builtAt: p.builtAt,
            });
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
          for (const r of rows)
            (m.get(r.meetingId) ?? m.set(r.meetingId, []).get(r.meetingId)!).push(r);
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
        const rows = await tx
          .select()
          .from(ACT)
          .where(filters.length ? and(...filters) : undefined);
        return rows.map(toActionItemView);
      });
    },

    // ── minutes read ───────────────────────────────────────────────────────────────────────────────────
    /**
     * F-062 — this used to project 3 of `idg_minutes`' 13 columns: `{ id, meetingId, status }`. The
     * minutes screen therefore rendered two uuids and a status pill for the document that IS the
     * §418.56(d) evidence of the review, while the row beside it held the frozen attendance / decision /
     * action-item snapshots, the finalize attribution, and the M22 render back-ref.
     *
     * The snapshots are returned as COUNTS. They nest the decision payloads — the §3.3 denylisted
     * narrative — so publishing them would reopen W-SUD-01 for a read surface deliberately built not to
     * carry narrative; the readable document is the M22 render at `minutesDocumentId`, which has its own
     * consent gate. `closing_note` is withheld for the same reason (a DENYLISTED free-text column).
     */
    async getMinutes(orgId, meetingId): Promise<MinutesView> {
      return withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const [r] = await tx
          .select({
            id: MIN.id,
            status: MIN.status,
            finalizedAt: MIN.finalizedAt,
            finalizedByMembershipId: MIN.finalizedByMembershipId,
            minutesDocumentId: MIN.minutesDocumentId,
            attendanceSnapshot: MIN.attendanceSnapshot,
            decisionListSnapshot: MIN.decisionListSnapshot,
            actionItemListSnapshot: MIN.actionItemListSnapshot,
          })
          .from(MIN)
          .where(eq(MIN.idgMeetingId, meetingId))
          .limit(1);
        if (!r) throw new NotFoundError("idg_minutes");
        // Null (rather than 0) while `in_progress`: nothing is frozen yet, and "no decisions were
        // recorded" and "the snapshot has not been taken" are different facts about a meeting.
        const size = (v: unknown): number | null => (Array.isArray(v) ? v.length : null);
        return {
          id: r.id,
          meetingId,
          status: r.status,
          finalizedAt: iso(r.finalizedAt),
          finalizedByMembershipId: r.finalizedByMembershipId,
          minutesDocumentId: r.minutesDocumentId,
          attendanceCount: size(r.attendanceSnapshot),
          decisionCount: size(r.decisionListSnapshot),
          actionItemCount: size(r.actionItemListSnapshot),
        };
      });
    },

    // ── meeting-conduct reads (F-062) ──────────────────────────────────────────────────────────────────
    // Three writes each had no reader at all. `idg_attendance` backs the §2.7 quorum the
    // `quorate_decision` predicate evaluates, `idg_agenda_item` is the meeting's running order, and
    // `idg_decision` is what an adjournment commits — and none of the three could be read back through
    // any route in the module. Ordered the way the surface reads them: attendance by check-in, agenda by
    // its explicit `sort_order`, decisions newest-first.
    async listAttendance(orgId, meetingId): Promise<AttendanceView[]> {
      return withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const rows = await tx
          .select()
          .from(ATT)
          .where(eq(ATT.idgMeetingId, meetingId))
          .orderBy(asc(ATT.checkInAt));
        return rows.map(toAttendanceView);
      });
    },
    async listAgenda(orgId, meetingId): Promise<AgendaItemView[]> {
      return withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const rows = await tx
          .select()
          .from(AGD)
          .where(eq(AGD.idgMeetingId, meetingId))
          .orderBy(asc(AGD.sortOrder));
        return rows.map(toAgendaItemView);
      });
    },
    async listDecisions(orgId, meetingId): Promise<DecisionView[]> {
      return withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const rows = await tx
          .select()
          .from(DEC)
          .where(eq(DEC.idgMeetingId, meetingId))
          .orderBy(desc(DEC.recordedAt));
        return rows.map(toDecisionView);
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
        return {
          id: row!.id,
          locationId: row!.locationId,
          cadenceDays: row!.cadenceDays,
          active: row!.active,
        };
      });
    },
    async updateRecurringPolicy(orgId, _userId, id, args): Promise<RecurringPolicyView> {
      return withOrg(orgId, async (tx) => {
        const [existing] = await tx.select().from(POL).where(eq(POL.id, id)).limit(1);
        if (!existing) throw new NotFoundError("idg_recurring_policy");
        const [row] = await tx
          .update(POL)
          .set({
            cadenceDays: args.cadenceDays,
            active: args.active ?? existing.active,
            updatedAt: new Date(),
          })
          .where(eq(POL.id, id))
          .returning();
        return {
          id: row!.id,
          locationId: row!.locationId,
          cadenceDays: row!.cadenceDays,
          active: row!.active,
        };
      });
    },

    // ── meeting lifecycle (writes) ─────────────────────────────────────────────────────────────────────
    async cancelMeeting(
      orgId,
      userId,
      id,
      reason,
      overrideAuthorized = false,
    ): Promise<MeetingView> {
      return withOrg(orgId, async (tx) => {
        const m = await loadMeeting(tx, id);
        // The route's `per_patient_review_floor_clear` ABAC gate already checked this (403 before the
        // handler runs, or the audited override per GAP-091); the service resolves the SAME facts again as
        // a defense-in-depth backstop for any caller reaching the service directly, and trusts the route's
        // `overrideAuthorized` determination (it cannot itself re-resolve permission/step-up from a bare
        // membership id — same as `adjournMeeting`'s `stepUpFresh` parameter).
        const breaches = await computeReviewFloorBreaches(tx, orgId, id, "cancel", null);
        transitionMeeting(m.status, {
          type: "CANCEL",
          reason,
          reviewFloorClear: breaches.length === 0,
          overrideAuthorized,
          breachingPatients: breaches,
        });
        const at = new Date();
        await tx
          .update(MTG)
          .set({
            status: "cancelled",
            cancellationReason: reason,
            version: m.version + 1,
            updatedAt: at,
          })
          .where(eq(MTG.id, id));
        await emit(tx, orgId, "m14.meeting.cancelled", "idg_meeting", id, {
          meetingId: id,
          cancelledBy: userId,
          cancellationReason: reason,
          cancelledAt: at.toISOString(),
        });
        // GAP-091 — the audited outbox record of the override, captured in the SAME transaction as the
        // cancellation write.
        if (breaches.length > 0 && overrideAuthorized) {
          await emit(tx, orgId, "m14.review_floor.override_recorded", "idg_meeting", id, {
            meetingId: id,
            actorMembershipId: userId,
            reason,
            breachingPatients: breaches,
            overriddenAt: at.toISOString(),
          });
        }
        return toMeetingView({ ...m, status: "cancelled", cancellationReason: reason });
      });
    },
    async rescheduleMeeting(orgId, userId, id, args): Promise<MeetingView> {
      return withOrg(orgId, async (tx) => {
        const prior = await loadMeeting(tx, id);
        const breaches = await computeReviewFloorBreaches(
          tx,
          orgId,
          id,
          "reschedule",
          args.newScheduledStart,
        );
        const overrideAuthorized = args.overrideAuthorized ?? false;
        transitionMeeting(prior.status, {
          type: "RESCHEDULE",
          reason: args.reason,
          reviewFloorClear: breaches.length === 0,
          overrideAuthorized,
          breachingPatients: breaches,
        });
        const at = new Date();
        await tx
          .update(MTG)
          .set({ status: "rescheduled", version: prior.version + 1, updatedAt: at })
          .where(eq(MTG.id, id));
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
        if (breaches.length > 0 && overrideAuthorized) {
          await emit(tx, orgId, "m14.review_floor.override_recorded", "idg_meeting", id, {
            meetingId: id,
            actorMembershipId: userId,
            reason: args.reason,
            breachingPatients: breaches,
            overriddenAt: at.toISOString(),
          });
        }
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
        await tx
          .update(MTG)
          .set({ status: "packets_building", version: m.version + 1, updatedAt: at })
          .where(eq(MTG.id, id));
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
        await tx
          .update(MTG)
          .set({ status: "live", actualStart: at, version: m.version + 1, updatedAt: at })
          .where(eq(MTG.id, id));
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
        await tx
          .update(MTG)
          .set({ status: "adjourned", actualEnd: at, version: m.version + 1, updatedAt: at })
          .where(eq(MTG.id, id));

        // The commit point: emit every open decision (actionable + patient-scoped → the cross-module seam),
        // freeze packets, finalize the minutes (§2.7).
        const openDecisions = await tx
          .select()
          .from(DEC)
          .where(and(eq(DEC.idgMeetingId, id), eq(DEC.status, "open")));
        let decisionsEmittedCount = 0;
        for (const d of openDecisions) {
          await tx
            .update(DEC)
            .set({ status: "emitted", emittedAt: at, updatedAt: at })
            .where(eq(DEC.id, d.id));
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
        // §2.7 `stamp_review_floor` (GAP-020) — the commit-point review actually resets each included
        // patient's 15-day floor; previously only `frozenAt` was set here, so the floor never advanced.
        await tx
          .update(PKT)
          .set({ frozenAt: at, lastIdgReviewedAt: at, updatedAt: at })
          .where(eq(PKT.idgMeetingId, id));

        // F-062 — FREEZE THE MINUTES. `idg_minutes` declares three snapshot columns whose whole purpose
        // is to make the finalized record immutable (the M4 trigger refuses a content UPDATE on `final`),
        // and adjournment wrote NONE of them: it stamped `status`/`finalized_at`/`finalized_by` and left
        // `attendance_snapshot`, `decision_list_snapshot` and `action_item_list_snapshot` NULL on every
        // meeting the platform has ever adjourned. So the finalized minutes of a §418.56(d) review — the
        // artefact a surveyor asks for — recorded that a review happened and nothing about what it
        // reviewed. The two events carried the same emptiness (`attendanceSnapshot: {}`,
        // `renderPayload: {}`), which is what M22's minutes render would have been handed.
        //
        // METADATA, matching the rest of this module's read surface: ids, disciplines, statuses, times.
        // Not the decision payloads — those are the §3.3 denylisted narrative, they are already immutable
        // once `emitted` (`updateDecision` refuses a non-`open` row), and the eraser hash-redacts patient
        // references INSIDE these snapshots, which only works on a shape it can walk.
        const attendanceRows = await tx
          .select()
          .from(ATT)
          .where(eq(ATT.idgMeetingId, id))
          .orderBy(asc(ATT.checkInAt));
        // Re-read AFTER the emit loop so the snapshot records the committed `emitted` status, and across
        // every status — a superseded decision is part of what the meeting did (§2.8).
        const decisionRows = await tx
          .select()
          .from(DEC)
          .where(eq(DEC.idgMeetingId, id))
          .orderBy(asc(DEC.recordedAt));
        const actionItemRows = await tx.select().from(ACT).where(eq(ACT.idgMeetingId, id));

        const attendanceSnapshot = attendanceRows.map((a) => ({
          attendanceId: a.id,
          membershipId: a.membershipId,
          discipline: a.discipline,
          status: a.status,
          checkInAt: iso(a.checkInAt),
        }));
        const decisionListSnapshot = decisionRows.map((d) => ({
          decisionId: d.id,
          patientId: d.patientId,
          decisionKind: d.decisionKind,
          status: d.status,
          wasQuorate: d.wasQuorate,
          recordedByMembershipId: d.recordedByMembershipId,
          recordedAt: isoReq(d.recordedAt),
          supersededByDecisionId: d.supersededByDecisionId,
        }));
        const actionItemListSnapshot = actionItemRows.map((a) => ({
          actionItemId: a.id,
          decisionId: a.idgDecisionId,
          patientId: a.patientId,
          assignedToMembershipId: a.assignedToMembershipId,
          assignedToDiscipline: a.assignedToDiscipline,
          status: a.status,
          dueDate: iso(a.dueDate),
        }));

        const minutesId = await ensureMinutes(tx, orgId, id);
        await tx
          .update(MIN)
          .set({
            status: "final",
            finalizedByMembershipId: userId,
            finalizedAt: at,
            attendanceSnapshot,
            decisionListSnapshot,
            actionItemListSnapshot,
            updatedAt: at,
          })
          .where(eq(MIN.id, minutesId));

        await emit(tx, orgId, "m14.meeting.adjourned", "idg_meeting", id, {
          meetingId: id,
          adjournedByMembershipId: userId,
          adjournedAt: at.toISOString(),
          decisionsEmittedCount,
          actionItemsAssignedCount: actionItemRows.length,
          attendanceSnapshot,
        });
        await emit(tx, orgId, "m14.minutes.signed", "idg_minutes", minutesId, {
          minutesId,
          meetingId: id,
          finalizedByMembershipId: userId,
          renderPayload: { attendanceSnapshot, decisionListSnapshot, actionItemListSnapshot },
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
          .values({
            organizationId: orgId,
            idgMeetingId: meetingId,
            membershipId: args.membershipId,
            discipline: args.discipline,
            status,
            checkInAt,
          })
          .returning({ id: ATT.id });
        await emit(tx, orgId, "m14.attendance.checked_in", "idg_meeting", meetingId, {
          meetingId,
          attendanceId: row!.id,
          membershipId: args.membershipId,
          discipline: args.discipline,
          checkedInAt: checkInAt.toISOString(),
          isTardy: status === "tardy",
        });
        return {
          id: row!.id,
          meetingId,
          membershipId: args.membershipId,
          discipline: args.discipline,
          status,
          checkedInAt: checkInAt.toISOString(),
        };
      });
    },
    async updateAttendance(orgId, _userId, id, status): Promise<AttendanceView> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select().from(ATT).where(eq(ATT.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_attendance");
        await tx.update(ATT).set({ status, updatedAt: new Date() }).where(eq(ATT.id, id));
        return {
          id: row.id,
          meetingId: row.idgMeetingId,
          membershipId: row.membershipId,
          discipline: row.discipline,
          status,
          checkedInAt: iso(row.checkInAt) ?? "",
        };
      });
    },
    async removeAttendance(orgId, _userId, id): Promise<{ id: string; removed: true }> {
      // No DELETE grant (compromise #2) → soft-remove to `excused` (out of the quorum present-set).
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select({ id: ATT.id }).from(ATT).where(eq(ATT.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_attendance");
        await tx
          .update(ATT)
          .set({ status: "excused", updatedAt: new Date() })
          .where(eq(ATT.id, id));
        return { id, removed: true };
      });
    },

    // ── agenda (writes) ────────────────────────────────────────────────────────────────────────────────
    async addAgendaItem(orgId, userId, meetingId, args): Promise<AgendaItemView> {
      return withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const existing = await tx
          .select({ id: AGD.id })
          .from(AGD)
          .where(eq(AGD.idgMeetingId, meetingId));
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
        return {
          id: row.id,
          meetingId: row.idgMeetingId,
          kind: row.kind,
          patientId: row.patientId,
        };
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
      // Resolved BEFORE the write tx: the seam read opens its own request-scoped tx, and nesting it
      // inside `withOrg` would re-enter the pool mid-transaction (the M11/M18 write-lifecycle gotcha).
      const carePlanId = await resolveCarePlanIdForDecision(args.patientId, args.decisionKind);
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
            carePlanId, // mig 0155 — the active-plan link (NULL for non-care_plan_update / unresolved)
            agendaItemId: args.agendaItemId ?? null,
            decisionKind: args.decisionKind,
            payload: args.payload,
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
    async updateDecision(orgId, _userId, id, payload): Promise<DecisionView> {
      const prior = await withOrg(orgId, async (tx) => {
        const [row] = await tx.select().from(DEC).where(eq(DEC.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_decision");
        return row;
      });
      // The kind may flip into/out of `care_plan_update`: entering it resolves the (previously
      // unset) active-plan link — the seam read runs between the two txs, never inside one — and
      // leaving it CLEARS the link, so M30's latency measure never scores a decision that no longer
      // updates a plan.
      const carePlanId =
        payload.kind === "care_plan_update"
          ? (prior.carePlanId ??
            (await resolveCarePlanIdForDecision(prior.patientId, payload.kind)))
          : null;
      return withOrg(orgId, async (tx) => {
        const [updated] = await tx
          .update(DEC)
          .set({ decisionKind: payload.kind, payload, carePlanId, updatedAt: new Date() })
          .where(eq(DEC.id, id))
          .returning();
        if (!updated) throw new NotFoundError("idg_decision");
        return toDecisionView(updated);
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
            carePlanId: prior.carePlanId, // the successor supersedes the SAME plan's decision (kind is copied verbatim)
            decisionKind: prior.decisionKind,
            payload: prior.payload,
            wasQuorate: true,
            quorumSnapshot: prior.quorumSnapshot,
            recordedByMembershipId: userId,
            status: "open",
          })
          .returning({ id: DEC.id });
        const at = new Date();
        await tx
          .update(DEC)
          .set({
            status: "superseded",
            supersededByDecisionId: next!.id,
            supersededAt: at,
            updatedAt: at,
          })
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
    async updateActionItem(
      orgId,
      userId,
      id,
      status: ActionItemPatchStatus,
    ): Promise<ActionItemView> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select().from(ACT).where(eq(ACT.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_action_item");
        const t = transitionActionItem(row.status, { type: PATCH_STATUS_EVENT[status] });
        const at = new Date();
        const closed = t.to === "completed" || t.to === "cancelled";
        const [updated] = await tx
          .update(ACT)
          .set({
            status: t.to as IdgActionItemStatus,
            closedAt: closed ? at : row.closedAt,
            updatedAt: at,
          })
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
        const [row] = await tx
          .select({ id: ACT.id, status: ACT.status })
          .from(ACT)
          .where(eq(ACT.id, id))
          .limit(1);
        if (!row) throw new NotFoundError("idg_action_item");
        transitionActionItem(row.status, { type: "cancel" });
        await tx
          .update(ACT)
          .set({ status: "cancelled", closedAt: new Date(), updatedAt: new Date() })
          .where(eq(ACT.id, id));
        return { id, removed: true };
      });
    },

    // ── minutes amendment (write) ──────────────────────────────────────────────────────────────────────
    async submitAmendment(
      orgId,
      userId,
      minutesId,
      amendmentReason,
    ): Promise<{ amendmentId: string; minutesId: string }> {
      return withOrg(orgId, async (tx) => {
        const [min] = await tx
          .select({ id: MIN.id, status: MIN.status })
          .from(MIN)
          .where(eq(MIN.id, minutesId))
          .limit(1);
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
      orgId,
      meetingId,
      proposedTransition,
      newScheduledStart,
    ): Promise<readonly ReviewFloorBreachFact[]> {
      return withOrg(orgId, (tx) =>
        computeReviewFloorBreaches(tx, orgId, meetingId, proposedTransition, newScheduledStart),
      );
    },
  };
}
