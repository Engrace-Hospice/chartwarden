// apps/backend/src/modules/14-idg/routes/idg-typebox.ts — M14-T05 TypeBox route schemas (§4.2).
// Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one, and so the OpenAPI route scanner skips it. Validation runs through TypeBox `Value` →
// M1's VALIDATION_FAILED envelope (422). The decision `payload` is carried as a `kind`-bearing open object at
// this boundary (the server discriminates on `kind` and validates the §2.6 union in the domain); the
// lifecycle-bearing envelope fields are pinned here. The cancel/reschedule bodies carry `proposedTransition` +
// `newScheduledStart` so the route's `per_patient_review_floor_clear` ABAC resolves at authz time.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DISCIPLINE_NOTE_ADDENDUM_REASON_MAX } from "@wardenx/idg";
import { ValidationError } from "@wardenx/types";
import { IDG_DECISION_PAYLOAD_SCHEMA } from "../decision-payload-schema";
import type {
  ActionItemView as ServiceActionItemView,
  AgendaItemView as ServiceAgendaItemView,
  AttendanceView as ServiceAttendanceView,
  DecisionView as ServiceDecisionView,
  DisciplineNoteView as ServiceDisciplineNoteView,
  MeetingScheduleView as ServiceMeetingScheduleView,
  MeetingView as ServiceMeetingView,
  MinutesView as ServiceMinutesView,
  PacketDetailView as ServicePacketDetailView,
  PacketDigestView as ServicePacketDigestView,
  RecurringPolicyView as ServiceRecurringPolicyView,
} from "./service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set("date", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/**
 * Minimum-necessary patient display info attached to the meeting-screen reads that carry a `patientId`
 * (agenda, packets, decisions, action items). "First L." (legal first name + last initial — the M5 D3 /
 * M14 §2.4 display rule) plus the MRN's last four characters; the full name, DOB and full MRN never ride
 * these reads. `Optional` because only the enriched READS populate it (POST/PATCH echoes and the in-memory
 * slice omit it); `null` when the item has no patient or the org cannot resolve the id.
 */
export const PatientDisplaySchema = Type.Object({
  displayName: Type.String(),
  mrnSuffix: Nullable(Type.String()),
});
const PatientDisplayField = Type.Optional(Nullable(PatientDisplaySchema));

/** §2.6 decision taxonomy (mirrors `IdgDecisionKind`). */
const DECISION_KIND = Type.Union([
  Type.Literal("care_plan_update"),
  Type.Literal("order_request"),
  Type.Literal("medication_recommendation"),
  Type.Literal("level_of_care_consideration"),
  Type.Literal("recertification_consideration"),
  Type.Literal("family_meeting_needed"),
  Type.Literal("bereavement_risk_flag"),
  Type.Literal("referral"),
  Type.Literal("team_note"),
  Type.Literal("discipline_plan_update"),
]);

/** §2.7 agenda-item taxonomy (mirrors `IdgAgendaItemKind`). */
const AGENDA_KIND = Type.Union([
  Type.Literal("patient_review"),
  Type.Literal("carry_forward"),
  Type.Literal("administrative_note"),
  Type.Literal("family_meeting_setup"),
  Type.Literal("other"),
]);

/** Per-attendee participation status (mirrors `IdgAttendanceStatus`). */
const ATTENDANCE_STATUS = Type.Union([
  Type.Literal("present"),
  Type.Literal("tardy"),
  Type.Literal("partial"),
  Type.Literal("absent"),
  Type.Literal("excused"),
]);

