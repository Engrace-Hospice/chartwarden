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
  IDG_REQUIRED_QUORUM,
  IdgStateError,
  isActionableDecisionKind,
  planDecisionRecord,
  planDecisionSupersede,
  planDecisionSupersedeInto,
  planDecisionUpdate,
  planMinutesAmendmentRequest,
  transitionActionItem,
  transitionMeeting,
} from "@wardenx/idg";
import { withOrgContext } from "@wardenx/tenancy";
import type { IdgActionItemStatus, IdgDecisionKind, PatientId } from "@wardenx/types";
import { ForbiddenError, NotFoundError, WardenXError } from "@wardenx/types";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { IdgAbacResolver, MeetingScopeFacts, ReviewFloorBreachFact } from "./abac-predicates";
import {
  CHART_PROMOTION_DECIDED_EVENT,
  PROMOTED_AGENDA_TITLE,
  decidedPayload,
  listForPatients,
  mapPromotionInsertError,
  promotionHasItem,
  requireReview,
} from "./chart-promotion";
import { recomputeCarryForwardCountsForMeeting } from "./jobs/carry-forward-count";
import {
  type MinutesSiteNames,
  loadMinutesMemberIds,
  loadMinutesRenderContext,
  patientsNeedingRelease as patientsNeedingReleaseForMeeting,
} from "./minutes-render-context";
import type { IdgMembershipDisplayPort, IdgSiteDisplayPort } from "./routes/idg-enrichment";
import { assertMeetingWriteAllowed } from "./routes/meeting-write-policy";
import { mapPacketContent } from "./routes/packet-content";
import type {
  ActionItemPatchStatus,
  ActionItemView,
  AgendaItemView,
  AttendanceView,
  DecisionView,
  DisciplineAddendumRenderEntry,
  DisciplineNoteSnapshotEntry,
  DisciplineNoteView,
  IdgRouteService,
  IdgScopedChildFacts,
  IdgScopedChildKind,
  MeetingScheduleView,
  MeetingView,
  MinutesView,
  PacketDetailView,
  PacketDigestView,
  PatientIdgHistoryView,
  RecurringPolicyView,
} from "./routes/service";
import {
  NOTE_PRESENT_STATUSES,
  actionItemMeetingAdjournedError,
  actionItemNotAssigneeError,
  addendumEligibilityUnavailableError,
  addendumImmutableError,
  assertMayWriteDisciplineNote,
  assertNoteVersion,
  deriveAddendumState,
  invalidCoordinatorError,
  minutesRenderStatus,
  normalizeNoteReason,
  noteFrozenError,
  noteInclusionError,
  planDisciplineNoteCreate,
  staleRowError,
  validateMeetingWindow,
} from "./routes/service";
import { getCarePlanReader } from "./seams/index";

const MTG = schema.idgMeeting;
const ATT = schema.idgAttendance;
const AGD = schema.idgAgendaItem;
const NOTE = schema.idgDisciplineNote;
const DEC = schema.idgDecision;
const ACK = schema.idgDecisionApplicationAck;
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
  coordinatorMembershipId: m.coordinatorMembershipId,
});

/**
 * The production, RLS-backed IdgRouteService + IdgAbacResolver. Reads + the write lifecycle are live over
 * Drizzle+RLS; every mutation emits `m14.*` / `idg.decision_recorded` on the bound transactional `outbox`.
 * Org is bound from the request context by the caller and passed as `orgId` — never the body.
 */
