// apps/backend/src/modules/14-idg/routes/service.ts — M14-T05 the §4.1 route service over an in-memory
// backend (the M8-T09 / M9-T05 / M10-T06 / M11-T06 / M12-T08 / M13-T08 in-mem-slice precedent; Drizzle in prod
// under `withOrgContext` so RLS backstops every read). The service composes the PURE M14 domain (`@wardenx/idg`):
// the §2.2 meeting state machine (`transitionMeeting`), the §2.7 decision record/supersede deciders
// (`planDecisionRecord` / `planDecisionSupersede`), the §1.1/D8 action-item machine (`transitionActionItem` /
// `planActionItemCreate`), and the §2.6 minutes-amendment decider — and emits the §4.4 outbox events the relay
// publishes (drainable for tests).
//
// This service ALSO implements {@link IdgAbacResolver} so the §4.7 predicates (`idg_meeting_scope` /
// `quorate_decision` / `per_patient_review_floor_clear`) resolve over the same dataset (M12/M13-T08 precedent:
// the backend is both the route service and the ABAC resolver).
import {
  evaluateQuorum,
  planActionItemCreate,
  planDecisionRecord,
  planDecisionSupersede,
  planMeetingScheduled,
  planMinutesAmendmentRequest,
  transitionActionItem,
  transitionMeeting,
} from "@wardenx/idg";
import type {
  IdgActionItemLinkedKind,
  IdgActionItemStatus,
  IdgAgendaItemKind,
  IdgAttendanceStatus,
  IdgDecisionKind,
  IdgDecisionRecordedPayload,
  IdgDecisionStatus,
  IdgMeetingStatus,
  QuorumSnapshot,
} from "@wardenx/types";
import { NotFoundError } from "@wardenx/types";
import type { IdgAbacResolver, MeetingScopeFacts, ReviewFloorBreachFact } from "../abac-predicates";

// ── §4.4 outbox events the service records (the relay wraps them in the M1 envelope) ────────────────────
export interface RecordedIdgEvent {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
}

// ── view DTOs (read projections; never the raw Drizzle row) ──────────────────────────────────────────────
export interface MeetingView {
  readonly id: string;
  readonly organizationId: string;
  readonly locationId: string;
  readonly status: IdgMeetingStatus;
  readonly scheduledStart: string;
  readonly scheduledEnd: string;
  readonly adjournedAt: string | null;
}
export interface AttendanceView {
  readonly id: string;
  readonly meetingId: string;
  readonly membershipId: string;
  readonly discipline: string;
  readonly status: IdgAttendanceStatus;
  readonly checkedInAt: string;
}
export interface AgendaItemView {
  readonly id: string;
  readonly meetingId: string;
  readonly kind: IdgAgendaItemKind;
  readonly patientId: string | null;
}
export interface DecisionView {
  readonly id: string;
  readonly meetingId: string;
  readonly patientId: string | null;
  readonly decisionKind: IdgDecisionKind;
  readonly status: IdgDecisionStatus;
  readonly wasQuorate: boolean;
  readonly supersededByDecisionId: string | null;
}
export interface ActionItemView {
  readonly id: string;
  readonly meetingId: string;
  readonly decisionId: string | null;
  readonly patientId: string | null;
  readonly assignedToMembershipId: string;
  readonly status: IdgActionItemStatus;
  readonly dueDate: string;
  readonly linkedArtifactKind: IdgActionItemLinkedKind | null;
}
export interface MinutesView {
  readonly id: string;
  readonly meetingId: string;
  readonly status: "in_progress" | "final";
}
export interface PacketDigestView {
  readonly packetId: string;
  readonly meetingId: string;
  readonly patientId: string;
  readonly frozenAt: string | null;
}
export interface RecurringPolicyView {
  readonly id: string;
  readonly locationId: string;
  readonly cadenceDays: number;
  readonly active: boolean;
}
export interface MeetingScheduleView {
  readonly id: string;
  readonly locationId: string;
  readonly status: IdgMeetingStatus;
  readonly scheduledStart: string;
  readonly scheduledEnd: string;
}

