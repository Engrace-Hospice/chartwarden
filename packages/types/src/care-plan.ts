// @wardenx/types — Module 7 (Care Plan / IPOC) leaf contracts (M7-T01).
//
// Per ADR-0005 D1 the cross-module CONTRACTS live in this leaf package (the M7 spec's references to
// `packages/domain/care-plan/*` resolve here — there is no domain/foundation package on the
// cross-module read path; architecture wins). M7-T01 ships the type-level surface every later M7
// task + every cross-module consumer builds on: the §2.2 per-entity audit denylists (the M4 trigger
// arguments for M7-T02/T03), the `m7.*` outbox event names (§2.4), the §11 D5 `RequiredSignerSet`
// constant shape, the §11 D4 `IdgDecisionPayload` (the typed M14 → M7 outbox seam), and the
// `CarePlanReader` seam M8/M14/M15 consume (§7.8). The seam IMPLEMENTATION + its M1-registry wiring
// land in M7-T04; routes in M7-T05; the full outbox publication in M7-T07.

// ── Leaf-safe id + value aliases (mirror the §3.2 pgEnums; packages/types cannot import @wardenx/db) ─

// The shared tenancy/patient/admission id aliases are owned by `./admission` (single definition site);
// import for internal use here (not re-exported) so the package surface stays unambiguous.
import type { AdmissionId, OrgId, PatientId, ProviderEntityId } from "./admission";

export type CarePlanId = string;
export type CarePlanVersionId = string;
export type CarePlanSignatureId = string;
export type ProblemId = string;
export type GoalId = string;
export type InterventionId = string;
export type MembershipId = string;
/** A M14 IDG meeting id (soft-ref; M14 is Wave F). */
export type IdgMeetingId = string;
/** A M14 IDG decision id — the idempotency key on the inbound seam (§11 D4). */
export type IdgDecisionId = string;
/** A M39 consent id (soft-ref; agent-stated goal attribution, §3.3). */
export type ConsentId = string;
export type LocationId = string;

/** ISO `yyyy-mm-ddThh:mm:ssZ` instant (calendar-day math is the org's tz, done service-side). */
export type IsoInstant = string;

/** The §3.2 care-plan root lifecycle (mirrors `care_plan_status`). */
export type CarePlanStatus = "draft" | "active" | "discharged";

/** The §3.2 per-version lifecycle (mirrors `care_plan_version_status`). */
export type CarePlanVersionStatus = "draft" | "in_review" | "signed" | "superseded";

/** Why a version was opened (mirrors `care_plan_version_kind`, §3.2). */
export type CarePlanVersionKind = "initial" | "idg_review" | "interim_revision" | "discharge";

/** The §3.2 problem facet that flows into M23 claim ICD-10 sequencing (mirrors `problem_kind`). */
export type ProblemKind = "terminal" | "related" | "unrelated";

/** The §3.2 problem provenance (mirrors `problem_source`). */
export type ProblemSource =
  | "clinical"
  | "patient_reported"
  | "family_reported"
  | "history"
  | "intake_extraction";

/** The §3.2 problem lifecycle (mirrors `problem_status`). */
export type ProblemStatus = "active" | "resolved" | "inactive";

/** The §3.2 goal provenance; patient/family/agent-stated preserve `original_text` verbatim (D6). */
export type GoalSource = "clinical" | "patient_stated" | "family_stated" | "agent_stated";

/** The §3.2 goal lifecycle (mirrors `goal_status`). */
export type GoalStatus =
  | "not_started"
  | "in_progress"
  | "met"
  | "not_met"
  | "revised"
  | "discontinued";

/** The §3.2 intervention lifecycle (mirrors `intervention_status`). */
export type InterventionStatus = "active" | "discontinued" | "completed";

/** The discipline that owns a care-plan intervention (mirrors `intervention_discipline`, §3.2). */
export type InterventionDiscipline =
  | "rn"
  | "lpn"
  | "chha"
  | "msw"
  | "chaplain"
  | "md_np"
  | "pt"
  | "ot"
  | "st"
  | "volunteer"
  | "music_therapy"
  | "dietitian"
  | "bereavement";