/** The action-item status filter for the list route (any persisted state). */
const ACTION_ITEM_STATUS = Type.Union([
  Type.Literal("open"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);
/** The action-item status a PATCH may transition TO (an item is never re-opened — `open` is genesis-only). */
const ACTION_ITEM_PATCH_STATUS = Type.Union([
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);

const ACTION_ITEM_LINKED_KIND = Type.Union([
  Type.Literal("care_plan_version"),
  Type.Literal("order"),
  Type.Literal("encounter"),
  Type.Literal("medication_order"),
]);

// ── params + query ──────────────────────────────────────────────────────────────────────────────────────
export const IdParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });
export const PatientIdParamsSchema = Type.Object({ patientId: Type.String({ format: "uuid" }) });
export const MeetingPacketParamsSchema = Type.Object({
  meetingId: Type.String({ format: "uuid" }),
  patientId: Type.String({ format: "uuid" }),
});
export const ScheduleQuerySchema = Type.Object({
  location: Type.String({ format: "uuid" }),
  from: Type.String({ format: "date-time" }),
  to: Type.String({ format: "date-time" }),
});
export const ActionItemListQuerySchema = Type.Object({
  assignee: Type.Optional(Type.String({ maxLength: 64 })),
  status: Type.Optional(ACTION_ITEM_STATUS),
});

// ── request bodies (§4.2) ───────────────────────────────────────────────────────────────────────────────
export const RecurringPolicyRequest = Type.Object({
  locationId: Type.String({ format: "uuid" }),
  cadenceDays: Type.Integer({ minimum: 1, maximum: 15 }),
  active: Type.Optional(Type.Boolean()),
});

export const ScheduleMeetingRequest = Type.Object({
  locationId: Type.String({ format: "uuid" }),
  scheduledStart: Type.String({ format: "date-time" }),
  scheduledEnd: Type.String({ format: "date-time" }),
  /** Defaults to the acting membership when omitted. */
  coordinatorMembershipId: Type.Optional(Type.String({ format: "uuid" })),
});

export const CancelMeetingRequest = Type.Object({
  proposedTransition: Type.Literal("cancel"),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
});

export const RescheduleMeetingRequest = Type.Object({
  proposedTransition: Type.Literal("reschedule"),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  newScheduledStart: Type.String({ format: "date-time" }),
  newScheduledEnd: Type.String({ format: "date-time" }),
});

export const AdjournMeetingRequest = Type.Object({});

export const RecordAttendanceRequest = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  discipline: Type.String({ minLength: 1, maxLength: 64 }),
  status: Type.Optional(ATTENDANCE_STATUS),
  checkedInAt: Type.Optional(Type.String({ format: "date-time" })),
  /**
   * Coordinator-only. `true` = "I attest this member attends as this discipline although their roles do not confer it";
   * the row is stored flagged (`disciplineAttested`). Without it, a discipline the member does not hold is 422
   * DISCIPLINE_NOT_HELD. A non-coordinator sending it is 403 ATTESTATION_REQUIRES_COORDINATOR.
   */
  coordinatorAttested: Type.Optional(Type.Boolean()),
});
export const UpdateAttendanceRequest = Type.Object({ status: ATTENDANCE_STATUS });

export const AddAgendaItemRequest = Type.Object({
  kind: AGENDA_KIND,
  patientId: Type.Optional(Type.String({ format: "uuid" })),
  noteText: Type.Optional(Type.String({ maxLength: 4000 })),
});
/** Per-discipline meeting notes (spec extension). `discipline` is the attendance roster's free-text vocabulary. */
const NOTE_BODY = Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" });
export const CreateDisciplineNoteRequest = Type.Object({
  /** Absent/null = a meeting-level note for the discipline; else a patient on the meeting's agenda. */
  patientId: Type.Optional(Nullable(Type.String({ format: "uuid" }))),
  discipline: Type.String({ minLength: 1, maxLength: 64 }),
  bodyText: NOTE_BODY,
  /**
   * Optional context (≤500; blank/whitespace = absent) on a note of a LIVE meeting. REQUIRED non-blank when the meeting
   * is ADJOURNED — the note is then a late addendum (422 ADDENDUM_REASON_REQUIRED).
   */
  reason: Type.Optional(Nullable(Type.String({ maxLength: DISCIPLINE_NOTE_ADDENDUM_REASON_MAX }))),
});
/** PATCH a live original note: `bodyText` and/or `reason` (`null`/blank clears it); at least one. */
export const UpdateDisciplineNoteRequest = Type.Object(
  {
    bodyText: Type.Optional(NOTE_BODY),
    reason: Type.Optional(
      Nullable(Type.String({ maxLength: DISCIPLINE_NOTE_ADDENDUM_REASON_MAX })),
    ),
  },
  { minProperties: 1 },
);
export const DisciplineNoteListQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String({ format: "uuid" })),
});
export const UpdateAgendaItemRequest = Type.Object({
  noteText: Type.Optional(Type.String({ maxLength: 4000 })),
});

/** The decision body — `payload` is carried as a `kind`-bearing open object; the §2.6 union is validated in the
 * domain validator. `patientId` is nullable (an administrative/team-note decision may not be patient-scoped). */