/**
 * A patient's IDG review history — the meetings this patient was reviewed in (has a packet), each with
 * the meeting's schedule/status and the patient's decisions + action items from that meeting. PHI-safe by
 * construction: it surfaces only non-narrative metadata (decision KIND, action-item status/discipline,
 * meeting dates) — never the denylisted packet cover summaries, decision payloads, or item body text — so
 * there is no §3.3 SUD narrative to redact (mirrors the packet-digest reads). Empty `meetings` when the
 * patient has never been on an agenda.
 */
export interface PatientIdgHistoryView {
  readonly meetings: readonly {
    readonly meetingId: string;
    readonly status: string;
    readonly scheduledStart: string;
    readonly actualStart: string | null;
    readonly actualEnd: string | null;
    readonly reviewedAt: string | null;
    readonly packetFrozenAt: string | null;
    readonly decisions: readonly {
      readonly id: string;
      readonly decisionKind: string;
      readonly status: string;
      readonly wasQuorate: boolean;
      readonly recordedAt: string | null;
    }[];
    readonly actionItems: readonly {
      readonly id: string;
      readonly status: string;
      readonly discipline: string | null;
      readonly dueDate: string | null;
      readonly closedAt: string | null;
    }[];
  }[];
}

// ── service args ─────────────────────────────────────────────────────────────────────────────────────────
export interface RecurringPolicyArgs {
  readonly locationId: string;
  readonly cadenceDays: number;
  readonly active?: boolean;
}
export interface RescheduleArgs {
  readonly reason: string;
  readonly newScheduledStart: string;
  readonly newScheduledEnd: string;
}
export interface RecordAttendanceArgs {
  readonly membershipId: string;
  readonly discipline: string;
  readonly status?: IdgAttendanceStatus;
  readonly checkedInAt?: string;
}
export interface AddAgendaItemArgs {
  readonly kind: IdgAgendaItemKind;
  readonly patientId?: string;
}
export interface RecordDecisionArgs {
  readonly patientId: string | null;
  readonly agendaItemId?: string;
  readonly decisionKind: IdgDecisionKind;
  readonly payload: IdgDecisionRecordedPayload;
}
export interface CreateActionItemArgs {
  readonly decisionId?: string;
  readonly patientId: string | null;
  readonly assignedToMembershipId: string;
  readonly dueDate: string;
  readonly linkedArtifactKind?: IdgActionItemLinkedKind;
}