/** The role under which a `care_plan_signature` is captured (mirrors `care_plan_signer_role`, §3.2). */
export type CarePlanSignerRole =
  | "rn_case_manager"
  | "hospice_physician"
  | "nurse_practitioner"
  | "msw"
  | "chaplain"
  | "medical_director";

// ── §2.2 per-entity audit denylists (the free-text/PHI columns the M4 trigger must NOT mirror) ──────
// Captured here as data so M7-T03's `generateAuditTrigger(...)` denylist arguments are derived from a
// single source rather than re-typed per table. The free-text clinical narrative columns
// (`description`, `original_text`, …) and the PHI-bearing `state_snapshot` jsonb are denylisted from
// value capture per §1.1 — the trigger records that a write happened and a `<changed>` marker, never
// the column value. Tables with no sensitive free-text are listed `[]`.

/** The M7 table names that own a write-audit trigger (one per §3.3 table). */
export type M7TableName =
  | "care_plan"
  | "care_plan_version"
  | "care_plan_signature"
  | "problem"
  | "goal"
  | "intervention";

/** Per-table audit denylist (§2.2 / §1.1). Empty array = no free-text PHI on that table. */
export const M7_AUDIT_DENYLIST: { readonly [K in M7TableName]: readonly string[] } = {
  care_plan: [],
  care_plan_version: ["state_snapshot", "patient_understanding_text"],
  care_plan_signature: [],
  problem: ["description", "resolution_note"],
  goal: ["original_text", "revised_text", "measurable_outcome", "status_note"],
  intervention: ["scope_text", "frequency_text", "discontinue_reason"],
} as const;

// ── §2.4 outbox event names (the `m7.*` namespace the dispatcher + arch:gaps catalog validate) ──────

/** The full §2.4 M7 outbox taxonomy, in subscriber-facing `m7.*` form. The system keys off
 * `m7.care_plan.version_signed` (M8 encounter gate / M22 PDF / M28 FHIR), `m7.care_plan.review_overdue`
 * + `m7.care_plan.initial_overdue` (M36 alerts / M8 gate), and `m7.care_plan.discharged`
 * (M16 bereavement). `m7.care_plan.review_due` is the T+13 alert payload (M36 D10, v0.3). The full set
 * is published in M7-T07. */
export const M7_EVENT_NAMES = [
  "m7.care_plan.created",
  "m7.care_plan.version_drafted",
  "m7.care_plan.version_signed",
  "m7.care_plan.review_due",
  "m7.care_plan.review_overdue",
  "m7.care_plan.initial_overdue",
  "m7.care_plan.discharged",
  "m7.problem.added",
  "m7.problem.updated",
  "m7.problem.resolved",
  "m7.goal.added",
  "m7.goal.updated",
  "m7.goal.met",
  "m7.goal.discontinued",
  "m7.intervention.added",
  "m7.intervention.updated",
  "m7.intervention.discontinued",
] as const;

/** An M7 outbox event name (§2.4). */
export type M7EventName = (typeof M7_EVENT_NAMES)[number];

// ── §11 D5 Required Signer Set (the typed quorum constants captured on each version at in_review) ────

/** One required-signer slot: a role (or either-of role union) and how many signatures it needs. */
export interface RequiredSignerSlot {
  /** The role that satisfies this slot; a `|`-joined union (e.g. `hospice_physician|nurse_practitioner`)
   * means any one of those roles satisfies it (the version stores the resolved role at sign time). */
  readonly role: string;
  readonly count: number;
}

/** The quorum a version must collect before it can transition to `signed` (§11 D5). Stored as jsonb
 * on `care_plan_version.required_signer_set` at the `draft → in_review` transition so survey
 * reconstruction is deterministic; tenants may tighten (more signers) but not loosen below this floor. */
export type RequiredSignerSet = ReadonlyArray<RequiredSignerSlot>;

/** §11 D5 — INITIAL quorum: hospice physician **or** NP (attending) + RN case manager. */
export const REQUIRED_SIGNER_SET_INITIAL: RequiredSignerSet = [
  { role: "hospice_physician|nurse_practitioner", count: 1 },
  { role: "rn_case_manager", count: 1 },
] as const;