export const RecordDecisionRequest = Type.Object({
  patientId: Nullable(Type.String({ format: "uuid" })),
  agendaItemId: Type.Optional(Type.String({ format: "uuid" })),
  payload: IDG_DECISION_PAYLOAD_SCHEMA,
});
export const UpdateDecisionRequest = Type.Object({
  payload: IDG_DECISION_PAYLOAD_SCHEMA,
});
export const SupersedeDecisionRequest = Type.Object({
  /** GAP-043 / §2.8: the SUBSEQUENT live meeting the successor decision is recorded in (quorum is computed there). */
  meetingId: Type.String({ format: "uuid" }),
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const CreateActionItemRequest = Type.Object({
  decisionId: Type.Optional(Type.String({ format: "uuid" })),
  patientId: Nullable(Type.String({ format: "uuid" })),
  assignedToMembershipId: Type.String({ format: "uuid" }),
  dueDate: Type.String({ format: "date-time" }),
  linkedArtifactKind: Type.Optional(ACTION_ITEM_LINKED_KIND),
  /** F-104 — the D8 auto-close KEY, and it was absent from this contract, from `CreateActionItemArgs`
   *  and from the INSERT. `idg_action_item.linked_artifact_id` was read by the auto-close design and
   *  written by nothing, so an item linked to an IPOC version, an order or a medication order could
   *  never be matched when that artifact reached its absorbing state. Sent WITH `linkedArtifactKind` or
   *  not at all — a kind with no id can never auto-close and an id with no kind can never be matched, so
   *  either alone is a silently dead link (422). */
  linkedArtifactId: Type.Optional(Type.String({ format: "uuid" })),
  bodyText: Type.Optional(Type.String({ maxLength: 4000 })),
});
export const UpdateActionItemRequest = Type.Object({ status: ACTION_ITEM_PATCH_STATUS });

export const SubmitAmendmentRequest = Type.Object({
  amendmentReason: Type.String({ minLength: 1, maxLength: 4000 }),
});

// ── response views (§4.2 — the read projections the GET routes return; M14-T07 enriches the contract so the
//    generated client (`packages/ui/src/core/api`) types the §5 screens' reads. Shapes mirror the route
//    service's view DTOs (routes/service.ts) — never the raw Drizzle row). ───────────────────────────────
const MEETING_STATUS = Type.Union([
  Type.Literal("scheduled"),
  Type.Literal("packets_building"),
  Type.Literal("packets_ready"),
  Type.Literal("live"),
  Type.Literal("adjourned"),
  Type.Literal("cancelled"),
  Type.Literal("rescheduled"),
]);

/** A single meeting in the location/range schedule list (GET /idg/schedule). */
export const MeetingScheduleViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  locationId: Type.String({ format: "uuid" }),
  status: MEETING_STATUS,
  scheduledStart: Type.String({ format: "date-time" }),
  scheduledEnd: Type.String({ format: "date-time" }),
  coordinatorMembershipId: Type.String({ format: "uuid" }),
});
export const ScheduleListResponseSchema = Type.Array(MeetingScheduleViewSchema);

/** One meeting's lifecycle view (GET /idg/meetings/:id). */
export const MeetingViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  organizationId: Type.String({ format: "uuid" }),
  locationId: Type.String({ format: "uuid" }),
  status: MEETING_STATUS,
  scheduledStart: Type.String({ format: "date-time" }),
  scheduledEnd: Type.String({ format: "date-time" }),
  adjournedAt: Nullable(Type.String({ format: "date-time" })),
  coordinatorMembershipId: Type.String({ format: "uuid" }),
});

/** A per-patient packet digest (GET /idg/meetings/:id/packets + .../packets/:patientId). */
export const PacketDigestViewSchema = Type.Object({
  packetId: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  patientId: Type.String({ format: "uuid" }),
  patient: PatientDisplayField,
  frozenAt: Nullable(Type.String({ format: "date-time" })),
});
export const PacketListResponseSchema = Type.Array(PacketDigestViewSchema);

