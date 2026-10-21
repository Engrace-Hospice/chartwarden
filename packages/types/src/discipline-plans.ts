// @chartwarden/types — Module 15 (Discipline Care Plans) leaf contracts (M15-T01).
//
// Per M15-F01 / ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package: the M15 spec's
// references to `packages/discipline-plans/src/{seams,events}.ts` resolve their TYPE surface HERE so the
// downstream consumers (M14 IDG packet, M16 bereavement risk, M17 pre-schedule gate, M22 plan PDFs, M27 the
// 418.78(e) hours denominator, M28 FHIR `CarePlan`/`QuestionnaireResponse`, M30 measures, M33 dashboards,
// M36 alerts) import them with NO `dependsOn` edge. M15 never imports a feature package.
//
// M15-T01 ships the type-level surface every later M15 task builds on: the §3.2 pgEnum value mirrors, the
// §3.3 owned-table names + the §3.6 / §8.1 audit denylists (the M4 trigger arguments for M15-T02), the §2.4
// `m15.*` outbox event names + payload types, the §4.7 typed M36 alert payloads, and the §4.3 published-seam
// interfaces + their read DTOs. The pure-data policy constants — the D3 supervisory-cadence catalog, the D10
// initial-assessment clocks, the D11 required-signer sets, the D1 plan-kind ↔ author-discipline matrix, the
// §418.78(e) ratio thresholds — live in the `@chartwarden/discipline-plans` FEATURE package. This file is
// type-only and importable by everyone with no edge.
//
// ── LOCKED-ELSEWHERE SEAMS (M15-T01 gotcha) ──────────────────────────────────────────────────────────
// `VolunteerComplianceProvider` and `SupervisoryCadenceReader` are ALREADY declared in `./scheduling.ts`:
// M17 shipped first and registered them as fail-closed deny-stubs (M17-F06 / ADR-0009), so those two
// interfaces are the LOCKED consumer contracts and M15-T05 binds live impls to exactly those shapes. They
// are NOT redefined here (`export *` would make a second definition a TS2308 collision — the M14
// `IdgDecisionPayload` precedent). The richer M15 §4.3 surface that M17's contract does not cover
// (`listExpiringGates`, `listOverdueSupervisory`, the per-PLAN cadence read) ships below as the additive
// `VolunteerGateExpiryReader` / `SupervisoryCadencePlanReader` seams.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { AdmissionId, PatientId, ProviderEntityId } from "./admission";
import type {
  ConsentId,
  GoalId,
  IdgDecisionId,
  InterventionId,
  IsoInstant,
  LocationId,
  MembershipId,
  ProblemId,
} from "./care-plan";

// ── M15-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @chartwarden/db) ─────────
export type DisciplinePlanId = string;
export type DisciplinePlanVersionId = string;
export type DisciplinePlanSignatureId = string;
export type DisciplineGoalId = string;
export type DisciplineInterventionId = string;
export type DisciplineAssessmentId = string;
export type AideSupervisoryVisitId = string;
export type VolunteerAssignmentId = string;
export type VolunteerComplianceGateId = string;
export type VolunteerHourLedgerId = string;
export type VolunteerHourEntryId = string;
/** The §2.2.7 ledger key's fiscal year (a four-digit CY/FY integer, not a date). */
export type FiscalYear = number;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ─────────────────────

/** The D1 shared-row discriminator (mirrors `discipline_plan_kind`). */
export type DisciplinePlanKind = "aide_poc" | "msw_plan" | "spiritual_plan" | "volunteer_plan";

/** The §2.2.1 plan-root lifecycle (mirrors `discipline_plan_status`). */
export type DisciplinePlanStatus = "draft" | "active" | "draft_revising" | "discharged";

/** The §2.2.2 / D2 hybrid-versioning lifecycle (mirrors `discipline_plan_version_status`). */
export type DisciplinePlanVersionStatus = "draft" | "in_review" | "signed" | "superseded";

/** The version taxonomy mirroring M7's (mirrors `discipline_plan_version_kind`). */
export type DisciplinePlanVersionKind = "initial" | "idg_review" | "interim_revision" | "discharge";