/** The §4.1 route service contract (the routes layer composes over this). */
export interface IdgRouteService {
  // schedule + recurring policies
  listSchedule(
    orgId: string,
    q: { location: string; from: string; to: string },
  ): Promise<MeetingScheduleView[]>;
  createRecurringPolicy(
    orgId: string,
    userId: string,
    args: RecurringPolicyArgs,
  ): Promise<RecurringPolicyView>;
  updateRecurringPolicy(
    orgId: string,
    userId: string,
    id: string,
    args: RecurringPolicyArgs,
  ): Promise<RecurringPolicyView>;
  // meeting lifecycle
  getMeeting(orgId: string, id: string): Promise<MeetingView>;
  cancelMeeting(orgId: string, userId: string, id: string, reason: string): Promise<MeetingView>;
  rescheduleMeeting(
    orgId: string,
    userId: string,
    id: string,
    args: RescheduleArgs,
  ): Promise<MeetingView>;
  buildPackets(orgId: string, userId: string, id: string): Promise<MeetingView>;
  startMeeting(orgId: string, userId: string, id: string): Promise<MeetingView>;
  adjournMeeting(
    orgId: string,
    userId: string,
    id: string,
    stepUpFresh: boolean,
  ): Promise<MeetingView>;
  // attendance
  recordAttendance(
    orgId: string,
    userId: string,
    meetingId: string,
    args: RecordAttendanceArgs,
  ): Promise<AttendanceView>;
  updateAttendance(
    orgId: string,
    userId: string,
    id: string,
    status: IdgAttendanceStatus,
  ): Promise<AttendanceView>;
  removeAttendance(
    orgId: string,
    userId: string,
    id: string,
  ): Promise<{ id: string; removed: true }>;
  // packets
  listPackets(orgId: string, meetingId: string): Promise<PacketDigestView[]>;
  getPacket(orgId: string, meetingId: string, patientId: string): Promise<PacketDigestView>;
  /** Patient-scoped IDG review history (patient-chart tab); empty meetings when never on an agenda. */
  getPatientIdgHistory(orgId: string, patientId: string): Promise<PatientIdgHistoryView>;
  // agenda
  addAgendaItem(
    orgId: string,
    userId: string,
    meetingId: string,
    args: AddAgendaItemArgs,
  ): Promise<AgendaItemView>;
  updateAgendaItem(orgId: string, userId: string, id: string): Promise<AgendaItemView>;
  removeAgendaItem(
    orgId: string,
    userId: string,
    id: string,
  ): Promise<{ id: string; removed: true }>;
  // decisions
  recordDecision(
    orgId: string,
    userId: string,
    meetingId: string,
    args: RecordDecisionArgs,
  ): Promise<DecisionView>;
  updateDecision(
    orgId: string,
    userId: string,
    id: string,
    payload: IdgDecisionRecordedPayload,
  ): Promise<DecisionView>;
  supersedeDecision(orgId: string, userId: string, id: string): Promise<DecisionView>;
  // action items
  createActionItem(
    orgId: string,
    userId: string,
    meetingId: string,
    args: CreateActionItemArgs,
  ): Promise<ActionItemView>;
  updateActionItem(
    orgId: string,
    userId: string,
    id: string,
    status: ActionItemPatchStatus,
  ): Promise<ActionItemView>;
  removeActionItem(
    orgId: string,
    userId: string,
    id: string,
  ): Promise<{ id: string; removed: true }>;
  listActionItems(
    orgId: string,
    userId: string,
    q: { assignee?: string; status?: IdgActionItemStatus },
  ): Promise<ActionItemView[]>;
  // minutes
  getMinutes(orgId: string, meetingId: string): Promise<MinutesView>;
  submitAmendment(
    orgId: string,
    userId: string,
    minutesId: string,
    amendmentReason: string,
  ): Promise<{ amendmentId: string; minutesId: string }>;
}

// ── seed shapes ──────────────────────────────────────────────────────────────────────────────────────────
export interface IdgMeetingSeed {
  readonly id: string;
  readonly organizationId: string;
  readonly locationId: string;
  readonly status?: IdgMeetingStatus;
  readonly scheduledStart: string;
  readonly scheduledEnd: string;
  /** Patients in the meeting's included set (inclusion + per-patient review-floor evaluation). */
  readonly includedPatientIds?: readonly string[];
}
export interface IdgRouteSeed {
  readonly now?: () => string;
  readonly meetings?: readonly IdgMeetingSeed[];
  /** Membership id → its discipline (drives attendance + the quorum present-set). */
  readonly disciplinesByMembership?: Readonly<Record<string, string>>;
  /** Per-meeting review-floor breaches the `per_patient_review_floor_clear` predicate surfaces (default none). */
  readonly reviewFloorBreaches?: Readonly<Record<string, readonly ReviewFloorBreachFact[]>>;
}

interface MeetingRow {
  id: string;
  organizationId: string;
  locationId: string;
  status: IdgMeetingStatus;
  scheduledStart: string;
  scheduledEnd: string;
  adjournedAt: string | null;
  includedPatientIds: Set<string>;
}
interface AttendanceRow {
  id: string;
  meetingId: string;
  membershipId: string;
  discipline: string;
  status: IdgAttendanceStatus;
  checkedInAt: string;
}
interface AgendaRow {
  id: string;
  meetingId: string;
  kind: IdgAgendaItemKind;
  patientId: string | null;
}
interface DecisionRow {
  id: string;
  meetingId: string;
  patientId: string | null;
  decisionKind: IdgDecisionKind;
  payload: IdgDecisionRecordedPayload;
  status: IdgDecisionStatus;
  wasQuorate: boolean;
  quorumSnapshot: QuorumSnapshot;
  supersededByDecisionId: string | null;
}
interface ActionItemRow {
  id: string;
  meetingId: string;
  decisionId: string | null;
  patientId: string | null;
  assignedToMembershipId: string;
  status: IdgActionItemStatus;
  dueDate: string;
  linkedArtifactKind: IdgActionItemLinkedKind | null;
}
interface MinutesRow {
  id: string;
  meetingId: string;
  status: "in_progress" | "final";
}
interface RecurringPolicyRow {
  id: string;
  locationId: string;
  cadenceDays: number;
  active: boolean;
}