// ── Packet CONTENT (GET /idg/meetings/:meetingId/packets/:patientId) — the frozen `built_snapshot` shaped for the
//    packet page / live-meeting centre pane (see ./packet-content.ts). Snapshot facts only; null/empty where the
//    build holds nothing; deterministic Layer-1 cover text (no AI polish); W-SUD-01 applied per caller. ────────
const PacketDateTime = Type.String({ format: "date-time" });
const PacketSeverity = Type.Union([
  Type.Literal("info"),
  Type.Literal("attention"),
  Type.Literal("urgent"),
]);
const F2fWindowState = Nullable(
  Type.Union([Type.Literal("not_due"), Type.Literal("window_open"), Type.Literal("overdue")]),
);
export const PacketDisciplineKeySchema = Type.Union([
  Type.Literal("rn"),
  Type.Literal("msw"),
  Type.Literal("chaplain"),
  Type.Literal("aide"),
  Type.Literal("md_np"),
  Type.Literal("volunteer"),
  Type.Literal("medical_director"),
]);
export const PacketContentViewSchema = Type.Object({
  schemaVersion: Type.Literal("2026-01-v1"),
  cover: Type.Object({
    /** Deterministic Layer-1 cover text composed from the facts below (no AI polish). */
    summary: Type.String(),
    builtAt: PacketDateTime,
    sinceCursorAt: PacketDateTime,
    sinceContext: Type.Union([Type.Literal("prior_idg"), Type.Literal("first_idg")]),
    /** "First L." as frozen at build (the live display label rides the top-level `patient`). */
    nameAtBuild: Type.String(),
    age: Type.Integer(),
    primaryDiagnosisIcd10: Type.String(),
    primaryDiagnosisLabel: Type.String(),
    levelOfCare: Type.Union([
      Type.Literal("routine"),
      Type.Literal("continuous"),
      Type.Literal("inpatient_respite"),
      Type.Literal("general_inpatient"),
    ]),
    daysOnService: Type.Integer(),
    hasActiveDpoa: Type.Boolean(),
    activeSudFlag: Type.Boolean(),
    /** M6 recert/F2F cover facts as snapshotted at build; null = the build could not resolve it. */
    recert: Type.Object({
      nextRecertDueAt: Nullable(PacketDateTime),
      f2fWindowState: F2fWindowState,
    }),
    carePlan: Type.Object({
      activeProblemCount: Type.Integer(),
      activeGoalCount: Type.Integer(),
      activeInterventionCount: Type.Integer(),
      lastSignedAt: PacketDateTime,
      nextReviewDueAt: PacketDateTime,
      isReviewOverdue: Type.Boolean(),
    }),
    discussionFlags: Type.Array(Type.Object({ kind: Type.String(), detail: Type.String() })),
    counts: Type.Object({
      signedEncounters: Type.Integer(),
      assessmentChanges: Type.Integer(),
      hopeTriggers: Type.Integer(),
      orderChanges: Type.Integer(),
      medicationChanges: Type.Integer(),
      flaggedEvents: Type.Integer(),
      carryForwardActionItems: Type.Integer(),
    }),
  }),
  /** One entry per discipline view, in policy order (rn, msw, chaplain, aide, md_np, …). */
  disciplines: Type.Array(
    Type.Object({
      discipline: PacketDisciplineKeySchema,
      oneLineSummary: Type.String(),
      items: Type.Array(
        Type.Object({
          sourceKind: Type.Union([
            Type.Literal("encounter"),
            Type.Literal("assessment"),
            Type.Literal("order"),
            Type.Literal("medication"),
            Type.Literal("hope"),
            Type.Literal("action_item"),
            Type.Literal("flag"),
          ]),
          sourceId: Type.String(),
          label: Type.String(),
          summary: Type.String(),
          severity: Nullable(PacketSeverity),
        }),
      ),
      openQuestions: Type.Array(Type.String()),
    }),
  ),
  signedEncounters: Type.Array(
    Type.Object({
      encounterId: Type.String(),
      encounterType: Type.String(),
      discipline: Type.String(),
      signedAt: PacketDateTime,
    }),
  ),
  assessmentChanges: Type.Array(
    Type.Object({
      assessmentId: Type.String(),
      scaleKind: Type.String(),
      changeKind: Type.String(),
      occurredAt: PacketDateTime,
    }),
  ),
  hopeTimepoints: Type.Object({
    /** false => the build captured no HOPE context ("not captured", not "none due"). */
    captured: Type.Boolean(),
    upcoming: Type.Array(Type.Object({ timepoint: Type.String(), dueAt: PacketDateTime })),
    openSfvCount: Nullable(Type.Integer()),
    symptomImpactTriggers: Type.Array(
      Type.Object({
        hopeAssessmentId: Type.String(),
        triggerKind: Type.String(),
        firedAt: PacketDateTime,
      }),
    ),
  }),
  /** F-230 — external (DoseSpot MedHx) medication-history STATE; `captured:false`/`not_pulled` are NOT "none". */
  externalMedicationHistory: Type.Object({
    captured: Type.Boolean(),
    state: Nullable(
      Type.Union([
        Type.Literal("not_pulled"),
        Type.Literal("none_available"),
        Type.Literal("available"),
      ]),
    ),
    recordCount: Nullable(Type.Integer()),
    lastPulledAt: Nullable(PacketDateTime),
    message: Nullable(Type.String()),
  }),
  orderChanges: Type.Array(
    Type.Object({
      orderId: Type.String(),
      orderKind: Type.String(),
      changeKind: Type.String(),
      changedAt: PacketDateTime,
    }),
  ),
  medicationChanges: Type.Array(
    Type.Object({
      medicationOrderId: Type.String(),
      drugLabel: Type.String(),
      changeKind: Type.String(),
      changedAt: PacketDateTime,
    }),
  ),
  flaggedEvents: Type.Array(
    Type.Object({
      kind: Type.String(),
      sourceId: Type.String(),
      occurredAt: PacketDateTime,
      severity: PacketSeverity,
    }),
  ),
  carryForwardActionItems: Type.Array(
    Type.Object({
      actionItemId: Type.String(),
      assignedToMembershipId: Type.String(),
      dueDate: PacketDateTime,
      carryForwardCount: Type.Integer(),
    }),
  ),
});
/** One patient's packet with its content (GET /idg/meetings/:meetingId/packets/:patientId). */
export const PacketDetailViewSchema = Type.Composite([
  PacketDigestViewSchema,
  Type.Object({
    /** null only when the stored snapshot is missing / an unsupported schema version. */
    content: Nullable(PacketContentViewSchema),
    /** W-SUD-01 — Part 2 content was elided for THIS caller on THIS read. */
    appliedSudRedaction: Type.Boolean(),
    /** "Some content filtered per 42 CFR Part 2" when redacted, else null. */
    redactionNotice: Nullable(Type.String()),
  }),
]);