export function createDbIdgBackend(
  db: DbClient,
  outbox: IdgWriteOutboxPort = NOOP_OUTBOX,
  /**
   * M2's identity-owned batched staff display read (name only), the SAME port the routes use to enrich views.
   * Used ONLY to put `authorName` on the minutes re-render's addenda appendix; absent (slice/tests) => null names.
   */
  membershipDisplay?: IdgMembershipDisplayPort,
  /**
   * M1's org-explicit site display read (organization + location NAMES only), bound at the composition root.
   * Used ONLY to put `meeting.organizationName` / `meeting.locationName` on the minutes render payload (the PDF
   * header); unbound or failing => the header simply omits the names (never blocks a sign / addendum).
   */
  siteDisplay?: IdgSiteDisplayPort,
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
  /** Load a meeting taking a row lock (`FOR UPDATE`) until the surrounding tx ends. `adjournMeeting` UPDATEs the
   * meeting row before it reads the open decisions, so a decision write that holds this lock either commits first
   * (and is emitted by the adjournment) or is serialised after it and re-reads a non-live meeting. */
  async function lockMeeting(tx: DbClient, id: string): Promise<MeetingRow> {
    const [m] = await tx.select().from(MTG).where(eq(MTG.id, id)).limit(1).for("update");
    if (!m) throw new NotFoundError("idg_meeting");
    return m;
  }
  /** Flip the prior `emitted` -> `superseded` FIRST (conditional on `status = 'emitted'`: of two concurrent
   * supersedes only one matches the row, the loser is refused 409 before it can insert a second successor), then
   * insert the `open` successor into the target meeting and link the two. Returns the successor id. */
  async function flipAndInsertSuccessor(
    tx: DbClient,
    orgId: string,
    userId: string,
    prior: typeof DEC.$inferSelect,
    targetMeetingId: string,
    plan: ReturnType<typeof planDecisionSupersedeInto>,
  ): Promise<string> {
    const at = new Date();
    const flipped = await tx
      .update(DEC)
      .set({ status: "superseded", supersededAt: at, updatedAt: at })
      .where(and(eq(DEC.id, prior.id), eq(DEC.status, "emitted")))
      .returning({ id: DEC.id });
    if (flipped.length === 0) {
      // Lost the race to a concurrent supersede/emit: re-derive the precise 409 from the row as it now is.
      const [current] = await tx.select().from(DEC).where(eq(DEC.id, prior.id)).limit(1);
      planDecisionSupersede({ status: current?.status ?? "superseded" });
      throw new NotFoundError("idg_decision");
    }
    const [next] = await tx
      .insert(DEC)
      .values({
        organizationId: orgId,
        idgMeetingId: targetMeetingId,
        patientId: prior.patientId,
        carePlanId: prior.carePlanId, // the successor supersedes the SAME plan's decision (kind is copied verbatim)
        decisionKind: prior.decisionKind,
        payload: prior.payload,
        wasQuorate: plan.wasQuorate,
        quorumSnapshot: plan.quorumSnapshot,
        recordedByMembershipId: userId,
        status: "open",
      })
      .returning({ id: DEC.id });
    await tx.update(DEC).set({ supersededByDecisionId: next!.id }).where(eq(DEC.id, prior.id));
    return next!.id;
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
  /**
   * WINDOW B — which of `patientIds` were included by a NEWER ADJOURNED IDG meeting than `meetingId`: another meeting of
   * the org (RLS-scoped) with `status = 'adjourned'` and a LATER `actual_end` whose stored packet set (`idg_patient_packet`,
   * the authoritative inclusion signal, frozen once adjourned) OR patient-scoped agenda items contain the patient — the same
   * two signals {@link patientIncluded} uses. One batched read per signal (two queries total, never per patient).
   * FAIL-CLOSED: any error is a retryable 503 (`ADDENDUM_ELIGIBILITY_UNAVAILABLE`), never a silent allow.
   */
  async function patientsSupersededByNewerIdg(
    tx: DbClient,
    meetingId: string,
    actualEnd: Date,
    patientIds: readonly string[],
  ): Promise<Set<string>> {
    if (patientIds.length === 0) return new Set();
    try {
      const newer = and(
        ne(MTG.id, meetingId),
        eq(MTG.status, "adjourned"),
        gt(MTG.actualEnd, actualEnd),
      );
      const viaPackets = await tx
        .selectDistinct({ patientId: PKT.patientId })
        .from(PKT)
        .innerJoin(MTG, eq(MTG.id, PKT.idgMeetingId))
        .where(and(newer, inArray(PKT.patientId, [...patientIds])));
      const viaAgenda = await tx
        .selectDistinct({ patientId: AGD.patientId })
        .from(AGD)
        .innerJoin(MTG, eq(MTG.id, AGD.idgMeetingId))
        .where(and(newer, inArray(AGD.patientId, [...patientIds])));
      return new Set(
        [...viaPackets, ...viaAgenda]
          .map((r) => r.patientId)
          .filter((p): p is string => p !== null),
      );
    } catch {
      throw addendumEligibilityUnavailableError();
    }
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
  /**
   * The coordinator must be a real, ACTIVE membership of THIS org. `coordinator_membership_id` is a plain uuid
   * (no cross-module FK), so nothing else stops a foreign-org / revoked / pending / made-up id. `membership` is
   * M1-owned and M14 `dependsOn` M1, so the read is in-boundary. RLS pins the read to `app.org_id`; the explicit
   * org predicate is defense in depth. One uniform 422 for "absent", "other org" and "not active" so the
   * response is not an existence oracle for another tenant's membership ids.
   */
  async function assertCoordinatorMembership(
    tx: DbClient,
    orgId: string,
    membershipId: string,
  ): Promise<void> {
    const [row] = await tx
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.id, membershipId),
          eq(schema.memberships.organizationId, orgId),
          eq(schema.memberships.status, "active"),
        ),
      )
      .limit(1);
    if (!row) throw invalidCoordinatorError();
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

  /**
   * W-SUD-01 fact for a set of patients on ONE meeting: which of them a discipline note's text may be shown for
   * WITHOUT a Part 2 release. The SUD flag lives on the patient's packet snapshot (`patientCover.activeSudFlag`,
   * the same signal `mapPacketContent` reads). A patient with no readable packet is UNDETERMINABLE and is
   * treated as needing a release (fail-closed) — never assumed clear.
   */
  const patientsNeedingRelease = (
    tx: DbClient,
    meetingId: string,
    patientIds: readonly string[],
  ): Promise<Set<string>> => patientsNeedingReleaseForMeeting(tx, meetingId, patientIds);
  /**
   * Author display names for the addenda appendix of a minutes re-render. Resolved BEFORE (never inside) the
   * write transaction — the M2 port opens its own tenant tx, and nesting it would re-enter the pool mid-
   * transaction. Only an ADJOURNED meeting can have addenda, so a live one costs a single status read. A port
   * failure degrades to null names (an unresolvable name must never block an addendum), logged nowhere here:
   * the appendix simply shows the discipline without a name.
   */
  async function resolveAddendumAuthorNames(
    orgId: string,
    meetingId: string,
    extraMembershipIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>> {
    if (!membershipDisplay) return new Map();
    try {
      const ids = await withOrg(orgId, async (tx) => {
        const [m] = await tx
          .select({ status: MTG.status })
          .from(MTG)
          .where(eq(MTG.id, meetingId))
          .limit(1);
        if (m?.status !== "adjourned") return null;
        // Every membership the minutes render names (a superset of the addendum authors): the same map
        // feeds the addenda appendix AND the render context's `memberNames`.
        return loadMinutesMemberIds(tx, meetingId);
      });
      if (ids === null) return new Map();
      const all = [...new Set([...ids, ...extraMembershipIds])];
      if (all.length === 0) return new Map();
      const byId = await membershipDisplay.displayForMemberships(orgId, all);
      return new Map(all.map((id) => [id, byId.get(id)?.displayName ?? null]));
    } catch {
      return new Map();
    }
  }

  /**
   * The organization + meeting-location NAMES for the minutes PDF header, resolved BEFORE the write transaction
   * (the M1 port opens its own tenant tx). `onlyIfAdjourned` skips the port for a live meeting (a live note
   * emits nothing, so there is nothing to render). Degrades to null names when the port is unbound or throws.
   */
  async function resolveMinutesSiteNames(
    orgId: string,
    meetingId: string,
    onlyIfAdjourned: boolean,
  ): Promise<MinutesSiteNames | undefined> {
    if (!siteDisplay) return undefined;
    try {
      const m = await withOrg(orgId, async (tx) => {
        const [r] = await tx
          .select({ locationId: MTG.locationId, status: MTG.status })
          .from(MTG)
          .where(eq(MTG.id, meetingId))
          .limit(1);
        return r ?? null;
      });
      if (m === null || (onlyIfAdjourned && m.status !== "adjourned")) return undefined;
      const site = await siteDisplay.displayForSite(orgId, [m.locationId]);
      return {
        organizationName: site.organizationName,
        locationName: site.locationNames.get(m.locationId) ?? null,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Display names for EVERY membership a minutes render names (attendees, recorders, assignees, note authors),
   * resolved BEFORE the write transaction for the same reason as {@link resolveAddendumAuthorNames}. A port
   * failure degrades to no names — the PDF then falls back to the discipline label.
   */
  async function resolveMinutesMemberNames(
    orgId: string,
    meetingId: string,
  ): Promise<ReadonlyMap<string, string | null>> {
    if (!membershipDisplay) return new Map();
    try {
      const ids = await withOrg(orgId, (tx) => loadMinutesMemberIds(tx, meetingId));
      if (ids.length === 0) return new Map();
      const byId = await membershipDisplay.displayForMemberships(orgId, ids);
      return new Map(ids.map((id) => [id, byId.get(id)?.displayName ?? null]));
    } catch {
      return new Map();
    }
  }

  /**
   * The 'Addenda' appendix of the minutes render, built from the LIVE addendum rows (never the frozen
   * snapshot) inside the caller's tenant tx, in one batched read. 42 CFR Part 2 handling is the frozen
   * snapshot's, verbatim: for a patient whose text must be withheld (active SUD flag, or no packet to vouch
   * for them) the body AND the free-text reason are elided (`bodyWithheld`) and only metadata is kept.
   */
  async function buildDisciplineAddenda(
    tx: DbClient,
    meetingId: string,
    names: ReadonlyMap<string, string | null>,
  ): Promise<DisciplineAddendumRenderEntry[]> {
    const rows = await tx
      .select()
      .from(NOTE)
      .where(and(eq(NOTE.idgMeetingId, meetingId), eq(NOTE.isAddendum, true)))
      .orderBy(asc(NOTE.addendumRecordedAt), asc(NOTE.createdAt));
    const releaseNeeded = await patientsNeedingRelease(tx, meetingId, [
      ...new Set(rows.map((n) => n.patientId).filter((p): p is string => p !== null)),
    ]);
    return rows.map((n) => {
      const withheld = n.patientId !== null && releaseNeeded.has(n.patientId);
      return {
        noteId: n.id,
        patientId: n.patientId,
        discipline: n.discipline,
        authorMembershipId: n.authorMembershipId,
        authorName: names.get(n.authorMembershipId) ?? null,
        recordedAt: isoReq(n.addendumRecordedAt ?? n.createdAt),
        reason: withheld ? null : n.reason,
        bodyText: withheld ? null : n.bodyText,
        bodyWithheld: withheld,
      };
    });
  }

  const toNoteView = (r: typeof NOTE.$inferSelect, withheld: boolean): DisciplineNoteView => ({
    id: r.id,
    meetingId: r.idgMeetingId,
    patientId: r.patientId,
    discipline: r.discipline,
    bodyText: withheld ? null : r.bodyText,
    bodyWithheld: withheld,
    authorMembershipId: r.authorMembershipId,
    version: r.version,
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
    isAddendum: r.isAddendum,
    addendumRecordedAt: iso(r.addendumRecordedAt),
    // The reason is free-text PHI (optional on originals, required on addenda): withheld exactly when the body is.
    reason: withheld ? null : r.reason,
  });
  /** The attendance rows the note-write authorization reads (present/tardy/partial for the discipline). */
  async function attendanceForNotes(tx: DbClient, meetingId: string) {
    return tx
      .select({ membershipId: ATT.membershipId, discipline: ATT.discipline, status: ATT.status })
      .from(ATT)
      .where(and(eq(ATT.idgMeetingId, meetingId), inArray(ATT.status, [...NOTE_PRESENT_STATUSES])));
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
    linkedArtifactId: r.linkedArtifactId,
    version: r.version,
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
    version: r.version,
  });
  const toAttendanceView = (r: typeof ATT.$inferSelect): AttendanceView => ({
    id: r.id,
    meetingId: r.idgMeetingId,
    membershipId: r.membershipId,
    discipline: r.discipline,
    status: r.status,
    checkedInAt: iso(r.checkInAt) ?? "",
    disciplineAttested: r.disciplineAttested,
    recordedByMembershipId: r.recordedByMembershipId,
    version: r.version,
  });
  const toAgendaItemView = (r: typeof AGD.$inferSelect): AgendaItemView => ({
    id: r.id,
    meetingId: r.idgMeetingId,
    kind: r.kind,
    patientId: r.patientId,
    version: r.version,
    ...(r.promotionRequestId !== null &&
    r.sourceMessageId !== null &&
    r.sourceAuthorUserId !== null &&
    r.sourceSentAt !== null
      ? {
          promotion: {
            request_id: r.promotionRequestId,
            source_author_user_id: r.sourceAuthorUserId,
            source_sent_at: r.sourceSentAt.toISOString(),
            source_message_id: r.sourceMessageId,
          },
        }
      : {}),
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
            coordinatorMembershipId: MTG.coordinatorMembershipId,
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
          coordinatorMembershipId: r.coordinatorMembershipId,
        }));
      });
    },
    async scheduleMeeting(orgId, userId, args): Promise<MeetingView> {
      validateMeetingWindow(args.scheduledStart, args.scheduledEnd, Date.now());
      const start = new Date(args.scheduledStart);
      const end = new Date(args.scheduledEnd);
      return withOrg(orgId, async (tx) => {
        // Serialise concurrent creates for the same location so the overlap check below cannot race.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`idg_meeting:${args.locationId}`}))`,
        );
        if (args.coordinatorMembershipId !== undefined) {
          // Only an explicit coordinator needs checking — the default is the caller's own (session) membership.
          await assertCoordinatorMembership(tx, orgId, args.coordinatorMembershipId);
        }
        const [clash] = await tx
          .select({ id: MTG.id })
          .from(MTG)
          .where(
            and(
              eq(MTG.locationId, args.locationId),
              notInArray(MTG.status, ["cancelled", "rescheduled"]),
              lt(MTG.scheduledStart, end),
              gt(MTG.scheduledEnd, start),
            ),
          )
          .limit(1);
        if (clash) {
          throw new WardenXError(
            "IDG_MEETING_OVERLAP",
            "another IDG meeting at this location overlaps the requested window",
            409,
          );
        }
        const [row] = await tx
          .insert(MTG)
          .values({
            organizationId: orgId,
            locationId: args.locationId,
            recurringPolicyId: null,
            scheduledStart: start,
            scheduledEnd: end,
            status: "scheduled",
            coordinatorMembershipId: args.coordinatorMembershipId ?? userId,
            // Platform-floor quorum, verbatim — same as the schedule worker (no per-tenant tightening surface).
            tenantQuorumSnapshot: IDG_REQUIRED_QUORUM,
          })
          .returning();
        await emit(tx, orgId, "m14.meeting.scheduled", "idg_meeting", row!.id, {
          meetingId: row!.id,
          locationId: row!.locationId,
          scheduledStart: start.toISOString(),
          scheduledEnd: end.toISOString(),
        });
        return toMeetingView(row!);
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
    async getPacket(orgId, meetingId, patientId, viewer): Promise<PacketDetailView> {
      // Load the stored row inside the tenant tx (RLS-scoped), then map OUTSIDE it: the W-SUD-01 consent
      // round-trip (M39) must not run while this read transaction is held open.
      const r = await withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const [row] = await tx
          .select({
            id: PKT.id,
            frozenAt: PKT.frozenAt,
            builtSnapshot: PKT.builtSnapshot,
            disciplineViews: PKT.disciplineViews,
          })
          .from(PKT)
          .where(and(eq(PKT.idgMeetingId, meetingId), eq(PKT.patientId, patientId)))
          .orderBy(desc(PKT.builtAt))
          .limit(1);
        if (!row) throw new NotFoundError("idg_patient_packet");
        return row;
      });
      const mapped = await mapPacketContent(r, () =>
        viewer ? viewer.sudDisclosureAllowed(patientId) : Promise.resolve(false),
      );
      if (mapped.appliedSudRedaction) {
        viewer?.onSudRedaction?.({ patientId, redactedEntryCount: mapped.redactedEntryCount });
      }
      return {
        packetId: r.id,
        meetingId,
        patientId,
        frozenAt: iso(r.frozenAt),
        content: mapped.content,
        appliedSudRedaction: mapped.appliedSudRedaction,
        redactionNotice: mapped.redactionNotice,
      };
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
    async listActionItems(orgId, q, scope): Promise<ActionItemView[]> {
      return withOrg(orgId, async (tx) => {
        const filters = [
          eq(ACT.assignedToMembershipId, scope.assigneeMembershipId),
          scope.locationIds === null
            ? undefined
            : scope.locationIds.length === 0
              ? sql`false`
              : inArray(MTG.locationId, [...scope.locationIds]),
          scope.patientIds === null
            ? undefined
            : scope.patientIds.length === 0
              ? isNull(ACT.patientId)
              : or(isNull(ACT.patientId), inArray(ACT.patientId, [...scope.patientIds])),
          q.status !== undefined ? eq(ACT.status, q.status) : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        const rows = await tx
          .select({ actionItem: ACT })
          .from(ACT)
          .innerJoin(MTG, eq(MTG.id, ACT.idgMeetingId))
          .where(and(...filters));
        return rows.map((row) => toActionItemView(row.actionItem));
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
      const finalizerDiscipline = (
        snapshot: unknown,
        membershipId: string | null,
      ): string | null => {
        if (membershipId === null || !Array.isArray(snapshot)) return null;
        const hit = (
          snapshot as ReadonlyArray<{ membershipId?: unknown; discipline?: unknown }>
        ).find((a) => a?.membershipId === membershipId);
        return typeof hit?.discipline === "string" ? hit.discipline : null;
      };
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
            disciplineNoteSnapshot: MIN.disciplineNoteSnapshot,
          })
          .from(MIN)
          .where(eq(MIN.idgMeetingId, meetingId))
          .limit(1);
        if (!r) throw new NotFoundError("idg_minutes");
        // LIVE count of late addenda (the frozen snapshot never changes after adjournment).
        const [addenda] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(NOTE)
          .where(and(eq(NOTE.idgMeetingId, meetingId), eq(NOTE.isAddendum, true)));
        // WINDOW B read model: closes-at + which of this meeting's patients a newer adjourned IDG has superseded.
        const [mtg] = await tx
          .select({ status: MTG.status, actualEnd: MTG.actualEnd })
          .from(MTG)
          .where(eq(MTG.id, meetingId))
          .limit(1);
        const nowAt = new Date();
        const base = deriveAddendumState({
          status: mtg?.status ?? "",
          adjournedAt: mtg?.actualEnd ?? null,
          now: nowAt,
          supersededPatientIds: [],
        });
        let superseded: string[] = [];
        if (base.open && mtg?.actualEnd) {
          // Read-model only: a failed supersession lookup must NOT take the finalized-minutes read down. It runs
          // in a savepoint (a failed statement would otherwise abort the whole tx) and degrades to "none
          // superseded" — the addendum WRITE re-checks and stays fail-closed (503 ADDENDUM_ELIGIBILITY_UNAVAILABLE).
          const actualEnd = mtg.actualEnd;
          try {
            superseded = await tx.transaction(async (sp) => {
              const [pk, ag] = await Promise.all([
                sp.select({ p: PKT.patientId }).from(PKT).where(eq(PKT.idgMeetingId, meetingId)),
                sp.select({ p: AGD.patientId }).from(AGD).where(eq(AGD.idgMeetingId, meetingId)),
              ]);
              const included = [
                ...new Set([...pk, ...ag].map((x) => x.p).filter((p): p is string => p !== null)),
              ];
              return [...(await patientsSupersededByNewerIdg(sp, meetingId, actualEnd, included))];
            });
          } catch {
            superseded = [];
          }
        }
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
          renderStatus: minutesRenderStatus(r.status, r.minutesDocumentId),
          // The finalizer's discipline off M14's OWN frozen attendance snapshot (`{membershipId, discipline}`
          // per row) — null when they were not on the roster (e.g. an admin finalizing without attending).
          finalizedByDiscipline: finalizerDiscipline(
            r.attendanceSnapshot,
            r.finalizedByMembershipId,
          ),
          attendanceCount: size(r.attendanceSnapshot),
          decisionCount: size(r.decisionListSnapshot),
          actionItemCount: size(r.actionItemListSnapshot),
          disciplineNoteCount: size(r.disciplineNoteSnapshot),
          disciplineAddendumCount: addenda?.n ?? 0,
          addendumState: deriveAddendumState({
            status: mtg?.status ?? "",
            adjournedAt: mtg?.actualEnd ?? null,
            now: nowAt,
            supersededPatientIds: superseded,
          }),
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
        // F-234 — downstream "applied" acknowledgements (M15 today), metadata only, one query for the list.
        const acks =
          rows.length === 0
            ? []
            : await tx
                .select()
                .from(ACK)
                .where(
                  and(
                    eq(ACK.idgMeetingId, meetingId),
                    inArray(
                      ACK.idgDecisionId,
                      rows.map((r) => r.id),
                    ),
                  ),
                )
                .orderBy(asc(ACK.acknowledgedAt));
        return rows.map((r) => ({
          ...toDecisionView(r),
          applications: acks
            .filter((a) => a.idgDecisionId === r.id)
            .map((a) => ({
              module: "m15" as const,
              planId: a.planId,
              versionId: a.versionId,
              mutationsApplied: a.mutationsApplied,
              acknowledgedAt: isoReq(a.acknowledgedAt),
            })),
        }));
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
          version: row!.version,
        };
      });
    },
    async updateRecurringPolicy(
      orgId,
      _userId,
      id,
      args,
      expectedVersion?: number,
    ): Promise<RecurringPolicyView> {
      return withOrg(orgId, async (tx) => {
        const [existing] = await tx.select().from(POL).where(eq(POL.id, id)).limit(1);
        if (!existing) throw new NotFoundError("idg_recurring_policy");
        if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, existing.version);
        const [row] = await tx
          .update(POL)
          .set({
            cadenceDays: args.cadenceDays,
            active: args.active ?? existing.active,
            version: existing.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(POL.id, id), eq(POL.version, existing.version)))
          .returning();
        if (!row) throw staleRowError(existing.version);
        return {
          id: row.id,
          locationId: row.locationId,
          cadenceDays: row.cadenceDays,
          active: row.active,
          version: row.version,
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
        const m = await lockMeeting(tx, id);
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
        const [cancelled] = await tx
          .update(MTG)
          .set({
            status: "cancelled",
            cancellationReason: reason,
            version: m.version + 1,
            updatedAt: at,
          })
          .where(and(eq(MTG.id, id), eq(MTG.status, m.status), eq(MTG.version, m.version)))
          .returning({ id: MTG.id });
        if (!cancelled) throw staleRowError(m.version);
        // D8 — a cancelled meeting no longer counts toward any action item's carry-forward count: re-derive the
        // count of every item it had carried, in this same tx (cheap: one indexed read + ≤1 UPDATE per item).
        await recomputeCarryForwardCountsForMeeting(tx, orgId, id, at);
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
        const prior = await lockMeeting(tx, id);
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
        const [rescheduled] = await tx
          .update(MTG)
          .set({ status: "rescheduled", version: prior.version + 1, updatedAt: at })
          .where(and(eq(MTG.id, id), eq(MTG.status, prior.status), eq(MTG.version, prior.version)))
          .returning({ id: MTG.id });
        if (!rescheduled) throw staleRowError(prior.version);
        // D8 — a rescheduled-away meeting does not count either (its successor counts once if it carries the item).
        await recomputeCarryForwardCountsForMeeting(tx, orgId, id, at);
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
        const m = await lockMeeting(tx, id);
        const pkts = await tx.select({ id: PKT.id }).from(PKT).where(eq(PKT.idgMeetingId, id));
        const n = pkts.length;
        transitionMeeting(m.status, { type: "BUILD_PACKETS", includedPatientCount: n });
        const at = new Date();
        const [updated] = await tx
          .update(MTG)
          .set({ status: "packets_building", version: m.version + 1, updatedAt: at })
          .where(and(eq(MTG.id, id), eq(MTG.status, m.status), eq(MTG.version, m.version)))
          .returning({ id: MTG.id });
        if (!updated) throw staleRowError(m.version);
        await emit(tx, orgId, "m14.packets.build_started", "idg_meeting", id, {
          meetingId: id,
          includedPatientCount: n,
        });
        return toMeetingView({ ...m, status: "packets_building" });
      });
    },
    async startMeeting(orgId, userId, id): Promise<MeetingView> {
      return withOrg(orgId, async (tx) => {
        const m = await lockMeeting(tx, id);
        transitionMeeting(m.status, { type: "START" });
        const at = new Date();
        const [updated] = await tx
          .update(MTG)
          .set({ status: "live", actualStart: at, version: m.version + 1, updatedAt: at })
          .where(and(eq(MTG.id, id), eq(MTG.status, "packets_ready"), eq(MTG.version, m.version)))
          .returning({ id: MTG.id });
        if (!updated) throw staleRowError(m.version);
        await emit(tx, orgId, "m14.meeting.started", "idg_meeting", id, {
          meetingId: id,
          startedByMembershipId: userId,
          startedAt: at.toISOString(),
        });
        return toMeetingView({ ...m, status: "live", actualStart: at });
      });
    },
    async adjournMeeting(orgId, userId, id, stepUpFresh): Promise<MeetingView> {
      const minutesMemberNames = await resolveMinutesMemberNames(orgId, id);
      const minutesSite = await resolveMinutesSiteNames(orgId, id, false);
      return withOrg(orgId, async (tx) => {
        const m = await lockMeeting(tx, id);
        // `transitionMeeting` raises STEP_UP_REQUIRED (412) when the fresh step-up is absent (§2.2 D13).
        transitionMeeting(m.status, { type: "ADJOURN", stepUpFresh });
        const at = new Date();
        const [adjourned] = await tx
          .update(MTG)
          .set({ status: "adjourned", actualEnd: at, version: m.version + 1, updatedAt: at })
          .where(and(eq(MTG.id, id), eq(MTG.status, "live"), eq(MTG.version, m.version)))
          .returning({ id: MTG.id });
        if (!adjourned) throw staleRowError(m.version);

        // The commit point: emit every open decision (actionable + patient-scoped → the cross-module seam),
        // freeze packets, finalize the minutes (§2.7).
        const openDecisions = await tx
          .select()
          .from(DEC)
          .where(and(eq(DEC.idgMeetingId, id), eq(DEC.status, "open")));
        let decisionsEmittedCount = 0;
        for (const d of openDecisions) {
          const [emitted] = await tx
            .update(DEC)
            .set({ status: "emitted", emittedAt: at, updatedAt: at })
            .where(and(eq(DEC.id, d.id), eq(DEC.status, "open")))
            .returning({ id: DEC.id });
          if (!emitted) {
            throw new IdgStateError(
              "DECISION_NOT_OPEN",
              "A decision changed while the meeting was being finalized.",
            );
          }
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

        // Per-discipline notes (spec extension): frozen WITH their text, except that the text of a note about
        // a patient with an active SUD flag — or one no packet can vouch for — is elided (`bodyWithheld`):
        // the snapshot feeds the M22 render and outlives any per-caller Part 2 verdict, so it fails closed.
        // Meeting-level notes (no patient) always carry their text. Notes stay readable, per caller, via
        // `GET /idg/meetings/:id/discipline-notes`.
        const noteRows = await tx
          .select()
          .from(NOTE)
          .where(eq(NOTE.idgMeetingId, id))
          .orderBy(asc(NOTE.createdAt));
        const releaseNeeded = await patientsNeedingRelease(tx, id, [
          ...new Set(noteRows.map((n) => n.patientId).filter((p): p is string => p !== null)),
        ]);
        const disciplineNoteSnapshot: DisciplineNoteSnapshotEntry[] = noteRows.map((n) => {
          const withheld = n.patientId !== null && releaseNeeded.has(n.patientId);
          return {
            noteId: n.id,
            patientId: n.patientId,
            discipline: n.discipline,
            bodyText: withheld ? null : n.bodyText,
            bodyWithheld: withheld,
            // Same fail-closed Part 2 elision as the text: the reason is free-text PHI too.
            reason: withheld ? null : n.reason,
            authorMembershipId: n.authorMembershipId,
            version: n.version,
            createdAt: isoReq(n.createdAt),
            updatedAt: isoReq(n.updatedAt),
          };
        });

        const minutesId = await ensureMinutes(tx, orgId, id);
        const finalized = await tx
          .update(MIN)
          .set({
            status: "final",
            finalizedByMembershipId: userId,
            finalizedAt: at,
            attendanceSnapshot,
            decisionListSnapshot,
            actionItemListSnapshot,
            disciplineNoteSnapshot,
            updatedAt: at,
          })
          .where(and(eq(MIN.id, minutesId), eq(MIN.status, "in_progress")))
          .returning({ id: MIN.id });
        if (finalized.length === 0) {
          throw new IdgStateError(
            "MINUTES_NOT_IN_PROGRESS",
            "The minutes have already been finalized.",
          );
        }

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
          renderPayload: {
            attendanceSnapshot,
            decisionListSnapshot,
            actionItemListSnapshot,
            disciplineNoteSnapshot,
            ...(await loadMinutesRenderContext(tx, {
              meetingId: id,
              minutesId,
              names: minutesMemberNames,
              site: minutesSite,
            })),
          },
        });
        return toMeetingView({ ...m, status: "adjourned", actualEnd: at });
      });
    },

    // ── attendance (writes) ────────────────────────────────────────────────────────────────────────────
    async recordAttendance(orgId, _userId, meetingId, args): Promise<AttendanceView> {
      return withOrg(orgId, async (tx) => {
        const meeting = await lockMeeting(tx, meetingId);
        assertMeetingWriteAllowed(meeting.status, "attendance");
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
            recordedByMembershipId: args.recordedByMembershipId ?? null,
            disciplineAttested: args.disciplineAttested ?? false,
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
          disciplineAttested: args.disciplineAttested ?? false,
          recordedByMembershipId: args.recordedByMembershipId ?? null,
          version: 0,
        };
      });
    },
    async updateAttendance(orgId, _userId, id, status, expectedVersion): Promise<AttendanceView> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select().from(ATT).where(eq(ATT.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_attendance");
        const meeting = await lockMeeting(tx, row.idgMeetingId);
        assertMeetingWriteAllowed(meeting.status, "attendance");
        if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
        const bumped = await tx
          .update(ATT)
          .set({ status, version: row.version + 1, updatedAt: new Date() })
          .where(and(eq(ATT.id, id), eq(ATT.version, row.version)))
          .returning({ id: ATT.id });
        if (bumped.length === 0) throw staleRowError(row.version);
        return {
          id: row.id,
          meetingId: row.idgMeetingId,
          membershipId: row.membershipId,
          discipline: row.discipline,
          status,
          checkedInAt: iso(row.checkInAt) ?? "",
          disciplineAttested: row.disciplineAttested,
          recordedByMembershipId: row.recordedByMembershipId,
          version: row.version + 1,
        };
      });
    },
    async removeAttendance(
      orgId,
      _userId,
      id,
      expectedVersion?: number,
    ): Promise<{ id: string; removed: true }> {
      // No DELETE grant (compromise #2) → soft-remove to `excused` (out of the quorum present-set).
      return withOrg(orgId, async (tx) => {
        const [row] = await tx
          .select({ id: ATT.id, meetingId: ATT.idgMeetingId, version: ATT.version })
          .from(ATT)
          .where(eq(ATT.id, id))
          .limit(1);
        if (!row) throw new NotFoundError("idg_attendance");
        const meeting = await lockMeeting(tx, row.meetingId);
        assertMeetingWriteAllowed(meeting.status, "attendance");
        if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
        const bumped = await tx
          .update(ATT)
          .set({ status: "excused", version: row.version + 1, updatedAt: new Date() })
          .where(and(eq(ATT.id, id), eq(ATT.version, row.version)))
          .returning({ id: ATT.id });
        if (bumped.length === 0) throw staleRowError(row.version);
        return { id, removed: true };
      });
    },

    // ── agenda (writes) ────────────────────────────────────────────────────────────────────────────────
    async addAgendaItem(orgId, userId, meetingId, args): Promise<AgendaItemView> {
      return withOrg(orgId, async (tx) => {
        const meeting = await lockMeeting(tx, meetingId);
        assertMeetingWriteAllowed(meeting.status, "agenda");
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
        return {
          id: row!.id,
          meetingId,
          kind: args.kind,
          patientId: args.patientId ?? null,
          version: 0,
        };
      });
    },
    async listChartPromotions(orgId, meetingId, q) {
      await withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
      });
      return listForPatients(orgId, q.patientIds, q.reviewerUserId);
    },
    async addAgendaItemFromPromotion(
      orgId,
      membershipId,
      meetingId,
      args,
    ): Promise<AgendaItemView> {
      // The seam reads in its own tenant context, so resolve it BEFORE opening the write transaction.
      const review = await requireReview(orgId, args.requestId, args.reviewerUserId, args.inScope);
      try {
        return await withOrg(orgId, async (tx) => {
          const meeting = await lockMeeting(tx, meetingId);
          assertMeetingWriteAllowed(meeting.status, "agenda");
          const existing = await tx
            .select({ id: AGD.id })
            .from(AGD)
            .where(eq(AGD.idgMeetingId, meetingId));
          const [row] = await tx
            .insert(AGD)
            .values({
              organizationId: orgId,
              idgMeetingId: meetingId,
              patientId: review.patientId,
              // A fixed generic title: nothing from the message is ever copied into the agenda.
              title: PROMOTED_AGENDA_TITLE,
              kind: "other",
              sortOrder: existing.length,
              addedByMembershipId: membershipId,
              promotionRequestId: review.requestId,
              sourceMessageId: review.sourceMessageId,
              sourceAuthorUserId: review.sourceAuthorUserId,
              sourceSentAt: new Date(review.sourceSentAt),
              sourceBodySha256: review.sourceBodySha256,
            })
            .returning();
          // Same transaction as the insert: the proposal is accepted if and only if the agenda item exists.
          await emit(
            tx,
            orgId,
            CHART_PROMOTION_DECIDED_EVENT,
            "idg_agenda_item",
            row!.id,
            decidedPayload({
              organizationId: orgId,
              promotionRequestId: review.requestId,
              outcome: "accepted",
              resultRef: row!.id,
              decidedByUserId: args.reviewerUserId,
              reasonCode: null,
              at: new Date(),
            }),
          );
          return toAgendaItemView(row!);
        });
      } catch (err) {
        return mapPromotionInsertError(err);
      }
    },
    async rejectChartPromotion(orgId, meetingId, requestId, args) {
      await requireReview(orgId, requestId, args.reviewerUserId, args.inScope);
      await withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        // An agenda item already raised from this proposal means it was acted on: rejecting would leave an attributed
        // item against a request that says rejected.
        const [item] = await tx
          .select({ id: AGD.id })
          .from(AGD)
          .where(eq(AGD.promotionRequestId, requestId))
          .limit(1);
        if (item) throw promotionHasItem();
        await emit(
          tx,
          orgId,
          CHART_PROMOTION_DECIDED_EVENT,
          "idg_meeting",
          meetingId,
          decidedPayload({
            organizationId: orgId,
            promotionRequestId: requestId,
            outcome: "rejected",
            resultRef: null,
            decidedByUserId: args.reviewerUserId,
            reasonCode: args.reasonCode,
            at: new Date(),
          }),
        );
      });
      return { promotionRequestId: requestId, outcome: "rejected" };
    },
    async updateAgendaItem(orgId, _userId, id, expectedVersion): Promise<AgendaItemView> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select().from(AGD).where(eq(AGD.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_agenda_item");
        const meeting = await lockMeeting(tx, row.idgMeetingId);
        assertMeetingWriteAllowed(meeting.status, "agenda");
        if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
        return {
          id: row.id,
          meetingId: row.idgMeetingId,
          kind: row.kind,
          patientId: row.patientId,
          version: row.version,
        };
      });
    },
    async removeAgendaItem(
      orgId,
      _userId,
      id,
      expectedVersion?: number,
    ): Promise<{ id: string; removed: true }> {
      // No DELETE grant + no tombstone column on the append-only agenda (compromise #2) → tenant-checked no-op.
      return withOrg(orgId, async (tx) => {
        const [row] = await tx
          .select({ id: AGD.id, meetingId: AGD.idgMeetingId, version: AGD.version })
          .from(AGD)
          .where(eq(AGD.id, id))
          .limit(1);
        if (!row) throw new NotFoundError("idg_agenda_item");
        const meeting = await lockMeeting(tx, row.meetingId);
        assertMeetingWriteAllowed(meeting.status, "agenda");
        if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
        return { id, removed: true };
      });
    },

    // ── discipline notes (spec extension) ───────────────────────────────────────────────────────────────
    async listDisciplineNotes(orgId, meetingId, q, viewer): Promise<DisciplineNoteView[]> {
      // Read inside the tenant tx, resolve the W-SUD-01 consent verdicts OUTSIDE it (the M39 seam opens its
      // own request-scoped tx — nesting it inside `withOrg` would re-enter the pool mid-transaction).
      const { rows, needs } = await withOrg(orgId, async (tx) => {
        if (!(await meetingExists(tx, meetingId))) throw new NotFoundError("idg_meeting");
        const where =
          q.patientId === undefined
            ? eq(NOTE.idgMeetingId, meetingId)
            : and(eq(NOTE.idgMeetingId, meetingId), eq(NOTE.patientId, q.patientId));
        const found = await tx.select().from(NOTE).where(where).orderBy(asc(NOTE.createdAt));
        const patientIds = [
          ...new Set(found.map((n) => n.patientId).filter((p): p is string => p !== null)),
        ];
        return { rows: found, needs: await patientsNeedingRelease(tx, meetingId, patientIds) };
      });
      const verdict = new Map<string, boolean>();
      for (const pid of needs) {
        let ok = false;
        try {
          ok = viewer ? await viewer.sudDisclosureAllowed(pid) : false;
        } catch {
          ok = false; // an outage denies
        }
        verdict.set(pid, ok);
        if (!ok) viewer?.onSudRedaction?.({ patientId: pid, redactedEntryCount: 0 });
      }
      return rows.map((n) =>
        toNoteView(
          n,
          n.patientId !== null && needs.has(n.patientId) && verdict.get(n.patientId) !== true,
        ),
      );
    },
    async createDisciplineNote(orgId, actor, meetingId, args): Promise<DisciplineNoteView> {
      const addendumAuthorNames = await resolveAddendumAuthorNames(orgId, meetingId, [
        actor.membershipId,
      ]);
      const addendumSite = await resolveMinutesSiteNames(orgId, meetingId, true);
      return withOrg(orgId, async (tx) => {
        // Serialize ordinary notes against adjournment so every committed live note is included in the
        // frozen minutes snapshot. Late addenda take the same parent lock before the minutes lock, keeping
        // one lock order for adjournment and addendum rendering.
        const m = await lockMeeting(tx, meetingId);
        // live => an ordinary note; adjourned + in-window + reason => a LATE ADDENDUM (a new row — the frozen
        // minutes snapshot is never touched); anything else => 422. The server clock is the recorded-at.
        const nowAt = new Date();
        const patientId = args.patientId ?? null;
        // WINDOW B fact — only looked up for a patient-scoped note on an adjourned meeting (fail-closed 503).
        const newerAdjournedIdgForPatient =
          m.status === "adjourned" && patientId !== null && m.actualEnd
            ? (await patientsSupersededByNewerIdg(tx, meetingId, m.actualEnd, [patientId])).has(
                patientId,
              )
            : false;
        const plan = planDisciplineNoteCreate({
          status: m.status,
          adjournedAt: m.actualEnd ?? null,
          now: nowAt,
          reason: args.reason,
          patientId,
          newerAdjournedIdgForPatient,
        });
        let providerEntityId: string | null = null;
        if (patientId !== null) {
          // Inclusion is the packet set (authoritative) OR a patient-scoped agenda item — the same rule the
          // decision write uses (`patientIncluded`). The packet, when present, also supplies the tenancy pair.
          if (!(await patientIncluded(tx, meetingId, patientId))) throw noteInclusionError();
          const [pkt] = await tx
            .select({ providerEntityId: PKT.providerEntityId })
            .from(PKT)
            .where(and(eq(PKT.idgMeetingId, meetingId), eq(PKT.patientId, patientId)))
            .limit(1);
          providerEntityId = pkt?.providerEntityId ?? null;
        }
        assertMayWriteDisciplineNote(
          actor,
          args.discipline,
          await attendanceForNotes(tx, meetingId),
        );
        const [row] = await tx
          .insert(NOTE)
          .values({
            organizationId: orgId,
            providerEntityId,
            locationId: m.locationId,
            idgMeetingId: meetingId,
            patientId,
            discipline: args.discipline,
            bodyText: args.bodyText,
            authorMembershipId: actor.membershipId,
            isAddendum: plan.isAddendum,
            addendumRecordedAt: plan.addendumRecordedAt,
            reason: plan.reason,
            createdAt: nowAt,
            updatedAt: nowAt,
          })
          .returning();
        // The M4 write-audit trigger records the INSERT (body_text + reason denylisted). A LIVE note
        // emits nothing — nothing downstream consumes it until it is frozen into the minutes at adjournment.
        // A LATE ADDENDUM emits `m14.discipline_note.addendum_recorded` in this SAME transaction: M22 appends a
        // new VERSION of the minutes document carrying the 'Addenda' appendix. It never re-opens or mutates the
        // frozen minutes snapshot (the snapshot columns are re-read here only to ride the render payload).
        if (plan.isAddendum) {
          // Lock the minutes row so concurrent addenda serialize: each emit then reads the full committed
          // addendum set, and the last event in outbox order always carries every addendum.
          const [min] = await tx
            .select({
              id: MIN.id,
              attendanceSnapshot: MIN.attendanceSnapshot,
              decisionListSnapshot: MIN.decisionListSnapshot,
              actionItemListSnapshot: MIN.actionItemListSnapshot,
              disciplineNoteSnapshot: MIN.disciplineNoteSnapshot,
            })
            .from(MIN)
            .where(eq(MIN.idgMeetingId, meetingId))
            .limit(1)
            .for("update");
          if (min) {
            const disciplineAddenda = await buildDisciplineAddenda(
              tx,
              meetingId,
              addendumAuthorNames,
            );
            const renderContext = await loadMinutesRenderContext(tx, {
              meetingId,
              minutesId: min.id,
              names: addendumAuthorNames,
              site: addendumSite,
            });
            await emit(tx, orgId, "m14.discipline_note.addendum_recorded", "idg_minutes", min.id, {
              minutesId: min.id,
              meetingId,
              addendumId: row!.id,
              addendumCount: disciplineAddenda.length,
              recordedByMembershipId: actor.membershipId,
              renderPayload: {
                attendanceSnapshot: min.attendanceSnapshot,
                decisionListSnapshot: min.decisionListSnapshot,
                actionItemListSnapshot: min.actionItemListSnapshot,
                disciplineNoteSnapshot: min.disciplineNoteSnapshot,
                disciplineAddenda,
                ...renderContext,
              },
            });
          }
        }
        return toNoteView(row!, false);
      });
    },
    async updateDisciplineNote(
      orgId,
      actor,
      id,
      patch,
      ifMatchVersion,
    ): Promise<DisciplineNoteView> {
      return withOrg(orgId, async (tx) => {
        const [cur] = await tx.select().from(NOTE).where(eq(NOTE.id, id)).limit(1);
        if (!cur) throw new NotFoundError("idg_discipline_note");
        const m = await lockMeeting(tx, cur.idgMeetingId);
        if (cur.isAddendum) throw addendumImmutableError(); // append-only: correct with a further addendum
        if (m.status !== "live") throw noteFrozenError();
        assertMayWriteDisciplineNote(
          actor,
          cur.discipline,
          await attendanceForNotes(tx, cur.idgMeetingId),
        );
        if (!actor.isCoordinator && cur.authorMembershipId !== actor.membershipId) {
          throw new ForbiddenError("only the note's author or a coordinator may edit it");
        }
        assertNoteVersion(ifMatchVersion, cur.version);
        const at = new Date();
        // Compare-and-set on the version: a concurrent edit that slipped between the read and this UPDATE
        // matches no row (=> 412), so the If-Match precondition holds under the race too.
        const [row] = await tx
          .update(NOTE)
          .set({
            ...(patch.bodyText !== undefined ? { bodyText: patch.bodyText } : {}),
            ...(patch.reason !== undefined ? { reason: normalizeNoteReason(patch.reason) } : {}),
            version: cur.version + 1,
            updatedAt: at,
          })
          .where(and(eq(NOTE.id, id), eq(NOTE.version, cur.version)))
          .returning();
        if (!row) assertNoteVersion(ifMatchVersion, cur.version + 1);
        return toNoteView(row!, false);
      });
    },
    async disciplineNoteMeetingId(orgId, id): Promise<string | null> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx
          .select({ meetingId: NOTE.idgMeetingId })
          .from(NOTE)
          .where(eq(NOTE.id, id))
          .limit(1);
        return row?.meetingId ?? null;
      });
    },

    async decisionMeetingId(orgId, id): Promise<string | null> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx
          .select({ meetingId: DEC.idgMeetingId })
          .from(DEC)
          .where(eq(DEC.id, id))
          .limit(1);
        return row?.meetingId ?? null;
      });
    },

    async scopedChildFacts(
      orgId,
      kind: IdgScopedChildKind,
      id,
    ): Promise<IdgScopedChildFacts | null> {
      return withOrg(orgId, async (tx) => {
        if (kind === "agenda_item") {
          const [row] = await tx
            .select({
              meetingId: AGD.idgMeetingId,
              locationId: MTG.locationId,
              patientId: AGD.patientId,
            })
            .from(AGD)
            .innerJoin(MTG, eq(MTG.id, AGD.idgMeetingId))
            .where(eq(AGD.id, id))
            .limit(1);
          return row ? { ...row, assignedToMembershipId: null } : null;
        }
        if (kind === "attendance") {
          const [row] = await tx
            .select({ meetingId: ATT.idgMeetingId, locationId: MTG.locationId })
            .from(ATT)
            .innerJoin(MTG, eq(MTG.id, ATT.idgMeetingId))
            .where(eq(ATT.id, id))
            .limit(1);
          return row ? { ...row, patientId: null, assignedToMembershipId: null } : null;
        }
        if (kind === "decision") {
          const [row] = await tx
            .select({
              meetingId: DEC.idgMeetingId,
              locationId: MTG.locationId,
              patientId: DEC.patientId,
            })
            .from(DEC)
            .innerJoin(MTG, eq(MTG.id, DEC.idgMeetingId))
            .where(eq(DEC.id, id))
            .limit(1);
          return row ? { ...row, assignedToMembershipId: null } : null;
        }
        if (kind === "action_item") {
          const [row] = await tx
            .select({
              meetingId: ACT.idgMeetingId,
              locationId: MTG.locationId,
              patientId: ACT.patientId,
              assignedToMembershipId: ACT.assignedToMembershipId,
            })
            .from(ACT)
            .innerJoin(MTG, eq(MTG.id, ACT.idgMeetingId))
            .where(eq(ACT.id, id))
            .limit(1);
          return row ?? null;
        }
        if (kind === "discipline_note") {
          const [row] = await tx
            .select({
              meetingId: NOTE.idgMeetingId,
              locationId: MTG.locationId,
              patientId: NOTE.patientId,
            })
            .from(NOTE)
            .innerJoin(MTG, eq(MTG.id, NOTE.idgMeetingId))
            .where(eq(NOTE.id, id))
            .limit(1);
          return row ? { ...row, assignedToMembershipId: null } : null;
        }
        const [row] = await tx
          .select({ meetingId: MIN.idgMeetingId, locationId: MTG.locationId })
          .from(MIN)
          .innerJoin(MTG, eq(MTG.id, MIN.idgMeetingId))
          .where(eq(MIN.id, id))
          .limit(1);
        return row ? { ...row, patientId: null, assignedToMembershipId: null } : null;
      });
    },

    async recurringPolicyLocationId(orgId, id): Promise<string | null> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx
          .select({ locationId: POL.locationId })
          .from(POL)
          .where(eq(POL.id, id))
          .limit(1);
        return row?.locationId ?? null;
      });
    },

    // ── decisions (writes) ─────────────────────────────────────────────────────────────────────────────
    async recordDecision(orgId, userId, meetingId, args): Promise<DecisionView> {
      // Resolved BEFORE the write tx: the seam read opens its own request-scoped tx, and nesting it
      // inside `withOrg` would re-enter the pool mid-transaction (the M11/M18 write-lifecycle gotcha).
      const carePlanId = await resolveCarePlanIdForDecision(args.patientId, args.decisionKind);
      return withOrg(orgId, async (tx) => {
        const m = await lockMeeting(tx, meetingId); // serialise against a concurrent adjournment
        assertMeetingWriteAllowed(m.status, "decision");
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
            // The M36 non-quorate notice's inputs (only meaningful when `wasQuorate` is false).
            ...(plan.wasQuorate
              ? {}
              : {
                  coordinatorMembershipId: m.coordinatorMembershipId,
                  missingDisciplines: [...plan.quorumSnapshot.missingDisciplines],
                }),
          });
        return toDecisionView(row!);
      });
    },
    async updateDecision(orgId, _userId, id, payload, ifMatchVersion): Promise<DecisionView> {
      const prior = await withOrg(orgId, async (tx) => {
        const [row] = await tx.select().from(DEC).where(eq(DEC.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_decision");
        return row;
      });
      // Fail fast before the seam read below (the authoritative re-check runs inside the write tx).
      planDecisionUpdate({ status: prior.status, meetingIsLive: true });
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
        // GAP-043 / §2.8: re-read INSIDE the write tx (the row may have been emitted/superseded since the
        // first read) and make the UPDATE itself conditional on `status = 'open'`, so an adjournment that
        // slips in between cannot be overwritten (compare-and-set, like the note version CAS).
        const [cur] = await tx.select().from(DEC).where(eq(DEC.id, id)).limit(1);
        if (!cur) throw new NotFoundError("idg_decision");
        // Lock the meeting so an adjournment cannot read this decision's pre-edit payload and emit it stale.
        const m = await lockMeeting(tx, cur.idgMeetingId);
        planDecisionUpdate({ status: cur.status, meetingIsLive: m.status === "live" });
        assertNoteVersion(ifMatchVersion, cur.version);
        // Optimistic concurrency (§7.7): compare-and-set on BOTH status and the version the caller read, so two
        // concurrent edits of an open decision cannot silently overwrite each other (the loser gets a 412).
        const [updated] = await tx
          .update(DEC)
          .set({
            decisionKind: payload.kind,
            payload,
            carePlanId,
            version: cur.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(DEC.id, id), eq(DEC.status, "open"), eq(DEC.version, cur.version)))
          .returning();
        if (!updated) {
          // Lost the race: re-derive the precise 409 (no longer open) or 412 (version moved) from the row now.
          const [current] = await tx.select().from(DEC).where(eq(DEC.id, id)).limit(1);
          if (!current) throw new NotFoundError("idg_decision");
          planDecisionUpdate({ status: current.status, meetingIsLive: true });
          assertNoteVersion(ifMatchVersion, current.version);
          throw new NotFoundError("idg_decision");
        }
        return toDecisionView(updated);
      });
    },
    async supersedeDecision(orgId, userId, id, args): Promise<DecisionView> {
      return withOrg(orgId, async (tx) => {
        const [prior] = await tx.select().from(DEC).where(eq(DEC.id, id)).limit(1);
        if (!prior) throw new NotFoundError("idg_decision");
        const priorMeeting = await loadMeeting(tx, prior.idgMeetingId);
        // Defence in depth behind the route's scope gate: the caller must cover the PRIOR decision's meeting.
        if (args.callerLocationIds && !args.callerLocationIds.includes(priorMeeting.locationId)) {
          throw new NotFoundError("idg_decision");
        }
        // Lock the TARGET row, then judge it live: a concurrent adjournment either committed first (=> not live,
        // refused) or waits for this tx and emits the successor with the rest of the meeting's open decisions.
        const target = await lockMeeting(tx, args.meetingId);
        // GAP-043 / §2.8 / §4.7: the successor lands in a LATER, LIVE, QUORATE meeting; the quorum is computed
        // from the TARGET meeting's stored attendance (never asserted, never copied from the prior row).
        // Also raises DECISION_SUPERSEDED / DECISION_NOT_OPEN (only an `emitted` decision may be superseded).
        const plan = planDecisionSupersedeInto({
          priorStatus: prior.status,
          priorMeetingStart: priorMeeting.scheduledStart.toISOString(),
          target: {
            isLive: target.status === "live",
            scheduledStart: target.scheduledStart.toISOString(),
            patientIncluded: await patientIncluded(tx, target.id, prior.patientId),
            presentDisciplines: await presentDisciplines(tx, target.id),
          },
        });
        const successorId = await flipAndInsertSuccessor(tx, orgId, userId, prior, target.id, plan);
        return toDecisionView({
          ...prior,
          status: "superseded",
          supersededByDecisionId: successorId,
        });
      });
    },

    // ── action items (writes) ──────────────────────────────────────────────────────────────────────────
    async createActionItem(orgId, _userId, meetingId, args): Promise<ActionItemView> {
      return withOrg(orgId, async (tx) => {
        const meeting = await lockMeeting(tx, meetingId);
        assertMeetingWriteAllowed(meeting.status, "action_item_create");
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
            // F-104 — the D8 auto-close key. This INSERT wrote the kind and not the id, so
            // `linked_artifact_id` was NULL on every action item ever created and the auto-close engine
            // — whose pure decider, transition graph, event and `close_reason` value all shipped — had
            // nothing to match on. Read in the design, written by nothing.
            linkedArtifactId: args.linkedArtifactId ?? null,
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
          linkedArtifactId: row!.linkedArtifactId,
        });
        return toActionItemView(row!);
      });
    },
    async updateActionItem(
      orgId,
      userId,
      id,
      status: ActionItemPatchStatus,
      isCoordinator = false,
      expectedVersion?: number,
    ): Promise<ActionItemView> {
      return withOrg(orgId, async (tx) => {
        const [row] = await tx.select().from(ACT).where(eq(ACT.id, id)).limit(1);
        if (!row) throw new NotFoundError("idg_action_item");
        const meeting = await lockMeeting(tx, row.idgMeetingId);
        assertMeetingWriteAllowed(meeting.status, "action_item_follow_up");
        if (!isCoordinator && row.assignedToMembershipId !== userId)
          throw actionItemNotAssigneeError();
        if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
        const t = transitionActionItem(row.status, { type: PATCH_STATUS_EVENT[status] });
        const at = new Date();
        const closed = t.to === "completed" || t.to === "cancelled";
        const [updated] = await tx
          .update(ACT)
          .set({
            status: t.to as IdgActionItemStatus,
            closedAt: closed ? at : row.closedAt,
            version: row.version + 1,
            updatedAt: at,
          })
          .where(and(eq(ACT.id, id), eq(ACT.version, row.version)))
          .returning();
        if (!updated) throw staleRowError(row.version);
        await emit(tx, orgId, "m14.action_item.status_changed", "idg_action_item", id, {
          actionItemId: id,
          fromStatus: row.status,
          toStatus: t.to,
          actorMembershipId: userId,
        });
        return toActionItemView(updated!);
      });
    },
    async removeActionItem(
      orgId,
      _userId,
      id,
      expectedVersion?: number,
    ): Promise<{ id: string; removed: true }> {
      // No DELETE grant (compromise #2) → soft-remove by transitioning to `cancelled`.
      return withOrg(orgId, async (tx) => {
        const [row] = await tx
          .select({
            id: ACT.id,
            status: ACT.status,
            meetingId: ACT.idgMeetingId,
            version: ACT.version,
          })
          .from(ACT)
          .where(eq(ACT.id, id))
          .limit(1);
        if (!row) throw new NotFoundError("idg_action_item");
        const meeting = await lockMeeting(tx, row.meetingId);
        if (meeting.status === "adjourned") throw actionItemMeetingAdjournedError();
        assertMeetingWriteAllowed(meeting.status, "action_item_remove");
        if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
        transitionActionItem(row.status, { type: "cancel" });
        const cancelled = await tx
          .update(ACT)
          .set({
            status: "cancelled",
            closedAt: new Date(),
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(ACT.id, id), eq(ACT.version, row.version)))
          .returning({ id: ACT.id });
        if (cancelled.length === 0) throw staleRowError(row.version);
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
      // A re-render after an amendment must keep the 'Addenda' appendix, or the newest document version would
      // silently drop addenda the previous version showed.
      const meetingIdForNames = await withOrg(orgId, async (tx) => {
        const [r] = await tx
          .select({ meetingId: MIN.idgMeetingId })
          .from(MIN)
          .where(eq(MIN.id, minutesId))
          .limit(1);
        return r?.meetingId ?? null;
      });
      const addendumAuthorNames =
        meetingIdForNames === null
          ? new Map<string, string | null>()
          : await resolveAddendumAuthorNames(orgId, meetingIdForNames, []);
      const amendSite =
        meetingIdForNames === null
          ? undefined
          : await resolveMinutesSiteNames(orgId, meetingIdForNames, false);
      return withOrg(orgId, async (tx) => {
        const [min] = await tx
          .select({
            id: MIN.id,
            meetingId: MIN.idgMeetingId,
            status: MIN.status,
            // F-168 (#248) — the exact `renderPayload` shape `.signed` already sends, re-read
            // post-amendment: M22 re-renders through the SAME `idg_minutes` template, and until now this
            // event carried no content for it to render with at all.
            attendanceSnapshot: MIN.attendanceSnapshot,
            decisionListSnapshot: MIN.decisionListSnapshot,
            actionItemListSnapshot: MIN.actionItemListSnapshot,
            disciplineNoteSnapshot: MIN.disciplineNoteSnapshot,
          })
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
          // `amendmentReason` itself is DENYLISTED free-text (`idg_minutes_amendment.amendment_reason`,
          // §3.3) and deliberately stays OFF the wire, same as before this change (only its hash is
          // published) — `renderPayload` carries the same three snapshot columns `.signed` already
          // publishes in the clear, never the reason text.
          renderPayload: {
            attendanceSnapshot: min.attendanceSnapshot,
            decisionListSnapshot: min.decisionListSnapshot,
            actionItemListSnapshot: min.actionItemListSnapshot,
            disciplineNoteSnapshot: min.disciplineNoteSnapshot,
            disciplineAddenda: await buildDisciplineAddenda(tx, min.meetingId, addendumAuthorNames),
            ...(await loadMinutesRenderContext(tx, {
              meetingId: min.meetingId,
              minutesId,
              names: addendumAuthorNames,
              site: amendSite,
            })),
          },
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
