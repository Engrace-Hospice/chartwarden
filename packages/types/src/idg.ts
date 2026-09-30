// @wardenx/types — Module 14 (Interdisciplinary Group / IDG) leaf contracts (M14-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package: the M14 spec's references to
// `packages/domain/idg/{seams,decision-payload,packet,alerts}.ts` resolve their TYPE surface HERE so the
// downstream consumers (M7 apply-idg-decision, M11 idg-decision-intake, M12 medication-recommendation,
// M16-future bereavement, M22 packet/minutes render, M28 FHIR, M30 measures, M33 metrics, M36 alerts)
// import them with no `dependsOn` edge. The runtime impls + the M1 seam-registry wiring land later (the
// published `IdgPacketProvider`/`IdgDecisionProvider`/`IdgScheduleProvider` in M14-T05; the outbox/alert
// assemblers in M14-T06).
//
// M14-T01 ships the type-level surface every later M14 task builds on: the §3.2 pgEnum value mirrors, the
// §4.4 `m14.*` / `idg.*` outbox event names, the §3.3 / §8.1 audit denylists (the M4 trigger arguments for
// M14-T02), the §4.10 typed M36 alert payloads, the §2.6 D4 canonical decision discriminated union, the
// §2.4 D1 `PacketSnapshot` + §2.5 D7 `DisciplineViewBlock` shapes, and the §4.8 published-seam interfaces
// + read DTOs. The §2.5 `DISCIPLINE_VIEW_POLICY` + the §1.1 `IDG_REQUIRED_QUORUM` / §2.2 D2
// `IDG_SCHEDULE_POLICY` pure-data constants live in the `@wardenx/idg` FEATURE package. This file is
// type-only and importable by everyone with no edge.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { AdmissionId, PatientId } from "./admission";
import type {
  CarePlanId,
  IdgDecisionId,
  IdgMeetingId,
  IsoInstant,
  LocationId,
  MembershipId,
} from "./care-plan";

// ── M14-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ──────────
export type IdgRecurringPolicyId = string;
export type IdgAttendanceId = string;
export type IdgAgendaItemId = string;
export type IdgActionItemId = string;
export type IdgMinutesId = string;
export type IdgMinutesAmendmentId = string;
export type IdgPatientPacketId = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ─────────────────────

/** The §2.2 meeting lifecycle (mirrors `idg_meeting_status`). */
export type IdgMeetingStatus =
  | "scheduled"
  | "packets_building"
  | "packets_ready"
  | "live"
  | "adjourned"
  | "cancelled"
  | "rescheduled";

/** Per-attendee participation (mirrors `idg_attendance_status`). */
export type IdgAttendanceStatus = "present" | "tardy" | "partial" | "absent" | "excused";

/** The §2.7 agenda-item taxonomy (mirrors `idg_agenda_item_kind`). */
export type IdgAgendaItemKind =
  | "patient_review"
  | "carry_forward"
  | "administrative_note"
  | "family_meeting_setup"
  | "other";

/** The §2.6 D4 canonical decision taxonomy (mirrors `idg_decision_kind`). */
export type IdgDecisionKind =
  | "care_plan_update"
  | "order_request"
  | "medication_recommendation"
  | "level_of_care_consideration"
  | "recertification_consideration"
  | "family_meeting_needed"
  | "bereavement_risk_flag"
  | "referral"
  | "team_note";

/** The §2.7 decision outbox lifecycle (mirrors `idg_decision_status`). */
export type IdgDecisionStatus = "open" | "emitted" | "superseded";

/** The §1.1 / D8 action-item lifecycle (mirrors `idg_action_item_status`). */
export type IdgActionItemStatus =
  | "open"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "auto_closed";

/** Which downstream absorbing artifact closes an action item (mirrors `idg_action_item_linked_kind`, D8). */
export type IdgActionItemLinkedKind =
  | "care_plan_version"
  | "order"
  | "encounter"
  | "medication_order";

/** Minutes immutability state (mirrors `idg_minutes_status`, D10). */
export type IdgMinutesStatus = "in_progress" | "final";