// Patient IDG review history (patient-chart tab). NOTE: `meetings` is published as a loose record array
// on purpose — each meeting item nests decisions[] + actionItems[] arrays of objects, and publishing that
// full depth makes openapi-fetch's generated client type instantiate past TypeScript's depth limit
// (TS2589) as one operation among 1000+. The rich per-meeting shape is the service
// `PatientIdgHistoryView.meetings` type, which the screen casts to; the live-RLS suite proves the shape.
export const PatientIdgHistoryResponseSchema = Type.Object({
  meetings: Type.Array(Type.Record(Type.String(), Type.Unknown())),
});

/** A caller's action-item view (GET /idg/action-items). */
export const ActionItemViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  decisionId: Nullable(Type.String({ format: "uuid" })),
  patientId: Nullable(Type.String({ format: "uuid" })),
  patient: PatientDisplayField,
  assignedToMembershipId: Type.String({ format: "uuid" }),
  status: Type.Union([
    Type.Literal("open"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("cancelled"),
    Type.Literal("auto_closed"),
  ]),
  dueDate: Type.String({ format: "date-time" }),
  linkedArtifactKind: Nullable(ACTION_ITEM_LINKED_KIND),
  /** F-104 — on the wire because a caller cannot otherwise tell a linked item from an unlinkable one:
   *  the kind alone was returned, and a kind with no id never auto-closes. */
  linkedArtifactId: Nullable(Type.String({ format: "uuid" })),
});
export const ActionItemListResponseSchema = Type.Array(ActionItemViewSchema);

/**
 * A meeting's minutes view (GET /idg/meetings/:id/minutes).
 *
 * The three `*Count` fields are the SIZES of `idg_minutes`' frozen snapshots, not the snapshots: those
 * nest the §3.3 denylisted decision narrative, and this module's read surface is narrative-free by
 * construction (see `PatientIdgHistoryView`). Null while `in_progress` — nothing is frozen yet, and
 * "no decisions" and "not yet snapshotted" are different facts. The readable document is the M22 render
 * at `minutesDocumentId`.
 */