/** D5 / M7 D6 attribution (mirrors `discipline_goal_source`). */
export type DisciplineGoalSource = "clinical" | "patient_stated" | "family_stated" | "agent_stated";

/** The §2.2.3 goal lifecycle (mirrors `discipline_goal_status`). */
export type DisciplineGoalStatus =
  | "not_started"
  | "in_progress"
  | "met"
  | "not_met"
  | "revised"
  | "discontinued";

/** The §2.2.3 intervention lifecycle (mirrors `discipline_intervention_status`). */
export type DisciplineInterventionStatus = "active" | "discontinued" | "completed";

/** The D6 per-discipline assessment taxonomy (mirrors `discipline_assessment_kind`). */
export type DisciplineAssessmentKind =
  | "msw_psychosocial"
  | "chaplain_spiritual"
  | "aide_environmental"
  | "volunteer_relationship";

/** Append-only correction-of-record states (mirrors `discipline_assessment_status`). */
export type DisciplineAssessmentStatus = "draft" | "signed" | "amended";

/** 42 CFR §418.76(h)(2) supervisory contact mode (mirrors `aide_supervisory_attestation_mode`). */
export type AideSupervisoryAttestationMode = "aide_present" | "observation_of_work";

/** The §418.78(b)(1)/(d) gate postures (mirrors `volunteer_gate_kind`). */
export type VolunteerGateKind =
  | "background_check"
  | "tb_screening"
  | "confidentiality_agreement"
  | "initial_training"
  | "annual_ce"
  | "assignment_specific_training"
  | "vaccination_status";

/** The §2.2.6 gate lifecycle (mirrors `volunteer_gate_status`). */
export type VolunteerGateStatus =
  | "satisfied"
  | "expiring_soon"
  | "expired"
  | "revoked"
  | "not_yet_satisfied";

/** The §2.2.7 / M15-F04 ledger numerator sources (mirrors `volunteer_hour_entry_source`). */
export type VolunteerHourEntrySource = "encounter" | "volunteer_admin_hours" | "manual_adjustment";

/** The per-kind signer roles the §3.5 D11 `RequiredSignerSet` constants draw from. `chha_acknowledgment`
 *  is deliberately NOT a cosignature — CoP 418.76 grants the supervising RN authorship and the aide only
 *  acknowledges they will execute the plan. */
export type DisciplineSignerRole =
  | "rn_case_manager"
  | "chha_acknowledgment"
  | "msw"
  | "chaplain"
  | "volunteer_coordinator";

/** The authoring discipline stamped on a goal / intervention (§2.3 discipline-scope enforcement). Named
 *  `DisciplineAuthorRole` rather than the spec's bare "discipline" because `./idg.ts` already exports a
 *  (broader, packet-facing) `DisciplineKey` and `export *` would make a second definition a TS2308 collision. */
export type DisciplineAuthorRole =
  | "rn"
  | "lpn"
  | "chha"
  | "msw"
  | "chaplain"
  | "volunteer_coordinator";

// ── §3.3 owned-table names + §3.6 / §8.1 audit denylist (the M4 trigger arguments for M15-T02) ────────

/** The eleven §3.3 owned tables (the manifest `ownedTables` set). */
export type M15TableName =
  | "discipline_care_plan"
  | "discipline_care_plan_version"
  | "discipline_care_plan_signature"
  | "discipline_goal"
  | "discipline_intervention"
  | "discipline_assessment"
  | "aide_supervisory_visit"
  | "volunteer_assignment"
  | "volunteer_compliance_gate"
  | "volunteer_hour_ledger"
  | "volunteer_hour_entry";

/** Per-table audit denylist (§3.6 Phase B / §8.1). Free-text PHI that must NOT enter
 *  `audit_event.before/after` values — the M4 trigger captures a `<changed>` marker instead. Empty array =
 *  structural fields only. The `data->>...` / `state_snapshot->...` entries are json-path denylists for the
 *  narrative free-text nested inside the jsonb columns (the per-kind plan `data` payload's technique/
 *  precaution/safety prose and the sealed version snapshot, which embeds the same). */