/** §11 D5 — IDG_REVIEW quorum: RN + MSW + chaplain + MD/DO (M07-F01: the IDG physician seat is
 * MD/DO only — an NP may not occupy it; `nurse_practitioner` is removed from this set). */
export const REQUIRED_SIGNER_SET_IDG_REVIEW: RequiredSignerSet = [
  { role: "rn_case_manager", count: 1 },
  { role: "msw", count: 1 },
  { role: "chaplain", count: 1 },
  { role: "hospice_physician|medical_director", count: 1 },
] as const;

// ── §11 D4 IDG decision payload (the typed M14 → M7 outbox seam; idempotent on idgDecisionId) ────────

/** The clinical mutation an IDG decision applies to a care plan (§7.9 / §11 D4). M14 is Wave F; this
 * payload is published now so M14's `idg.decision_recorded` event is compile-time type-checked against
 * the shape M7's `apply-idg-decision` worker consumes. */
export interface IdgDecisionPayload {
  /** Idempotency key — the worker no-ops if a version already records this decision (§11 D4). */
  readonly idgDecisionId: IdgDecisionId;
  readonly idgMeetingId: IdgMeetingId;
  readonly planId: CarePlanId;
  readonly patientId: PatientId;
  /** The set of element mutations the meeting decided (add/update/discontinue problem/goal/intervention). */
  readonly changes: ReadonlyArray<IdgDecisionChange>;
}

/** A single element mutation inside an {@link IdgDecisionPayload}. */
export type IdgDecisionChange =
  | {
      readonly target: "problem";
      readonly op: "add" | "update" | "discontinue";
      readonly problemId?: ProblemId;
    }
  | {
      readonly target: "goal";
      readonly op: "add" | "update" | "discontinue";
      readonly goalId?: GoalId;
    }
  | {
      readonly target: "intervention";
      readonly op: "add" | "update" | "discontinue";
      readonly interventionId?: InterventionId;
      readonly discipline?: InterventionDiscipline;
    };

// ── §7.8 CarePlanReader seam DTOs (read-only; returned by the seam below, never Drizzle rows) ────────

/** A care-plan problem projection for the encounter-relevance picker (§7.8). Free-text `description`
 * is included for clinician display but SUD-flagged problems are filtered SQL-side when the caller
 * lacks a `42_cfr_part_2_release` consent context (D7). */
export interface RelevantProblem {
  readonly problemId: ProblemId;
  readonly icd10Code: string | null;
  readonly snomedCode: string | null;
  readonly description: string;
  readonly kind: ProblemKind;
  readonly status: ProblemStatus;
}

/** A care-plan goal projection for the encounter-relevance picker (§7.8). */
export interface RelevantGoal {
  readonly goalId: GoalId;
  readonly problemId: ProblemId;
  readonly text: string;
  readonly source: GoalSource;
  readonly status: GoalStatus;
}

/** A care-plan intervention projection for the encounter-relevance picker (§7.8). */
export interface RelevantIntervention {
  readonly interventionId: InterventionId;
  readonly problemId: ProblemId;
  readonly scopeText: string;
  readonly frequencyText: string;
  readonly discipline: InterventionDiscipline;
  readonly status: InterventionStatus;
}

/** The encounter-relevance result M8 renders its problem/goal/intervention picker from (§7.8). The
 * `relevantElementsForEncounter` reader returns active problems plus the active interventions tagged
 * with the requested discipline and their parent problems' goals. `redacted=true` when SUD content
 * was filtered out for the caller (D7). */
export interface RelevantCarePlanElements {
  readonly planId: CarePlanId;
  readonly patientId: PatientId;
  readonly problems: ReadonlyArray<RelevantProblem>;
  readonly goals: ReadonlyArray<RelevantGoal>;
  readonly interventions: ReadonlyArray<RelevantIntervention>;
  readonly redacted: boolean;
}