// ── §3.3 owned-table names + §3.3 / §8.1 audit denylist (the M4 trigger arguments for M14-T02) ────────

/** The nine §3.3 owned tables (the manifest `ownedTables` set). */
export type M14TableName =
  | "idg_meeting"
  | "idg_recurring_policy"
  | "idg_attendance"
  | "idg_agenda_item"
  | "idg_decision"
  | "idg_action_item"
  | "idg_minutes"
  | "idg_minutes_amendment"
  | "idg_patient_packet";

/** Per-table audit denylist (§3.3 "Audit triggers" / §8.1). Free-text PHI that must NOT enter
 * `audit_event.before/after` values — the M4 trigger captures `<changed>` markers instead. Empty array =
 * structural fields only. The `payload->>...` / `built_snapshot->...` entries are json-path denylists of
 * narrative/rationale free-text nested inside the jsonb columns (the decision payload's narrative/rationale/
 * note fields and the packet's per-discipline narrative summaries). */
export const M14_AUDIT_DENYLIST: { readonly [K in M14TableName]: readonly string[] } = {
  idg_meeting: [],
  idg_recurring_policy: [],
  idg_attendance: ["absence_note"],
  // "note_text" was never a real column here (§3.6/§7.6 correction, TASK-063/ARCH-020) — the real
  // free-text column is `body_text` (same name idg_action_item already carries).
  idg_agenda_item: ["body_text"],
  idg_decision: [
    "payload->>rationaleText",
    "payload->>noteText",
    "payload->>narrative",
    "payload->>recommendations",
    "payload->>requestedOrders",
    "payload->>mutations",
  ],
  idg_action_item: ["body_text"],
  idg_minutes: ["closing_note"],
  idg_minutes_amendment: ["amendment_reason"],
  idg_patient_packet: [
    "cover_summary_layer1",
    "cover_summary_layer2",
    // The real top-level `discipline_views` jsonb column (distinct from the NESTED `built_snapshot.
    // discipline_views` key below) was already scrubbed by the migration but missing here (TASK-063/ARCH-020).
    "discipline_views",
    "built_snapshot->discipline_views",
    "built_snapshot->sinceLastIdg",
  ],
} as const;

// ── §4.4 outbox event names (the canonical wire identifiers the dispatcher + arch:gaps validate) ──────

/** The full §4.4 M14 outbox taxonomy, in canonical `m14.<entity>.<verb>` form (plus the cross-module
 * canonical `idg.decision_recorded` — the M7/M11/M12/M16-future consumer contract whose name predates the
 * `m14.` namespace and stays as the locked seam identifier). M7 consumes `idg.decision_recorded`; M11/M12
 * consume it for their decision-kind arms; M22 the packet/minutes render handshake; M28 the FHIR-projection
 * events; M30 the cadence/decision-latency measures; M33 the metrics stream; M36 the typed alerts. The full
 * publication + subscription wiring lands in M14-T06. */
export const M14_EVENT_NAMES = [
  "m14.schedule.materialised",
  "m14.meeting.scheduled",
  "m14.packets.build_started",
  "m14.packets.build_failed_for_patient",
  "m14.packets.ready",
  "m14.packet.render_requested",
  "m14.meeting.started",
  "m14.attendance.checked_in",
  "m14.decision.recorded_open",
  "m14.action_item.created",
  "m14.action_item.status_changed",
  "m14.action_item.auto_closed",
  "m14.action_item.carry_forward",
  "idg.decision_recorded",
  "m14.meeting.adjourned",
  "m14.meeting.cancelled",
  "m14.meeting.rescheduled",
  "m14.review_floor.override_recorded",
  "m14.review_clock.escalated",
  "m14.minutes.signed",
  "m14.minutes.amended",
  "m14.discipline_note.addendum_recorded",
  "m14.packet.frozen",
] as const;

/** An M14 outbox event name (§4.4). */
export type M14EventName = (typeof M14_EVENT_NAMES)[number];