export const M15_AUDIT_DENYLIST: { readonly [K in M15TableName]: readonly string[] } = {
  discipline_care_plan: ["spiritual_care_declined"],
  discipline_care_plan_version: [
    "state_snapshot->goals",
    "state_snapshot->interventions",
    "state_snapshot->data",
  ],
  discipline_care_plan_signature: ["attestation_text"],
  discipline_goal: ["original_text", "revised_text", "measurable_outcome", "modality_text"],
  discipline_intervention: ["scope_text", "discontinuation_reason"],
  discipline_assessment: [
    "amendment_reason",
    "data->>notes",
    "data->>narrativeRef",
    "data->>safetyConsiderations",
    "data->focuses",
    "data->concerns",
    "data->bereavementRiskFactors",
  ],
  aide_supervisory_visit: ["corrective_actions", "supervisory_narrative"],
  volunteer_assignment: ["inactivation_reason"],
  volunteer_compliance_gate: ["notes", "revoked_reason"],
  volunteer_hour_ledger: [],
  volunteer_hour_entry: ["adjustment_reason"],
} as const;

// ── §2.4 outbox event names (the canonical wire identifiers the dispatcher + arch:gaps validate) ──────

/** The full §2.4 M15 outbox taxonomy, in canonical `m15.<resource>.<verb>` form. M14 consumes
 *  `bootstrapped`/`idg_decision.applied`; M16 `plan.discharged`; M17 `volunteer.assignment_inactivated`;
 *  M22 the version/discharge/amendment render handshakes; M28 the FHIR projection; M30 + M33 the compliance
 *  and ratio streams; M36 every alert-bearing event. Publication wiring lands with the routes/workers. */
export const M15_EVENT_NAMES = [
  "m15.plan.bootstrapped",
  "m15.plan.version_signed",
  "m15.plan.discharged",
  "m15.aide_supervisory.completed",
  "m15.aide_supervisory.overdue",
  "m15.msw.assessment_initial_overdue",
  "m15.chaplain.assessment_initial_overdue",
  "m15.volunteer.gate_expiring",
  "m15.volunteer.gate_expired",
  "m15.volunteer.assignment_inactivated",
  "m15.volunteer.ratio_recomputed",
  "m15.idg_decision.applied",
  "m15.discipline_assessment.amended",
] as const;

/** An M15 outbox event name (§2.4). */
export type M15EventName = (typeof M15_EVENT_NAMES)[number];

/** The §2.4 idempotency key each event's consumer de-duplicates on. */
export const M15_EVENT_IDEMPOTENCY_KEYS = {
  "m15.plan.bootstrapped": "planId",
  "m15.aide_supervisory.completed": "supervisoryVisitId",
  "m15.idg_decision.applied": "idgDecisionId",
} as const satisfies Partial<Record<M15EventName, string>>;

// ── §2.4 outbox payloads (the shape each subscriber type-checks against) ──────────────────────────────

/** One entry of the D11 required-signer set captured on the version at `in_review` (§3.5). */
export interface DisciplineRequiredSigner {
  readonly role: DisciplineSignerRole;
  readonly count: number;
  /** True for the CoP 418.76 CHHA acknowledgment (NOT a cosignature — see {@link DisciplineSignerRole}). */
  readonly isAcknowledgment: boolean;
}

/** The D11 quorum for one version kind (§3.5). */
export type DisciplineRequiredSignerSet = readonly DisciplineRequiredSigner[];

/** `m15.plan.bootstrapped` — a plan stub was created (M6 `admission.activated`, or a first volunteer
 *  assignment for `volunteer_plan`). Consumers: M14, M33. */
export interface M15PlanBootstrappedPayload {
  readonly planId: DisciplinePlanId;
  readonly admissionId: AdmissionId;
  readonly patientId: PatientId;
  readonly kind: DisciplinePlanKind;
  readonly requiredSignerSet: DisciplineRequiredSignerSet;
}