export const MinutesViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  status: Type.Union([Type.Literal("in_progress"), Type.Literal("final")]),
  finalizedAt: Nullable(Type.String({ format: "date-time" })),
  finalizedByMembershipId: Nullable(Type.String({ format: "uuid" })),
  minutesDocumentId: Nullable(Type.String({ format: "uuid" })),
  /**
   * Where the M22 render stands, from real data: `not_rendered` (still `in_progress`), `pending` (`final`, the
   * `m14.minutes.signed` render request in flight — no back-ref yet), `rendered` (`minutesDocumentId` stamped).
   */
  renderStatus: Type.Union([
    Type.Literal("not_rendered"),
    Type.Literal("pending"),
    Type.Literal("rendered"),
  ]),
  /**
   * The finalizer's display NAME only (minimum-necessary staff projection via the identity-owned batched
   * `membershipDisplayForOrg` seam). Present when the enrichment port is bound; null when the membership has no
   * name on file or is unknown to the org. Absent (not null) in the slice/tests that mount no port.
   */
  finalizedByName: Type.Optional(Nullable(Type.String())),
  /** The finalizer's discipline off THIS meeting's frozen attendance snapshot; null when they did not attend. */
  finalizedByDiscipline: Nullable(Type.String()),
  attendanceCount: Nullable(Type.Integer({ minimum: 0 })),
  decisionCount: Nullable(Type.Integer({ minimum: 0 })),
  actionItemCount: Nullable(Type.Integer({ minimum: 0 })),
  /** Discipline notes frozen at adjournment (count only; text via GET .../discipline-notes). Null while in_progress. */
  disciplineNoteCount: Nullable(Type.Integer({ minimum: 0 })),
  /** LIVE count of late addenda recorded after adjournment (not from the frozen snapshot; text via GET .../discipline-notes). */
  disciplineAddendumCount: Type.Integer({ minimum: 0 }),
  /**
   * Late-addendum eligibility (WINDOW B), derived per read: `open` = adjourned and within 14 days of `actual_end`
   * (`closesAt` = that boundary, null when not adjourned); `closedReason` = `window_elapsed` once past it, else null;
   * `supersededPatientIds` = this meeting's patients a NEWER ADJOURNED IDG has since included — patient-scoped addenda
   * for them are refused (422 ADDENDUM_SUPERSEDED_BY_NEWER_IDG) even while `open`; meeting-level addenda are not.
   */
  addendumState: Type.Object({
    open: Type.Boolean(),
    closesAt: Nullable(Type.String({ format: "date-time" })),
    closedReason: Nullable(Type.Literal("window_elapsed")),
    supersededPatientIds: Type.Array(Type.String({ format: "uuid" })),
  }),
});

/** A recurring-policy view (POST/PATCH /idg/recurring-policies). */
export const RecurringPolicyViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  locationId: Type.String({ format: "uuid" }),
  cadenceDays: Type.Integer(),
  active: Type.Boolean(),
});

/** A single attendance row view (POST /idg/meetings/:id/attendance, PATCH /idg/attendance/:id). */
export const AttendanceViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  membershipId: Type.String({ format: "uuid" }),
  discipline: Type.String(),
  status: ATTENDANCE_STATUS,
  checkedInAt: Type.String({ format: "date-time" }),
  /** True when a coordinator ATTESTED a discipline the member's roles do not confer (flagged in the roster UI). */
  disciplineAttested: Type.Boolean(),
  /** Who wrote the row; null for a legacy (pre-0286) row. */
  recordedByMembershipId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
});

/** GET /idg/meetings/:id/attendance-eligibility query: a coordinator may ask about another member. */
export const AttendanceEligibilityQuerySchema = Type.Object({
  membershipId: Type.Optional(Type.String({ format: "uuid" })),
});

/** What the caller may attest at the check-in (GET /idg/meetings/:id/attendance-eligibility). */
export const AttendanceEligibilitySchema = Type.Object({
  /** The membership the answer is about (the caller's own unless a coordinator passed `?membershipId=`). */
  membershipId: Type.String({ format: "uuid" }),
  /** The caller holds `idg.coordinate`: may record others and attest overrides. */
  isCoordinator: Type.Boolean(),
  /** The attendance disciplines that membership's roles confer (the validated choices). */
  heldDisciplines: Type.Array(Type.String()),
  /** Coordinator-only: the full closed vocabulary a coordinator may ATTEST for another member (empty otherwise). */
  attestableDisciplines: Type.Array(Type.String()),
});