// ── §2.6 D4 canonical decision payload — the discriminated union every downstream consumer reads ──────
//
// NOTE on naming (M14-T01): the M14 spec §2.6 names this union `IdgDecisionPayload`, but
// `packages/types/src/care-plan.ts` already exports a (narrower, locked) `IdgDecisionPayload` — the M7 D4
// care-plan envelope its `apply-idg-decision` worker + tests consume today. To keep the leaf surface
// collision-free under `export *`, M14 publishes its broader cross-kind union as
// `IdgDecisionRecordedPayload` (named for the `idg.decision_recorded` event that carries it). The
// reconciliation/mapping into M7's care-plan-specific envelope is wired live in M14-T06 (which lands the
// M7/M11/M12 consumers against the real producer). The sub-input types below are M14-owned and unique.

/** The §2.6 D4 canonical, exhaustive decision payload carried by `idg.decision_recorded`. Adding a kind is
 * a coordinated change with the consumer modules (M7/M11/M12) + an envelope schema-version bump. */
export type IdgDecisionRecordedPayload =
  | { readonly kind: "care_plan_update"; readonly mutations: readonly CarePlanMutation[] }
  | { readonly kind: "order_request"; readonly requestedOrders: readonly RequestedOrderInput[] }
  | {
      readonly kind: "medication_recommendation";
      readonly recommendations: readonly MedicationRecommendationInput[];
    }
  | {
      readonly kind: "level_of_care_consideration";
      readonly consideredLevel: IdgLevelOfCare;
      readonly rationaleText: string;
    }
  | {
      readonly kind: "recertification_consideration";
      readonly periodIndex: number;
      readonly rationaleText: string;
    }
  | {
      readonly kind: "family_meeting_needed";
      readonly familyMembers: readonly string[];
      readonly preferredWindow: {
        readonly startIso: IsoInstant;
        readonly endIso: IsoInstant;
      } | null;
      readonly rationaleText: string;
    }
  | {
      readonly kind: "bereavement_risk_flag";
      readonly riskLevel: "low" | "medium" | "high";
      readonly rationaleText: string;
    }
  | {
      readonly kind: "referral";
      readonly referralKind: string;
      readonly referralTargetMdmId: string | null;
      readonly rationaleText: string;
    }
  | { readonly kind: "team_note"; readonly noteText: string };

/** Hospice level of care (shared across the packet cover + the LOC-consideration decision arm). */
export type IdgLevelOfCare = "routine" | "continuous" | "inpatient_respite" | "general_inpatient";

/** A single care-plan element mutation inside a `care_plan_update` decision (§2.6). */
export type CarePlanMutation =
  | {
      readonly op: "problem_add";
      readonly icd10Code: string | null;
      readonly snomedCode: string | null;
      readonly description: string;
      readonly problemKind: "terminal" | "related" | "unrelated";
    }
  | {
      readonly op: "problem_update";
      readonly problemId: string;
      readonly updates: Partial<{
        status: "active" | "resolved" | "inactive";
        description: string;
      }>;
    }
  | {
      readonly op: "goal_add";
      readonly problemId: string;
      readonly originalText: string;
      readonly revisedText: string | null;
      readonly source: "clinical" | "patient_stated" | "family_stated" | "agent_stated";
      readonly measurableOutcome: string;
    }
  | {
      readonly op: "goal_update";
      readonly goalId: string;
      readonly updates: Partial<{
        revisedText: string;
        status: "in_progress" | "met" | "not_met" | "revised" | "discontinued";
        statusNote: string;
      }>;
    }
  | {
      readonly op: "intervention_add";
      readonly problemId: string;
      readonly goalRefs: readonly string[];
      readonly discipline: string;
      readonly scopeText: string;
      readonly frequencyText: string;
      readonly frequencyValue: string;
    }
  | {
      readonly op: "intervention_discontinue";
      readonly interventionId: string;
      readonly reason: string;
    };

/** The structured order request M11's `idg-decision-intake` consumer turns into a draft order (§2.6). */
export type RequestedOrderInput = {
  readonly kindHint:
    | "lab"
    | "dme"
    | "level_of_care_change"
    | "recertification"
    | "comfort_kit"
    | "supply"
    | "ancillary_service"
    | "idg_requested";
  readonly narrative: string;
  readonly recommendedTimeframe: string | null;
  readonly triggeringProblemId: string | null;
};