/** `m15.plan.version_signed` — the required-signer set was satisfied. Consumers: M22, M28, M14, M30, M33. */
export interface M15PlanVersionSignedPayload {
  readonly planId: DisciplinePlanId;
  readonly versionId: DisciplinePlanVersionId;
  readonly kind: DisciplinePlanKind;
  readonly versionKind: DisciplinePlanVersionKind;
  /** The sealed §2.2.2 `state_snapshot` (opaque to the transport; M22/M28 read it through the DTOs below). */
  readonly snapshot: unknown;
  readonly signers: ReadonlyArray<{
    readonly membershipId: MembershipId;
    readonly role: DisciplineSignerRole;
    readonly signedAt: IsoInstant;
    readonly isAcknowledgment: boolean;
  }>;
}

/** `m15.plan.discharged` — the plan sealed on `m6.admission.discharged`. Consumers: M16, M22, M30, M33. */
export interface M15PlanDischargedPayload {
  readonly planId: DisciplinePlanId;
  readonly admissionId: AdmissionId;
  readonly kind: DisciplinePlanKind;
  readonly finalSnapshotVersionId: DisciplinePlanVersionId;
}

/** `m15.aide_supervisory.completed` — a 418.76(h) attestation landed. Consumers: M30, M33, M36. */
export interface M15AideSupervisoryCompletedPayload {
  readonly planId: DisciplinePlanId;
  readonly supervisoryVisitId: AideSupervisoryVisitId;
  readonly aideMembershipId: MembershipId;
  readonly supervisingRnMembershipId: MembershipId;
  readonly attestationMode: AideSupervisoryAttestationMode;
  readonly performanceSatisfactory: boolean;
  readonly nextDueAt: IsoInstant;
}

/** `m15.aide_supervisory.overdue` — the 6-hourly cron found a breached cadence clock. Consumer: M36. */
export interface M15AideSupervisoryOverduePayload {
  readonly planId: DisciplinePlanId;
  readonly hoursOverdue: number;
  readonly severity: "warn" | "critical";
}

/** `m15.msw.assessment_initial_overdue` — the D10 5-day MSW clock elapsed unsatisfied. Consumer: M36. */
export interface M15MswInitialOverduePayload {
  readonly planId: DisciplinePlanId;
  readonly admissionId: AdmissionId;
  readonly daysOverdue: number;
  readonly severity: "warn" | "critical";
}

/** `m15.chaplain.assessment_initial_overdue` — the D10 5-day chaplain clock elapsed with neither a signed
 *  initial assessment nor a recorded declination (§7.3). Consumer: M36. */
export interface M15ChaplainInitialOverduePayload {
  readonly planId: DisciplinePlanId;
  readonly admissionId: AdmissionId;
  readonly daysOverdue: number;
}

/** `m15.volunteer.gate_expiring` — the nightly watcher's 30/14/7/1-day notice. Consumer: M36. */
export interface M15VolunteerGateExpiringPayload {
  readonly volunteerMembershipId: MembershipId;
  readonly gateKind: VolunteerGateKind;
  readonly validUntil: IsoInstant;
  readonly daysOut: number;
  readonly severity: "info" | "warn" | "critical";
}

/** `m15.volunteer.gate_expired` — a gate flipped to `expired`. Consumer: M36. */
export interface M15VolunteerGateExpiredPayload {
  readonly volunteerMembershipId: MembershipId;
  readonly gateKind: VolunteerGateKind;
  readonly expiredAt: IsoInstant;
  readonly openAssignmentsCount: number;
}

/** `m15.volunteer.assignment_inactivated` — an expired gate flipped the volunteer inactive, so M17 must
 *  drop them from the schedule. Consumers: M17, M33, M36. */
export interface M15VolunteerAssignmentInactivatedPayload {
  readonly volunteerMembershipId: MembershipId;
  readonly affectedPlanIds: readonly DisciplinePlanId[];
  readonly reason: string;
}

/** `m15.volunteer.ratio_recomputed` — the nightly §2.2.7 ledger refresh. Consumers: M33, M30. */
export interface M15VolunteerRatioRecomputedPayload {
  readonly providerEntityId: ProviderEntityId;
  readonly fiscalYear: FiscalYear;
  /** The §418.78(e) NUMERATOR only — volunteer minutes. The denominator is M27/M23 staffing hours
   *  (M15-F04: hours ÷ hours, never dollars) and is resolved at read time. */
  readonly hoursMinutes: number;
  readonly status: VolunteerRatioStatus;
}