/** The meeting's attendance roster (GET /idg/meetings/:id/attendance). */
export const AttendanceListResponseSchema = Type.Array(AttendanceViewSchema);

/** An agenda-item view (GET/POST /idg/meetings/:id/agenda, PATCH /idg/agenda/:id). */
export const AgendaItemViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  kind: AGENDA_KIND,
  patientId: Nullable(Type.String({ format: "uuid" })),
  patient: PatientDisplayField,
});

/**
 * One discipline note (GET/POST /idg/meetings/:id/discipline-notes, PATCH /idg/discipline-notes/:id). `bodyText`
 * is null + `bodyWithheld` true when 42 CFR Part 2 content is withheld for THIS caller on THIS read. `authorName`
 * is the author's display NAME only (identity seam; absent when no port is bound, null when unresolvable).
 */
export const DisciplineNoteViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  patientId: Nullable(Type.String({ format: "uuid" })),
  discipline: Type.String(),
  bodyText: Nullable(Type.String()),
  bodyWithheld: Type.Boolean(),
  authorMembershipId: Type.String({ format: "uuid" }),
  authorName: Type.Optional(Nullable(Type.String())),
  version: Type.Integer({ minimum: 0 }),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
  /** True for a LATE ADDENDUM recorded after the meeting was adjourned (append-only; outside the frozen minutes). */
  isAddendum: Type.Boolean(),
  /** Server time the addendum was recorded; null for an original (live) note. */
  addendumRecordedAt: Nullable(Type.String({ format: "date-time" })),
  /** Optional context on any note (required on an addendum); null when absent, and withheld (null) under 42 CFR Part 2 exactly like `bodyText`. */
  reason: Nullable(Type.String()),
  patient: PatientDisplayField,
});
export const DisciplineNoteListResponseSchema = Type.Array(DisciplineNoteViewSchema);

/** The meeting's ordered agenda (GET /idg/meetings/:id/agenda). */
export const AgendaListResponseSchema = Type.Array(AgendaItemViewSchema);

const DECISION_STATUS = Type.Union([
  Type.Literal("open"),
  Type.Literal("emitted"),
  Type.Literal("superseded"),
]);

/**
 * A decision view (GET /idg/meetings/:id/decisions, POST .../decisions, PATCH /idg/decisions/:id,
 * .../supersede). METADATA ONLY — `payload` (the D4 canonical narrative) and `quorumSnapshot` are
 * deliberately absent, on the `PatientIdgHistoryView` precedent, so the meeting-conduct read surface
 * never has to answer W-SUD-01.
 */
/** F-234 — one downstream module's "decision applied" acknowledgement (metadata only). */
export const DecisionApplicationViewSchema = Type.Object({
  module: Type.Literal("m15"),
  planId: Nullable(Type.String({ format: "uuid" })),
  versionId: Nullable(Type.String({ format: "uuid" })),
  mutationsApplied: Type.Integer({ minimum: 0 }),
  acknowledgedAt: Type.String({ format: "date-time" }),
});
export const DecisionViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  patientId: Nullable(Type.String({ format: "uuid" })),
  patient: PatientDisplayField,
  agendaItemId: Nullable(Type.String({ format: "uuid" })),
  decisionKind: DECISION_KIND,
  status: DECISION_STATUS,
  wasQuorate: Type.Boolean(),
  recordedByMembershipId: Type.String({ format: "uuid" }),
  recordedAt: Type.String({ format: "date-time" }),
  supersededByDecisionId: Nullable(Type.String({ format: "uuid" })),
  /** Optimistic-concurrency token — send it back as `If-Match` on `PATCH /idg/decisions/:id`. */
  version: Type.Integer({ minimum: 0 }),
  applications: Type.Optional(Type.Array(DecisionApplicationViewSchema)),
});
export const DecisionListResponseSchema = Type.Array(DecisionViewSchema);