/** The structured medication recommendation M12's consumer turns into a draft medication order (§2.6). */
export type MedicationRecommendationInput = {
  readonly recommendationKind:
    | "add"
    | "discontinue"
    | "change_dose"
    | "change_route"
    | "change_frequency";
  readonly drugLabel: string;
  readonly proposedStrength: string | null;
  readonly proposedRoute: string | null;
  readonly proposedFrequency: string | null;
  readonly triggeringProblemId: string | null;
  readonly rationaleText: string;
};

/** The §4.4 `idg.decision_recorded` outbox envelope (top-level keys). The schema-versioned `payload` is the
 * canonical union above; consumers refusing an unknown `payloadSchemaVersion` dead-letter + emit
 * `m14.decision_payload_quarantined`. */
export interface IdgDecisionRecordedEnvelope {
  readonly decisionId: IdgDecisionId;
  readonly meetingId: IdgMeetingId;
  readonly patientId: PatientId;
  readonly organizationId: string;
  readonly decisionKind: IdgDecisionKind;
  readonly payload: IdgDecisionRecordedPayload;
  readonly payloadSchemaVersion: "2026-01-v1";
  readonly recordedByMembershipId: MembershipId;
  readonly recordedAt: IsoInstant;
  readonly meetingAdjournedAt: IsoInstant;
  readonly wasQuorate: boolean;
  readonly quorumSnapshot: QuorumSnapshot;
}

/** The point-in-time quorum evaluation stamped on a decision at record-time (§2.7 / D3). */
export interface QuorumSnapshot {
  readonly met: boolean;
  readonly presentDisciplines: readonly string[];
  readonly missingDisciplines: readonly string[];
}

// ── §2.5 D7 discipline views ──────────────────────────────────────────────────────────────────────────

/** The discipline a packet view block is keyed by (§2.5). */
export type DisciplineKey =
  | "rn"
  | "msw"
  | "chaplain"
  | "aide"
  | "md_np"
  | "volunteer"
  | "medical_director";

/** One per-discipline view block on the packet (§2.5). Content is identical across disciplines; the meeting
 * surface filters which blocks render by attendee role. */
export interface DisciplineViewBlock {
  readonly oneLineSummary: string; // Layer 1 deterministic
  readonly highlightedEntries: ReadonlyArray<{
    readonly sourceKind:
      | "encounter"
      | "assessment"
      | "order"
      | "medication"
      | "hope"
      | "action_item"
      | "flag";
    readonly sourceId: string;
    readonly label: string;
    readonly summary: string;
    readonly severity?: "info" | "attention" | "urgent";
  }>;
  readonly openQuestions: readonly string[];
  readonly layer2Polished: {
    readonly enhancedSummary: string;
    readonly modificationId: string; // M8 hearthnote_llm_modification ref
    readonly layer2InvolvedAt: IsoInstant;
  } | null;
}

// ── §2.4 D1 packet snapshot (the derived survey-reconstruction artifact frozen on adjournment) ─────────
//
// The `sinceLastIdg` sub-digests are M14's OWN build-time projections of the upstream seam reads (not the
// upstream Drizzle rows); they are defined locally so this leaf stays self-contained.

/** A signed-encounter digest in the packet's "since last IDG" block (M8 seam projection). */
export interface PacketEncounterDigest {
  readonly encounterId: string;
  readonly encounterType: string;
  readonly signedAt: IsoInstant;
  readonly authorDiscipline: string;
}

/** A significant-assessment-change digest (M9 outbox-subscription projection). */
export interface PacketAssessmentChangeDigest {
  readonly assessmentId: string;
  readonly scaleKind: string;
  readonly changeKind: string;
  readonly occurredAt: IsoInstant;
}

/** A HOPE J2051 symptom-impact trigger digest (M10 outbox-subscription projection). */
export interface PacketHopeTriggerDigest {
  readonly hopeAssessmentId: string;
  readonly triggerKind: string;
  readonly firedAt: IsoInstant;
}