/** `m15.idg_decision.applied` — the M14 decision consumer wrote a draft next version. Consumer: M14. */
export interface M15IdgDecisionAppliedPayload {
  readonly planId: DisciplinePlanId;
  readonly versionId: DisciplinePlanVersionId;
  readonly idgDecisionId: IdgDecisionId;
  readonly mutationsApplied: number;
}

/** `m15.discipline_assessment.amended` — a signed amendment landed. Consumers: M22, M30. */
export interface M15DisciplineAssessmentAmendedPayload {
  readonly planId: DisciplinePlanId;
  readonly assessmentId: DisciplineAssessmentId;
  readonly kind: DisciplineAssessmentKind;
  readonly amendedFields: readonly string[];
  readonly attestation: string;
}

/** Name → payload map for the §2.4 taxonomy (the dispatcher's compile-time contract). */
export interface M15EventPayloadMap {
  "m15.plan.bootstrapped": M15PlanBootstrappedPayload;
  "m15.plan.version_signed": M15PlanVersionSignedPayload;
  "m15.plan.discharged": M15PlanDischargedPayload;
  "m15.aide_supervisory.completed": M15AideSupervisoryCompletedPayload;
  "m15.aide_supervisory.overdue": M15AideSupervisoryOverduePayload;
  "m15.msw.assessment_initial_overdue": M15MswInitialOverduePayload;
  "m15.chaplain.assessment_initial_overdue": M15ChaplainInitialOverduePayload;
  "m15.volunteer.gate_expiring": M15VolunteerGateExpiringPayload;
  "m15.volunteer.gate_expired": M15VolunteerGateExpiredPayload;
  "m15.volunteer.assignment_inactivated": M15VolunteerAssignmentInactivatedPayload;
  "m15.volunteer.ratio_recomputed": M15VolunteerRatioRecomputedPayload;
  "m15.idg_decision.applied": M15IdgDecisionAppliedPayload;
  "m15.discipline_assessment.amended": M15DisciplineAssessmentAmendedPayload;
}

// ── §4.7 M36 typed-alert payloads (deterministic; M36 doesn't re-template) ────────────────────────────
// No free-text PHI in the payloads — ids + structural facts + a deterministic `ctaPath`; M36 resolves
// recipient PHI per permission scope.

/** §4.7 — the 418.76(h) supervisory clock breached (day 14; day 16 engages the encounter-sign gate). */
export interface AideSupervisoryOverdueAlert {
  readonly kind: "m15.aide_supervisory.overdue";
  readonly severity: "warn" | "critical";
  readonly organizationId: string;
  /** The supervising RN; the +24h escalation re-targets the Clinical Supervisor. */
  readonly recipientMembershipId: MembershipId;
  readonly planId: DisciplinePlanId;
  readonly patientId: PatientId;
  readonly hoursOverdue: number;
  readonly ctaPath: string;
}

/** §4.7 — the D10 5-day MSW initial-psychosocial clock breached (day 7 escalates to Clin Supv + DON). */
export interface MswInitialOverdueAlert {
  readonly kind: "m15.msw.initial_assessment_overdue";
  readonly severity: "warn" | "critical";
  readonly organizationId: string;
  readonly recipientMembershipId: MembershipId;
  readonly planId: DisciplinePlanId;
  readonly patientId: PatientId;
  readonly daysOverdue: number;
  readonly ctaPath: string;
}

/** §4.7 — the 30/14/7/1-day volunteer-gate expiry notice to the Volunteer Coordinator. */
export interface VolunteerGateExpiringAlert {
  readonly kind: "m15.volunteer.gate_expiring";
  /** By `daysOut`: 30 → info, 14 → warn, 7 → warn, 1 → critical. */
  readonly severity: "info" | "warn" | "critical";
  readonly organizationId: string;
  readonly recipientMembershipId: MembershipId;
  readonly volunteerMembershipId: MembershipId;
  readonly gateKind: VolunteerGateKind;
  readonly validUntil: IsoInstant;
  readonly daysOut: number;
}