/** The result of an overdue-gate evaluation (§7.8). M8 calls this during encounter signing: when
 * `overdue=true`, the encounter `signed` transition is blocked with `CARE_PLAN_REVIEW_OVERDUE`
 * (override path requires a Clinical Supervisor with reason). */
export interface CarePlanOverdueStatus {
  readonly planId: CarePlanId;
  readonly patientId: PatientId;
  /** Either gate engaged: the 15-day review gate or (pre-first-version) the 5-day initial gate. */
  readonly overdue: boolean;
  readonly initialOverdue: boolean;
  readonly reviewOverdue: boolean;
  readonly initialDueAt: IsoInstant;
  readonly nextReviewDueAt: IsoInstant | null;
}

/**
 * One problem-list row that references a terminology code, projected for M38's §7.3 deprecation
 * remediation rollup (GAP-063). Deliberately NOT PHI-bearing beyond the row id: the report tells a
 * Compliance Officer *which codes* need remediation and *how many* records use each, so the code +
 * a record id for drill-down is the whole minimum-necessary payload — no description, no patient id.
 *
 * `systemId` is a plain string, not `CodeSystemId`: @wardenx/types is a LEAF and may not import
 * @wardenx/terminology (`leaves-stay-leaves`). M38 narrows it on receipt; an unrecognised system id
 * simply matches no deprecation mapping.
 */
export interface CarePlanCodeUsageRecord {
  readonly recordId: string;
  /** Record class for the rollup's per-area breakdown — always `"problem_list"` from this producer. */
  readonly recordType: string;
  readonly systemId: string;
  readonly code: string;
}

// ── §7.8 CarePlanReader seam interface ──────────────────────────────────────────────────────────────

/**
 * §7.8 — the read surface M8 (encounter authoring + sign gate), M14 (IDG packet), and M15 (discipline
 * care plans) consume. Resolved within the consumer's tenant context (the reader does not switch
 * tenants); SUD redaction is applied SQL-side, not trusting the caller's scope assertion (D7). The
 * concrete implementation + its M1-registry wiring land in M7-T04; read-only DTOs above.
 */
export interface CarePlanReader {
  /** Populate the encounter form's element picker — active problems, the active interventions tagged
   * with `discipline`, and their parent problems' goals (§7.8). */
  relevantElementsForEncounter(
    patientId: PatientId,
    encounterType: string,
    discipline: InterventionDiscipline,
  ): Promise<RelevantCarePlanElements | null>;

  /** Whether the patient's active care plan is past a CoP 418.56 gate (5-day initial / 15-day review).
   * M8 calls this at encounter-sign time; `overdue=true` blocks signing (§7.8). */
  isReviewOverdue(patientId: PatientId): Promise<CarePlanOverdueStatus | null>;

  /**
   * ORG-LEVEL 15-day review-cycle population over a due-date window — M30's
   * `care_plan_15_day_adherence` input. Returns the numerator/denominator PAIR, not a rate: M30's kernel
   * suppresses a measure whose denominator is under the CMS reportable floor. Aggregate only (D6).
   */
  fifteenDayCycleCountsForOrg(
    organizationId: string,
    window: { from: string; to: string },
  ): Promise<{ readonly numerator: number; readonly denominator: number }>;

  /**
   * ORG-LEVEL problem-list terminology-code usage — M38's `/api/v1/terminology/remediation` input
   * (GAP-063). The spec's §7.3 rollup names three record classes (problem list, claim line, order);
   * this is the problem-list one. M38 owns no patient data and cannot read `problem` (it `dependsOn`
   * [1,2,3,4]), so the producer projects its own rows and M38 joins them against `deprecation_mapping`.
   *
   * Returns only rows whose `(systemId, code)` is in `codes` — the caller passes the currently
   * deprecated set, so an org with no exposure costs one indexed lookup and returns nothing. Active
   * (non-resolved) problems only: remediating a resolved problem's code is not compliance work.
   */
  terminologyCodeUsageForOrg(
    organizationId: string,
    codes: ReadonlyArray<{ readonly systemId: string; readonly code: string }>,
  ): Promise<ReadonlyArray<CarePlanCodeUsageRecord>>;
}