/** An order-change digest (M11 `OrderProvider.getOrdersSince` projection). */
export interface PacketOrderChangeDigest {
  readonly orderId: string;
  readonly orderKind: string;
  readonly changeKind: string;
  readonly changedAt: IsoInstant;
}

/** A medication-change digest (M12 `MedicationOrderProvider.getMedicationsSince` projection). */
export interface PacketMedicationChangeDigest {
  readonly medicationOrderId: string;
  readonly drugLabel: string;
  readonly changeKind: string;
  readonly changedAt: IsoInstant;
}

/** A derived flagged-event digest (hospitalisation / ER / missed dose / fall / infection). */
export interface PacketFlaggedEventDigest {
  readonly kind: "hospitalisation" | "er_visit" | "missed_dose" | "fall" | "infection";
  readonly sourceId: string;
  readonly occurredAt: IsoInstant;
  readonly severity: "info" | "attention" | "urgent";
}

/** A carry-forward action-item digest surfaced on the next meeting's cover (D8). */
export interface PacketActionItemCarryForwardDigest {
  readonly actionItemId: IdgActionItemId;
  readonly assignedToMembershipId: MembershipId;
  readonly dueDate: IsoInstant;
  readonly carryForwardCount: number;
}

/** A cover-level discussion flag (LOC candidate / recert due / complex symptoms / family meeting / SUD). */
export interface PacketDiscussionFlag {
  readonly kind:
    | "level_of_care_candidate"
    | "recert_due"
    | "complex_symptoms"
    | "family_meeting_needed"
    | "sud_pattern_review";
  readonly detail: string;
}

/** The §2.4 D1 typed packet snapshot frozen into `idg_patient_packet.built_snapshot` on adjournment. */
export interface PacketSnapshot {
  readonly schemaVersion: "2026-01-v1";
  readonly meta: {
    readonly meetingId: IdgMeetingId;
    readonly patientId: PatientId;
    readonly admissionId: AdmissionId;
    readonly locationId: LocationId;
    readonly builtAt: IsoInstant;
    readonly sinceCursorIso: IsoInstant; // last IDG adjourned_at OR admission.activated_at
    readonly sinceContext: "prior_idg" | "first_idg";
    readonly builderJobId: string;
    readonly appliedSudRedaction: boolean;
  };
  readonly patientCover: {
    readonly fullNameRedacted: string; // "First L." per M5 D3 display rule
    readonly age: number;
    readonly primaryDiagnosisIcd10: string;
    readonly primaryDiagnosisLabel: string; // resolved via M38
    readonly daysOnService: number;
    readonly levelOfCare: IdgLevelOfCare;
    readonly nextRecertDueAt: IsoInstant | null; // from M6 reader
    readonly f2fWindowState: "not_due" | "window_open" | "overdue" | null;
    readonly activeDpoa: { readonly agentName: string; readonly consentId: string } | null;
    readonly activeSudFlag: boolean; // governs UI banner; content filtering done at read path
  };
  readonly sinceLastIdg: {
    readonly encounters: readonly PacketEncounterDigest[];
    readonly significantAssessmentChanges: readonly PacketAssessmentChangeDigest[];
    readonly j2051Triggers: readonly PacketHopeTriggerDigest[];
    readonly ordersChanged: readonly PacketOrderChangeDigest[];
    readonly medicationsChanged: readonly PacketMedicationChangeDigest[];
    readonly flaggedEvents: readonly PacketFlaggedEventDigest[];
  };
  readonly carePlanSummary: {
    readonly activeProblemCount: number;
    readonly activeGoalCount: number;
    readonly activeInterventionCount: number;
    readonly lastSignedVersionId: string;
    readonly lastSignedAt: IsoInstant;
    readonly nextReviewDueAt: IsoInstant;
    readonly isReviewOverdue: boolean;
  };
  readonly hopeContext: {
    readonly upcomingTimepoints: ReadonlyArray<{
      readonly timepoint: string;
      readonly dueAt: IsoInstant;
    }>;
    readonly openSfvCount: number;
  } | null;
  readonly capProjection: {
    readonly status: "green" | "yellow" | "red";
    readonly projectedUsage: number | null;
  } | null; // from M26 when M26 ships; deny-stub today returning null
  readonly carryForwardActionItems: readonly PacketActionItemCarryForwardDigest[];
  readonly flagsForDiscussion: readonly PacketDiscussionFlag[];
}