/** §4.7 — the 42 CFR §418.78(e) ratio fell under the 5% floor (warn 3–5%, critical <3%). */
export interface VolunteerRatioBelowFloorAlert {
  readonly kind: "m15.volunteer.ratio_below_floor";
  readonly severity: "warn" | "critical";
  readonly organizationId: string;
  /** DON + Compliance Officer + Volunteer Coordinator. */
  readonly recipientMembershipIds: readonly MembershipId[];
  readonly providerEntityId: ProviderEntityId;
  readonly fiscalYear: FiscalYear;
  readonly ratio: number;
  readonly ctaPath: string;
}

/** The §4.7 discriminated union of every typed alert M15 emits to M36. */
export type M15AlertPayload =
  | AideSupervisoryOverdueAlert
  | MswInitialOverdueAlert
  | VolunteerGateExpiringAlert
  | VolunteerRatioBelowFloorAlert;

// ── §4.3 published-seam read DTOs (read-only projections; never Drizzle rows) ─────────────────────────

/** §4.3 — the plan-grid row `DisciplinePlanReader.activePlansForPatient` returns (M14 packet, M33). */
export interface DisciplinePlanDigest {
  readonly planId: DisciplinePlanId;
  readonly organizationId: string;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId;
  readonly kind: DisciplinePlanKind;
  readonly status: DisciplinePlanStatus;
  readonly lastSignedVersionId: DisciplinePlanVersionId | null;
  readonly lastSignedAt: IsoInstant | null;
  /** `aide_poc` only; null on the other three kinds. */
  readonly nextSupervisoryDueAt: IsoInstant | null;
  readonly initialAssessmentSignedAt: IsoInstant | null;
  readonly spiritualCareDeclinedAt: IsoInstant | null;
}

/** §4.3 — one discipline goal in a plan read (D5: `parentGoalId` is a nullable logical FK to M7). */
export interface DisciplineGoalDto {
  readonly id: DisciplineGoalId;
  readonly planId: DisciplinePlanId;
  readonly parentGoalId: GoalId | null;
  readonly parentProblemId: ProblemId | null;
  readonly source: DisciplineGoalSource;
  readonly status: DisciplineGoalStatus;
  /** Immutable after creation for every non-`clinical` source (§2.3 / M7 D6). */
  readonly originalText: string;
  readonly revisedText: string | null;
  readonly measurableOutcome: string | null;
  readonly targetAt: IsoInstant | null;
  readonly frequencyValue: string | null;
  readonly modalityText: string | null;
  /** Non-null exactly when `source === 'agent_stated'` (the active M39 `dpoa_healthcare` consent). */
  readonly actingConsentId: ConsentId | null;
  readonly addedByMembershipId: MembershipId;
  readonly addedByDiscipline: DisciplineAuthorRole;
}

/** §4.3 — one discipline intervention in a plan read. */
export interface DisciplineInterventionDto {
  readonly id: DisciplineInterventionId;
  readonly planId: DisciplinePlanId;
  readonly parentInterventionId: InterventionId | null;
  readonly goalRefs: readonly DisciplineGoalId[];
  readonly scopeText: string;
  readonly frequencyText: string;
  readonly frequencyValue: string;
  readonly discipline: DisciplineAuthorRole;
  readonly responsibleRoles: readonly string[];
  readonly status: DisciplineInterventionStatus;
  readonly discontinuationReason: string | null;
}

/** §4.3 — one discipline assessment header. The `data` body is per-kind TypeBox-validated and is SUD /
 *  family-violence gated at the read path (§2.3), so it is omitted from the digest projection. */
export interface DisciplineAssessmentDto {
  readonly id: DisciplineAssessmentId;
  readonly planId: DisciplinePlanId;
  readonly kind: DisciplineAssessmentKind;
  readonly status: DisciplineAssessmentStatus;
  readonly capturedAt: IsoInstant;
  readonly isInitial: boolean;
  readonly sudFlag: boolean;
  readonly familyViolenceFlag: boolean;
  readonly amendsAssessmentId: DisciplineAssessmentId | null;
  readonly signedAt: IsoInstant | null;
}