/**
 * One agenda patient's recert / face-to-face window (GET /idg/meetings/:id/recert-windows) — the M14 spec's
 * "recert/F2F windows in the IDG right pane" (§1.1, §2.4 `patientCover.nextRecertDueAt` / `f2fWindowState`),
 * SEAM-PULLED from M6 (M6's own window math, evaluated in the org timezone). Dates are org-local
 * `yyyy-mm-dd`; `f2fWindowState` is the §2.4 cover enum, `f2fStatus` the richer verdict. A patient with no live
 * (non-terminal) admission — or whose current benefit period cannot be resolved — has `admissionId`/dates
 * null and `f2fStatus: "unknown"`: an honest gap, never a fabricated compliance judgment. Non-narrative.
 */
export const RecertWindowItemSchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  patient: PatientDisplayField,
  admissionId: Nullable(Type.String({ format: "uuid" })),
  currentPeriodSequence: Nullable(Type.Integer({ minimum: 1 })),
  benefitPeriodStart: Nullable(Type.String({ format: "date" })),
  benefitPeriodEnd: Nullable(Type.String({ format: "date" })),
  nextRecertDueDate: Nullable(Type.String({ format: "date" })),
  nextPeriodSequence: Nullable(Type.Integer({ minimum: 2 })),
  daysUntilNextRecert: Nullable(Type.Integer()),
  f2fRequired: Nullable(Type.Boolean()),
  f2fWindowStart: Nullable(Type.String({ format: "date" })),
  f2fWindowEnd: Nullable(Type.String({ format: "date" })),
  f2fStatus: Type.Union([
    Type.Literal("not_required"),
    Type.Literal("not_yet_open"),
    Type.Literal("window_open"),
    Type.Literal("attested"),
    Type.Literal("missed"),
    Type.Literal("unknown"),
  ]),
  f2fWindowState: Nullable(
    Type.Union([Type.Literal("not_due"), Type.Literal("window_open"), Type.Literal("overdue")]),
  ),
  f2fScheduledDate: Nullable(Type.String({ format: "date" })),
});
export const RecertWindowsResponseSchema = Type.Object({
  meetingId: Type.String({ format: "uuid" }),
  generatedAt: Type.String({ format: "date-time" }),
  items: Type.Array(RecertWindowItemSchema),
});

/** The `{ id, removed: true }` envelope the DELETE routes return (attendance/agenda/action-items). */
export const RemovedResponseSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  removed: Type.Literal(true),
});

/** The amendment receipt (POST /idg/minutes/:id/amendments). */
export const AmendmentResponseSchema = Type.Object({
  amendmentId: Type.String({ format: "uuid" }),
  minutesId: Type.String({ format: "uuid" }),
});

// ── Compile-time pins (§4.2 F0 enrichment): `T` (what the schema publishes) must be assignable to `V`
//    (what the route service returns) — a view field added/renamed/retyped breaks `bun run build` rather
//    than silently drifting from the generated client. ──────────────────────────────────────────────────
type Conforms<T extends V, V> = T;
type _MeetingSchedule = Conforms<
  Static<typeof MeetingScheduleViewSchema>,
  ServiceMeetingScheduleView
>;
type _Meeting = Conforms<Static<typeof MeetingViewSchema>, ServiceMeetingView>;
type _Packet = Conforms<Static<typeof PacketDigestViewSchema>, ServicePacketDigestView>;
type _PacketDetail = Conforms<Static<typeof PacketDetailViewSchema>, ServicePacketDetailView>;
type _ActionItem = Conforms<Static<typeof ActionItemViewSchema>, ServiceActionItemView>;
type _Minutes = Conforms<Static<typeof MinutesViewSchema>, ServiceMinutesView>;
type _RecurringPolicy = Conforms<
  Static<typeof RecurringPolicyViewSchema>,
  ServiceRecurringPolicyView
>;
type _Attendance = Conforms<Static<typeof AttendanceViewSchema>, ServiceAttendanceView>;
type _AgendaItem = Conforms<Static<typeof AgendaItemViewSchema>, ServiceAgendaItemView>;
type _DisciplineNote = Conforms<Static<typeof DisciplineNoteViewSchema>, ServiceDisciplineNoteView>;
type _Decision = Conforms<Static<typeof DecisionViewSchema>, ServiceDecisionView>;
type _Removed = Conforms<
  Static<typeof RemovedResponseSchema>,
  { readonly id: string; readonly removed: true }
>;
type _Amendment = Conforms<
  Static<typeof AmendmentResponseSchema>,
  { readonly amendmentId: string; readonly minutesId: string }
>;

/** Parse `raw` through `schema` → typed value, or throw M1's VALIDATION_FAILED envelope. */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}