let _seq = 0;
const nextId = (prefix: string): string => `${prefix}-${(++_seq).toString().padStart(8, "0")}`;

/** The action-item statuses a PATCH may transition TO (`open` is genesis-only — an item is never re-opened). */
export type ActionItemPatchStatus = "in_progress" | "completed" | "cancelled";

const PATCH_STATUS_EVENT: Record<ActionItemPatchStatus, "start" | "complete" | "cancel"> = {
  in_progress: "start",
  completed: "complete",
  cancelled: "cancel",
};

/** Build the in-memory M14 route backend (also the {@link IdgAbacResolver}). */
export function createInMemoryIdgBackend(
  seed: IdgRouteSeed = {},
): IdgRouteService & IdgAbacResolver {
  const now = seed.now ?? (() => new Date().toISOString());
  const disciplines = seed.disciplinesByMembership ?? {};
  const reviewFloorBreaches = seed.reviewFloorBreaches ?? {};

  const meetings = new Map<string, MeetingRow>();
  for (const m of seed.meetings ?? []) {
    meetings.set(m.id, {
      id: m.id,
      organizationId: m.organizationId,
      locationId: m.locationId,
      status: m.status ?? "scheduled",
      scheduledStart: m.scheduledStart,
      scheduledEnd: m.scheduledEnd,
      adjournedAt: null,
      includedPatientIds: new Set(m.includedPatientIds ?? []),
    });
  }
  const attendance = new Map<string, AttendanceRow>();
  const agenda = new Map<string, AgendaRow>();
  const decisions = new Map<string, DecisionRow>();
  const actionItems = new Map<string, ActionItemRow>();
  const minutes = new Map<string, MinutesRow>(); // keyed by meetingId
  const minutesById = new Map<string, MinutesRow>();
  const policies = new Map<string, RecurringPolicyRow>();
  const events: RecordedIdgEvent[] = [];

  const emit = (eventName: string, payload: Record<string, unknown>): void => {
    events.push({ eventName, payload });
  };

  /** Resolve a meeting under the caller's tenant (404 — existence non-leak — when absent / cross-tenant). */
  function meetingOf(orgId: string, id: string): MeetingRow {
    const m = meetings.get(id);
    if (!m || m.organizationId !== orgId) throw new NotFoundError("idg_meeting");
    return m;
  }
  function toMeetingView(m: MeetingRow): MeetingView {
    return {
      id: m.id,
      organizationId: m.organizationId,
      locationId: m.locationId,
      status: m.status,
      scheduledStart: m.scheduledStart,
      scheduledEnd: m.scheduledEnd,
      adjournedAt: m.adjournedAt,
    };
  }
  /** The disciplines PRESENT (present/tardy/partial) at the meeting right now (the quorum present-set). */
  function presentDisciplinesFor(meetingId: string): string[] {
    return [...attendance.values()]
      .filter((a) => a.meetingId === meetingId && a.status !== "absent" && a.status !== "excused")
      .map((a) => a.discipline);
  }
  function ensureMinutes(meetingId: string): MinutesRow {
    let row = minutes.get(meetingId);
    if (!row) {
      row = { id: nextId("idg-min"), meetingId, status: "in_progress" };
      minutes.set(meetingId, row);
      minutesById.set(row.id, row);
    }
    return row;
  }

  const service: IdgRouteService & IdgAbacResolver = {
    // ── schedule + recurring policies ──────────────────────────────────────────────────────────────────
    async listSchedule(orgId, q) {
      return [...meetings.values()]
        .filter(
          (m) =>
            m.organizationId === orgId &&
            m.locationId === q.location &&
            m.scheduledStart >= q.from &&
            m.scheduledStart <= q.to,
        )
        .sort((a, b) => (a.scheduledStart < b.scheduledStart ? -1 : 1))
        .map((m) => ({
          id: m.id,
          locationId: m.locationId,
          status: m.status,
          scheduledStart: m.scheduledStart,
          scheduledEnd: m.scheduledEnd,
        }));
    },
    async createRecurringPolicy(_orgId, _userId, args) {
      const id = nextId("idg-pol");
      const row: RecurringPolicyRow = {
        id,
        locationId: args.locationId,
        cadenceDays: args.cadenceDays,
        active: args.active ?? true,
      };
      policies.set(id, row);
      emit("m14.schedule.materialised", { recurringPolicyId: id, locationId: args.locationId });
      return { ...row };
    },
    async updateRecurringPolicy(_orgId, _userId, id, args) {
      const row = policies.get(id);
      if (!row) throw new NotFoundError("idg_recurring_policy");
      row.cadenceDays = args.cadenceDays;
      row.active = args.active ?? row.active;
      return { ...row };
    },

    // ── meeting lifecycle ────────────────────────────────────────────────────────────────────────────────
    async getMeeting(orgId, id) {
      return toMeetingView(meetingOf(orgId, id));
    },
    async cancelMeeting(orgId, _userId, id, reason) {
      const m = meetingOf(orgId, id);
      // The route's `per_patient_review_floor_clear` ABAC + override-permission gate is the authoritative guard;
      // the in-mem service drives the pure machine with the resolved facts (clear + authorized).
      const t = transitionMeeting(m.status, {
        type: "CANCEL",
        reason,
        reviewFloorClear: true,
        overrideAuthorized: true,
      });
      m.status = t.to;
      emit("m14.meeting.cancelled", { meetingId: id, cancellationReason: reason });
      return toMeetingView(m);
    },
    async rescheduleMeeting(orgId, _userId, id, args) {
      const m = meetingOf(orgId, id);
      const t = transitionMeeting(m.status, {
        type: "RESCHEDULE",
        reason: args.reason,
        reviewFloorClear: true,
        overrideAuthorized: true,
      });
      m.status = t.to;
      const newId = nextId("idg-mtg");
      meetings.set(newId, {
        id: newId,
        organizationId: m.organizationId,
        locationId: m.locationId,
        status: "scheduled",
        scheduledStart: args.newScheduledStart,
        scheduledEnd: args.newScheduledEnd,
        adjournedAt: null,
        includedPatientIds: new Set(m.includedPatientIds),
      });
      emit("m14.meeting.rescheduled", {
        priorMeetingId: id,
        newMeetingId: newId,
        newScheduledStart: args.newScheduledStart,
        reason: args.reason,
      });
      return toMeetingView(m);
    },
    async buildPackets(orgId, _userId, id) {
      const m = meetingOf(orgId, id);
      const t = transitionMeeting(m.status, {
        type: "BUILD_PACKETS",
        includedPatientCount: m.includedPatientIds.size,
      });
      m.status = t.to;
      emit("m14.packets.build_started", {
        meetingId: id,
        includedPatientCount: m.includedPatientIds.size,
      });
      return toMeetingView(m);
    },
    async startMeeting(orgId, _userId, id) {
      const m = meetingOf(orgId, id);
      const t = transitionMeeting(m.status, { type: "START" });
      m.status = t.to;
      emit("m14.meeting.started", { meetingId: id, startedAt: now() });
      return toMeetingView(m);
    },
    async adjournMeeting(orgId, userId, id, stepUpFresh) {
      const m = meetingOf(orgId, id);
      // `transitionMeeting` raises STEP_UP_REQUIRED (412) when the fresh step-up is absent (§2.2 D13).
      const t = transitionMeeting(m.status, { type: "ADJOURN", stepUpFresh });
      m.status = t.to;
      m.adjournedAt = now();
      // The commit point: emit every open decision, finalize the minutes (§2.7).
      for (const d of decisions.values()) {
        if (d.meetingId === id && d.status === "open") {
          d.status = "emitted";
          if (d.decisionKind !== "team_note") {
            emit("idg.decision_recorded", {
              decisionId: d.id,
              meetingId: id,
              patientId: d.patientId,
              organizationId: orgId,
              decisionKind: d.decisionKind,
              payload: d.payload,
              payloadSchemaVersion: "2026-01-v1",
              recordedByMembershipId: userId,
              recordedAt: now(),
              meetingAdjournedAt: m.adjournedAt,
              wasQuorate: d.wasQuorate,
              quorumSnapshot: d.quorumSnapshot,
            });
          }
        }
      }
      const min = ensureMinutes(id);
      min.status = "final";
      emit("m14.meeting.adjourned", { meetingId: id, adjournedAt: m.adjournedAt });
      emit("m14.minutes.signed", { minutesId: min.id, meetingId: id });
      return toMeetingView(m);
    },

    // ── attendance ───────────────────────────────────────────────────────────────────────────────────────
    async recordAttendance(orgId, _userId, meetingId, args) {
      meetingOf(orgId, meetingId);
      const id = nextId("idg-att");
      const row: AttendanceRow = {
        id,
        meetingId,
        membershipId: args.membershipId,
        discipline: args.discipline,
        status: args.status ?? "present",
        checkedInAt: args.checkedInAt ?? now(),
      };
      attendance.set(id, row);
      emit("m14.attendance.checked_in", {
        meetingId,
        attendanceId: id,
        membershipId: args.membershipId,
        discipline: args.discipline,
      });
      return { ...row };
    },
    async updateAttendance(orgId, _userId, id, status) {
      const row = attendance.get(id);
      if (!row) throw new NotFoundError("idg_attendance");
      meetingOf(orgId, row.meetingId);
      row.status = status;
      return { ...row };
    },
    async removeAttendance(orgId, _userId, id) {
      const row = attendance.get(id);
      if (!row) throw new NotFoundError("idg_attendance");
      meetingOf(orgId, row.meetingId);
      attendance.delete(id);
      return { id, removed: true };
    },

    // ── packets ──────────────────────────────────────────────────────────────────────────────────────────
    async listPackets(orgId, meetingId) {
      const m = meetingOf(orgId, meetingId);
      return [...m.includedPatientIds].map((patientId) => ({
        packetId: nextId("idg-pkt"),
        meetingId,
        patientId,
        frozenAt: m.status === "adjourned" ? m.adjournedAt : null,
      }));
    },
    async getPacket(orgId, meetingId, patientId) {
      const m = meetingOf(orgId, meetingId);
      if (!m.includedPatientIds.has(patientId)) throw new NotFoundError("idg_patient_packet");
      return {
        packetId: nextId("idg-pkt"),
        meetingId,
        patientId,
        frozenAt: m.status === "adjourned" ? m.adjournedAt : null,
      };
    },
    async getPatientIdgHistory(orgId, patientId) {
      const rows = [...meetings.values()]
        .filter((m) => m.organizationId === orgId && m.includedPatientIds.has(patientId))
        .sort((a, b) => Date.parse(b.scheduledStart) - Date.parse(a.scheduledStart))
        .map((m) => ({
          meetingId: m.id,
          status: m.status as string,
          scheduledStart: m.scheduledStart,
          actualStart: null,
          actualEnd: m.adjournedAt,
          reviewedAt: null,
          packetFrozenAt: m.status === "adjourned" ? m.adjournedAt : null,
          decisions: [...decisions.values()]
            .filter((d) => d.meetingId === m.id && d.patientId === patientId)
            .map((d) => ({
              id: d.id,
              decisionKind: d.decisionKind as string,
              status: d.status as string,
              wasQuorate: d.wasQuorate,
              recordedAt: null,
            })),
          actionItems: [...actionItems.values()]
            .filter((a) => a.meetingId === m.id && a.patientId === patientId)
            .map((a) => ({
              id: a.id,
              status: a.status as string,
              discipline: null,
              dueDate: a.dueDate,
              closedAt: null,
            })),
        }));
      return { meetings: rows };
    },

    // ── agenda ───────────────────────────────────────────────────────────────────────────────────────────
    async addAgendaItem(orgId, _userId, meetingId, args) {
      meetingOf(orgId, meetingId);
      const id = nextId("idg-agd");
      const row: AgendaRow = { id, meetingId, kind: args.kind, patientId: args.patientId ?? null };
      agenda.set(id, row);
      return { ...row };
    },
    async updateAgendaItem(orgId, _userId, id) {
      const row = agenda.get(id);
      if (!row) throw new NotFoundError("idg_agenda_item");
      meetingOf(orgId, row.meetingId);
      return { ...row };
    },
    async removeAgendaItem(orgId, _userId, id) {
      const row = agenda.get(id);
      if (!row) throw new NotFoundError("idg_agenda_item");
      meetingOf(orgId, row.meetingId);
      agenda.delete(id);
      return { id, removed: true };
    },

    // ── decisions ────────────────────────────────────────────────────────────────────────────────────────
    async recordDecision(orgId, _userId, meetingId, args) {
      const m = meetingOf(orgId, meetingId);
      // `planDecisionRecord` enforces MEETING_NOT_LIVE + INCLUSION_CRITERIA_FAILED and stamps the quorum.
      const plan = planDecisionRecord({
        meetingIsLive: m.status === "live",
        patientIncluded: args.patientId === null || m.includedPatientIds.has(args.patientId),
        presentDisciplines: presentDisciplinesFor(meetingId),
      });
      const id = nextId("idg-dec");
      const row: DecisionRow = {
        id,
        meetingId,
        patientId: args.patientId,
        decisionKind: args.decisionKind,
        payload: args.payload,
        status: plan.status,
        wasQuorate: plan.wasQuorate,
        quorumSnapshot: plan.quorumSnapshot,
        supersededByDecisionId: null,
      };
      decisions.set(id, row);
      emit("m14.decision.recorded_open", {
        decisionId: id,
        meetingId,
        patientId: args.patientId,
        decisionKind: args.decisionKind,
        wasQuorate: plan.wasQuorate,
      });
      return { ...row };
    },
    async updateDecision(orgId, _userId, id, payload) {
      const row = decisions.get(id);
      if (!row) throw new NotFoundError("idg_decision");
      meetingOf(orgId, row.meetingId);
      row.decisionKind = payload.kind;
      row.payload = payload;
      return { ...row };
    },
    async supersedeDecision(orgId, _userId, id) {
      const prior = decisions.get(id);
      if (!prior) throw new NotFoundError("idg_decision");
      const m = meetingOf(orgId, prior.meetingId);
      // `planDecisionSupersede` raises DECISION_SUPERSEDED / DECISION_NOT_OPEN per §2.8.
      planDecisionSupersede({ status: prior.status });
      const newId = nextId("idg-dec");
      decisions.set(newId, {
        id: newId,
        meetingId: m.id,
        patientId: prior.patientId,
        decisionKind: prior.decisionKind,
        payload: prior.payload,
        status: "open",
        wasQuorate: true,
        quorumSnapshot: prior.quorumSnapshot,
        supersededByDecisionId: null,
      });
      prior.status = "superseded";
      prior.supersededByDecisionId = newId;
      return { ...prior };
    },

    // ── action items ─────────────────────────────────────────────────────────────────────────────────────
    async createActionItem(orgId, _userId, meetingId, args) {
      meetingOf(orgId, meetingId);
      planActionItemCreate();
      const id = nextId("idg-act");
      const row: ActionItemRow = {
        id,
        meetingId,
        decisionId: args.decisionId ?? null,
        patientId: args.patientId,
        assignedToMembershipId: args.assignedToMembershipId,
        status: "open",
        dueDate: args.dueDate,
        linkedArtifactKind: args.linkedArtifactKind ?? null,
      };
      actionItems.set(id, row);
      emit("m14.action_item.created", {
        actionItemId: id,
        meetingId,
        decisionId: row.decisionId,
        patientId: row.patientId,
        assignedToMembershipId: row.assignedToMembershipId,
        dueDate: row.dueDate,
      });
      return { ...row };
    },
    async updateActionItem(orgId, _userId, id, status) {
      const row = actionItems.get(id);
      if (!row) throw new NotFoundError("idg_action_item");
      meetingOf(orgId, row.meetingId);
      const t = transitionActionItem(row.status, { type: PATCH_STATUS_EVENT[status] });
      const from = row.status;
      row.status = t.to;
      emit("m14.action_item.status_changed", {
        actionItemId: id,
        fromStatus: from,
        toStatus: row.status,
      });
      return { ...row };
    },
    async removeActionItem(orgId, _userId, id) {
      const row = actionItems.get(id);
      if (!row) throw new NotFoundError("idg_action_item");
      meetingOf(orgId, row.meetingId);
      actionItems.delete(id);
      return { id, removed: true };
    },
    async listActionItems(orgId, userId, q) {
      // `assignee=me` resolves to the caller's membership; in the slice the userId is the membership id.
      const assignee = q.assignee === "me" ? userId : q.assignee;
      return [...actionItems.values()]
        .filter((a) => {
          const m = meetings.get(a.meetingId);
          if (!m || m.organizationId !== orgId) return false;
          if (assignee !== undefined && a.assignedToMembershipId !== assignee) return false;
          if (q.status !== undefined && a.status !== q.status) return false;
          return true;
        })
        .map((a) => ({ ...a }));
    },

    // ── minutes ──────────────────────────────────────────────────────────────────────────────────────────
    async getMinutes(orgId, meetingId) {
      meetingOf(orgId, meetingId);
      const row = ensureMinutes(meetingId);
      return { ...row };
    },
    async submitAmendment(orgId, _userId, minutesId, _amendmentReason) {
      const row = minutesById.get(minutesId);
      if (!row) throw new NotFoundError("idg_minutes");
      meetingOf(orgId, row.meetingId);
      // §2.6 D10 — an amendment applies ONLY to `final` minutes (the original row is never edited in place;
      // the amendment workflow is the post-adjournment correction path). `planMinutesAmendmentRequest` raises
      // MINUTES_NOT_IN_PROGRESS when the minutes are not yet final.
      planMinutesAmendmentRequest(row.status);
      const amendmentId = nextId("idg-amd");
      emit("m14.minutes.amended", { amendmentId, minutesId });
      return { amendmentId, minutesId };
    },

    // ── IdgAbacResolver (§4.7) ───────────────────────────────────────────────────────────────────────────
    async loadMeetingScope(orgId, meetingId): Promise<MeetingScopeFacts | null> {
      const m = meetings.get(meetingId);
      if (!m || m.organizationId !== orgId) return null;
      return { organizationId: m.organizationId, locationId: m.locationId };
    },
    async loadPresentDisciplines(orgId, meetingId): Promise<readonly string[] | null> {
      const m = meetings.get(meetingId);
      if (!m || m.organizationId !== orgId) return null;
      return presentDisciplinesFor(meetingId);
    },
    async loadReviewFloorBreaches(orgId, meetingId): Promise<readonly ReviewFloorBreachFact[]> {
      const m = meetings.get(meetingId);
      if (!m || m.organizationId !== orgId) return [];
      return reviewFloorBreaches[meetingId] ?? [];
    },
  };

  // Expose the recorded-event log + the quorum helper for the slice/tests (drainable, deterministic).
  Object.assign(service, {
    drainEvents: (): RecordedIdgEvent[] => events.splice(0, events.length),
    currentQuorum: (meetingId: string) => evaluateQuorum(presentDisciplinesFor(meetingId)),
  });

  return service;
}