// ── §4.10 M36 typed alert payloads (the deterministic messages M14 emits; M36 doesn't re-template) ────
// M14 emits typed alerts through M36's dispatch seam. The builders land in `@wardenx/idg` / M14-T06; this
// discriminated union is the shape M36 type-checks against. No free-text PHI in the payloads — IDs +
// structural facts + a deterministic `bodyTemplate`; M36 resolves recipient PHI per permission scope.

/** The §4.10 discriminated union of every typed alert M14 emits to M36. */
export type M14AlertPayload =
  | {
      readonly kind: "m14.packets.ready";
      readonly organizationId: string;
      readonly meetingId: IdgMeetingId;
      readonly scheduledStart: IsoInstant;
      readonly packetCount: number;
      readonly recipients: { readonly attendeesByMembershipId: readonly MembershipId[] };
      readonly bodyTemplate: string;
    }
  | {
      readonly kind: "m14.action_item.created";
      readonly organizationId: string;
      readonly actionItemId: IdgActionItemId;
      readonly patientId: PatientId | null;
      readonly assignedToMembershipId: MembershipId;
      readonly dueDate: IsoInstant;
      readonly severity: "info" | "attention";
      readonly bodyTemplate: string;
    }
  | {
      readonly kind: "m14.action_item.carry_forward.compliance";
      readonly organizationId: string;
      readonly priorActionItemId: IdgActionItemId;
      readonly carryForwardCount: number; // >= 3
      readonly severity: "critical";
      readonly recipients: {
        readonly complianceInbox: true;
        readonly idgCoordinatorMembershipId?: MembershipId;
        readonly clinicalSupervisorMembershipId?: MembershipId;
      };
      readonly bodyTemplate: string;
    }
  | {
      readonly kind: "m14.decision.non_quorate";
      readonly organizationId: string;
      readonly meetingId: IdgMeetingId;
      readonly decisionId: IdgDecisionId;
      readonly missingDisciplines: readonly string[];
      readonly severity: "low";
      readonly bodyTemplate: string;
    }
  | {
      // M14-F01 / ADR-0018 D2 — per-patient (per-POC) 15-day review-clock escalation (T-3 / T-0 / T+1).
      readonly kind: "m14.review_clock.escalated";
      readonly organizationId: string;
      readonly admissionId: AdmissionId;
      readonly patientId: PatientId;
      readonly locationId: LocationId;
      readonly lastIdgReviewedAt: IsoInstant | null; // null => never reviewed; floor anchored to activated_at
      readonly floorAt: IsoInstant; // last_idg_reviewed_at + 15 days (or activated_at + 15 days)
      readonly stage: "t_minus_3" | "t_zero" | "t_plus_1";
      readonly severity: "clinical_routine" | "critical";
      readonly recipients: {
        readonly idgCoordinatorMembershipId: MembershipId;
        readonly clinicalSupervisorMembershipId?: MembershipId; // added at T-0/T+1
        readonly complianceInbox?: boolean; // true at T+1 (floor breached)
      };
      readonly bodyTemplate: string;
    }
  | {
      // M14-F01 / ADR-0018 D2 — audited override of the per-patient review-floor guard on CANCEL/RESCHEDULE.
      readonly kind: "m14.review_floor.override_recorded";
      readonly organizationId: string;
      readonly meetingId: IdgMeetingId;
      readonly actorMembershipId: MembershipId;
      readonly reason: string;
      readonly breachingPatients: ReadonlyArray<{
        readonly patientId: PatientId;
        readonly floorAt: IsoInstant;
      }>;
      readonly severity: "attention";
      readonly recipients: {
        readonly complianceInbox: true;
        readonly clinicalSupervisorMembershipId: MembershipId;
      };
      readonly bodyTemplate: string;
    };

// ── §4.8 published-seam read DTOs (read-only projections; never Drizzle rows) ─────────────────────────