/** §4.3 — the full plan read (`DisciplinePlanReader.planById`). */
export interface DisciplinePlanFull {
  readonly digest: DisciplinePlanDigest;
  /** The D1 per-kind `data` payload (validated by the kind's TypeBox in `@chartwarden/discipline-plans`). */
  readonly data: unknown;
  readonly goals: readonly DisciplineGoalDto[];
  readonly interventions: readonly DisciplineInterventionDto[];
  readonly assessments: readonly DisciplineAssessmentDto[];
  readonly requiredSignerSet: DisciplineRequiredSignerSet;
}

/** §4.3 — the per-discipline IDG one-pager M14's packet builder renders (architecture §10.5.5). */
export interface DisciplinePlanIdgDigest {
  readonly planId: DisciplinePlanId;
  readonly kind: DisciplinePlanKind;
  readonly status: DisciplinePlanStatus;
  /** Layer-1 deterministic; never AI-generated (the M32 `ai.full` narrative is an M16 concern). */
  readonly oneLineSummary: string;
  readonly activeGoalCount: number;
  readonly activeInterventionCount: number;
  readonly lastSignedAt: IsoInstant | null;
  readonly nextSupervisoryDueAt: IsoInstant | null;
  readonly openComplianceFlags: readonly string[];
  /** True when SUD / family-violence content was filtered out of this digest for the reader. */
  readonly appliedConfidentialityFilter: boolean;
}

/** §4.3 — one MSW psychosocial risk factor M16's bereavement scorer reads (§1.2: M15 exposes, never
 *  scores). ICD-10-CM coding is resolved through M38 at capture time. */
export interface MswRiskFactor {
  readonly planId: DisciplinePlanId;
  readonly admissionId: AdmissionId;
  readonly assessmentId: DisciplineAssessmentId;
  readonly factor: string;
  readonly severity: "low" | "moderate" | "high";
  readonly icd10: string | null;
  readonly capturedAt: IsoInstant;
}

/** §4.3 — an overdue 418.76(h) supervisory clock in the `listOverdueSupervisory` worklist. */
export interface SupervisoryOverdue {
  readonly planId: DisciplinePlanId;
  readonly patientId: PatientId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId;
  readonly aideMembershipId: MembershipId | null;
  readonly supervisingRnMembershipId: MembershipId | null;
  readonly nextDueAt: IsoInstant;
  readonly hoursOverdue: number;
  /** True once the day-16 grace elapsed and CHHA encounter signing is blocked (`AIDE_SUPERVISORY_OVERDUE`). */
  readonly gateEngaged: boolean;
}

/** §4.3 — the per-plan supervisory cadence state (the M17 day-view advisory + the M14 dashboard). */
export interface SupervisoryCadenceState {
  readonly planId: DisciplinePlanId;
  readonly nextDueAt: IsoInstant;
  readonly cadenceDays: number;
  readonly status: "on_time" | "due" | "overdue" | "gate_engaged";
}

/** §4.3 — a gate approaching `valid_until` in the `listExpiringGates` sweep. */
export interface VolunteerGateExpiry {
  readonly membershipId: MembershipId;
  readonly gateKind: VolunteerGateKind;
  readonly validUntil: IsoInstant;
}

/** §4.3 — the scope every `DisciplineComplianceProvider` rate is computed over. Per M15-F05 the PE /
 *  location columns are denormalized onto every M15 table, so these rates need no cross-schema join. */
export interface ComplianceScope {
  readonly orgId: string;
  readonly providerEntityId?: ProviderEntityId;
  readonly locationId?: LocationId;
  readonly fromIso?: IsoInstant;
  readonly toIso?: IsoInstant;
}

/** The §1.1 badge the M33 operator dashboard renders the §418.78(e) ratio with. `unavailable` is the
 *  M15-F04 / D8 honest state while the M27/M23 patient-care-HOURS denominator seam is deny-stubbed. */
export type VolunteerRatioStatus = "unavailable" | "green" | "yellow" | "red";

/** §4.3 — the 418.78(e) ratio read. `ratio` is null exactly when `status === 'unavailable'`. */
export interface VolunteerHourRatio {
  readonly providerEntityId: ProviderEntityId;
  readonly fiscalYear: FiscalYear;
  readonly volunteerHourMinutes: number;
  /** M15-F04: total patient-care HOURS (as minutes) of paid + contract staff — never dollars. */
  readonly staffPatientCareMinutes: number | null;
  readonly ratio: number | null;
  readonly status: VolunteerRatioStatus;
  readonly reason?: string;
}