/** §4.8 — one decision's read projection (M30 decision-latency measure + M33 dashboards). */
export interface IdgDecisionDto {
  readonly id: IdgDecisionId;
  readonly organizationId: string;
  readonly meetingId: IdgMeetingId;
  readonly patientId: PatientId;
  readonly decisionKind: IdgDecisionKind;
  readonly status: IdgDecisionStatus;
  readonly wasQuorate: boolean;
  readonly recordedByMembershipId: MembershipId;
  readonly recordedAt: IsoInstant;
  readonly emittedAt: IsoInstant | null;
  readonly supersededByDecisionId: IdgDecisionId | null;
}

/** §4.8 — a meeting digest in the schedule provider's location/range listing (M28 FHIR + M33). */
export interface IdgMeetingDigest {
  readonly id: IdgMeetingId;
  readonly organizationId: string;
  readonly locationId: LocationId;
  readonly status: IdgMeetingStatus;
  readonly scheduledStart: IsoInstant;
  readonly scheduledEnd: IsoInstant;
  readonly adjournedAt: IsoInstant | null;
  readonly decisionCount: number;
  readonly attendeeCount: number;
}

/** §4.8 — the deterministic render payload M22's packet renderer consumes (`IdgPacketProvider`). */
export interface IdgPacketRenderPayload {
  readonly packetId: IdgPatientPacketId;
  readonly meetingId: IdgMeetingId;
  readonly patientId: PatientId;
  readonly schemaVersion: "2026-01-v1";
  readonly snapshot: PacketSnapshot;
  readonly disciplineViews: Record<DisciplineKey, DisciplineViewBlock>;
  readonly coverSummaryLayer1: string;
  readonly coverSummaryLayer2: string | null;
}

// ── §4.8 seams this module publishes (impls injected at boot in M14-T05; type-checked at boot) ────────

/** §4.8 — packet snapshot + render handshake (consumed by M22, M33). */
export interface IdgPacketProvider {
  getPacketSnapshot(
    orgId: string,
    packetId: IdgPatientPacketId,
  ): Promise<{
    snapshot: PacketSnapshot;
    disciplineViews: Record<DisciplineKey, DisciplineViewBlock>;
    coverSummaryLayer1: string;
    coverSummaryLayer2: string | null;
    frozenAt: IsoInstant | null;
  } | null>;

  /** M22 render path — returns the deterministic payload bytes. */
  renderPayloadFor(packetId: IdgPatientPacketId): Promise<IdgPacketRenderPayload>;
}

/** §4.8 — decision reads (consumed by M30 decision-latency measure, M33). */
export interface IdgDecisionProvider {
  /** M30 measure: decision-to-careplan-update latency. */
  getDecisionsForCarePlan(orgId: string, carePlanId: CarePlanId): Promise<IdgDecisionDto[]>;
  getDecisionsForMeeting(orgId: string, meetingId: IdgMeetingId): Promise<IdgDecisionDto[]>;
}

/** §4.8 — schedule + cadence reads (consumed by M28 FHIR `CareTeam`/`Encounter`, M30 cadence measure, M33). */
export interface IdgScheduleProvider {
  listMeetingsForLocation(
    orgId: string,
    locationId: LocationId,
    range: { fromIso: IsoInstant; toIso: IsoInstant },
  ): Promise<IdgMeetingDigest[]>;

  /**
   * ORG-LEVEL IDG meeting-cadence population over a scheduled-start window — M30's
   * `idg_cadence_adherence` input. Returns the numerator/denominator PAIR, not a rate: M30's kernel
   * suppresses a measure whose denominator is under the CMS reportable floor. Aggregate only (D6).
   */
  getCadenceCountsForOrg(
    organizationId: string,
    window: { from: string; to: string },
  ): Promise<{ readonly numerator: number; readonly denominator: number }>;

  /** M30 measure: 15-day-IDG-cadence adherence per admission. */
  getCadenceAdherence(
    orgId: string,
    admissionId: AdmissionId,
  ): Promise<{
    admissionDayCount: number;
    reviewCount: number;
    longestGapDays: number;
    isCompliant: boolean;
  }>;
}