// ── §4.3 seams this module publishes (impls injected at boot in M15-T05; type-checked at boot) ────────

/** §4.3 — discipline-plan reads (consumed by M14's IDG packet builder, M22, M28, M31, M33). */
export interface DisciplinePlanReader {
  activePlansForPatient(
    orgId: string,
    patientId: PatientId,
  ): Promise<readonly DisciplinePlanDigest[]>;
  planById(orgId: string, planId: DisciplinePlanId): Promise<DisciplinePlanFull | null>;
  planSummaryForIdg(
    orgId: string,
    planId: DisciplinePlanId,
  ): Promise<DisciplinePlanIdgDigest | null>;
}

/** §4.3 — MSW psychosocial risk-factor reads (consumed by M16's bereavement risk rubric). M15 exposes the
 *  factors; the bereavement SCORE is M16's (§1.2). */
export interface MswRiskFactorReader {
  riskFactorsForAdmission(
    orgId: string,
    admissionId: AdmissionId,
  ): Promise<readonly MswRiskFactor[]>;
}

/**
 * §4.3 — the additive volunteer-gate expiry sweep. The per-membership pre-schedule predicate M17 actually
 * gates on is the LOCKED `VolunteerComplianceProvider` in `./scheduling.ts` (M17-F06 deny-stub, bound live
 * in M15-T05); this seam carries the surface that contract does not cover, so M15 can publish it without
 * breaking M17's shipped consumer.
 */
export interface VolunteerGateExpiryReader {
  listExpiringGates(orgId: string, daysOut: number): Promise<readonly VolunteerGateExpiry[]>;
}

/**
 * §4.3 — the additive per-PLAN supervisory cadence + overdue worklist. M17's day view reads the LOCKED
 * per-ADMISSION `SupervisoryCadenceReader` in `./scheduling.ts`; this seam is the per-plan/per-scope
 * surface M14's dashboard and M30's supervisory-on-time measure need.
 */
export interface SupervisoryCadencePlanReader {
  nextSupervisoryDueFor(
    orgId: string,
    planId: DisciplinePlanId,
  ): Promise<SupervisoryCadenceState | null>;
  listOverdueSupervisory(scope: ComplianceScope): Promise<readonly SupervisoryOverdue[]>;
}

/** §4.3 — the compliance rollups (consumed by M30's HQRP measures and M33's operational dashboards).
 *  Every rate is a fraction in [0, 1]; a scope with a zero denominator returns null rather than 0 so the
 *  CMS small-N suppression downstream stays honest. */
export interface DisciplineComplianceProvider {
  supervisoryOnTimeRate(scope: ComplianceScope): Promise<number | null>;
  /**
   * The supervisory population behind {@link supervisoryOnTimeRate} — M30's `supervisory_visit_on_time`
   * input. A rate alone cannot drive a CMS-reportable measure: `ratioResult()` suppresses to
   * `insufficient_n` when the DENOMINATOR is under the small-N floor, and a rate has already discarded
   * it. The store already tallies both; the rate method was where the denominator was being thrown away.
   */
  supervisoryOnTimeCounts(
    scope: ComplianceScope,
  ): Promise<{ readonly numerator: number; readonly denominator: number }>;
  mswInitialOnTimeRate(scope: ComplianceScope): Promise<number | null>;
  chaplainInitialOnTimeRate(scope: ComplianceScope): Promise<number | null>;
  volunteerGateComplianceRate(scope: ComplianceScope): Promise<number | null>;
  /** The volunteer population behind {@link volunteerGateComplianceRate} — M30's
   *  `volunteer_compliance_gate_rate` input. Same reasoning as {@link supervisoryOnTimeCounts}. */
  volunteerGateComplianceCounts(
    scope: ComplianceScope,
  ): Promise<{ readonly numerator: number; readonly denominator: number }>;
  volunteerHourCostRatio(
    orgId: string,
    providerEntityId: ProviderEntityId,
    fiscalYear: FiscalYear,
  ): Promise<VolunteerHourRatio>;
}
