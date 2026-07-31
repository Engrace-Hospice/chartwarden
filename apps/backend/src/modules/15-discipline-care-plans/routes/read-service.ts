// apps/backend/src/modules/15-discipline-care-plans/routes/read-service.ts — the M15 READ service
// interface (the §4.1 GET surface) + its response DTOs.
//
// Every method takes the SERVER-assembled actor (org + user + membership + roles + session class) and
// resolves three things before it queries: the §4.1 `caseload_or_scope` equivalent (`actorMayReadPatient`),
// the §7.8 SUD gate and the §7.9 family-violence gate (`resolveDisclosure`). The confidential rows a caller
// is not cleared for are excluded IN SQL (never fetched-then-hidden) and the categories withheld ride the
// `redacted_categories` envelope field — §7.8's contract with the UI.
//
// The DTOs are deliberately narrower than the tables: no `state_snapshot` on a list row, no attestation
// narrative on a summary, no revocation reason on a gate list. Free-text that the M4 trigger denylists is
// surfaced only where the route's permission key names it.
import type { M15ReadActor } from "./actor";
import type { CursorPage } from "./concurrency";
import type { RedactedCategory } from "./disclosure";

/** §4.1 route 1 — a plan as the worklist sees it. */
export interface DisciplinePlanListItem {
  readonly planId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly kind: string;
  readonly status: string;
  readonly nextSupervisoryDueAt: string | null;
  readonly initialAssessmentClockStartedAt: string | null;
  readonly initialAssessmentSignedAt: string | null;
  readonly spiritualCareDeclinedAt: string | null;
  readonly updatedAt: string;
  readonly version: number;
}

/** A `discipline_goal` row on the full-plan read (SUD-flagged rows are filtered upstream, §7.8). */
export interface DisciplineGoalView {
  readonly goalId: string;
  readonly parentProblemId: string | null;
  readonly parentGoalId: string | null;
  readonly source: string;
  readonly status: string;
  readonly originalText: string;
  readonly revisedText: string | null;
  readonly measurableOutcome: string | null;
  readonly targetAt: string | null;
  readonly frequencyText: string | null;
  readonly frequencyValue: string | null;
  readonly modalityText: string | null;
  readonly sudRelated: boolean;
  readonly addedByDiscipline: string;
  readonly addedAt: string;
  readonly version: number;
}

/** A `discipline_intervention` row on the full-plan read. */
export interface DisciplineInterventionView {
  readonly interventionId: string;
  readonly parentInterventionId: string | null;
  readonly goalRefs: readonly string[];
  readonly scopeText: string;
  readonly frequencyText: string;
  readonly frequencyValue: string;
  readonly discipline: string;
  readonly responsibleRoles: readonly string[];
  readonly status: string;
  readonly discontinuationReason: string | null;
  readonly addedByDiscipline: string;
  readonly addedAt: string;
  readonly version: number;
}

/** A `discipline_assessment` row (SUD / family-violence flagged rows are filtered upstream, §7.8/§7.9). */
export interface DisciplineAssessmentView {
  readonly assessmentId: string;
  readonly kind: string;
  readonly status: string;
  readonly capturedAt: string;
  readonly isInitial: boolean;
  readonly sudFlag: boolean;
  readonly familyViolenceFlag: boolean;
  readonly sourceEncounterId: string | null;
  readonly data: unknown;
  readonly amendsAssessmentId: string | null;
  readonly amendmentReason: string | null;
  readonly capturedByMembershipId: string;
  readonly signedAt: string | null;
  readonly signedByMembershipId: string | null;
  readonly version: number;
}

/** An `aide_supervisory_visit` row (§2.2.4). */
export interface AideSupervisoryVisitView {
  readonly supervisoryVisitId: string;
  readonly aideMembershipId: string;
  readonly supervisingRnMembershipId: string;
  readonly sourceEncounterId: string | null;
  readonly supervisoryAt: string;
  readonly attestationMode: string;
  readonly aidePerformanceSatisfactory: boolean;
  readonly correctiveActions: string | null;
  readonly supervisoryNarrative: string;
  readonly nextDueAt: string;
  readonly cadenceDaysAtInsert: number;
  readonly signedAt: string | null;
  readonly version: number;
}

/** A `volunteer_assignment` row (§2.2.5). */
export interface VolunteerAssignmentView {
  readonly assignmentId: string;
  readonly volunteerMembershipId: string;
  readonly coordinatorMembershipId: string;
  readonly activities: readonly string[];
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly coordinatorAcknowledgedAt: string | null;
  readonly inactivatedAt: string | null;
  readonly inactivationReason: string | null;
  readonly version: number;
}

/** A `discipline_care_plan_version` row on the version list (route 4). */
export interface DisciplinePlanVersionListItem {
  readonly versionId: string;
  readonly planId: string;
  readonly sequence: number;
  readonly status: string;
  readonly kind: string;
  readonly idgMeetingId: string | null;
  readonly finalizedAt: string | null;
  readonly signedAt: string | null;
  readonly supersededAt: string | null;
  readonly version: number;
}

/** One collected signature on a version (route 5). */
export interface DisciplineSignatureView {
  readonly signatureId: string;
  readonly signerMembershipId: string;
  readonly signerRole: string;
  readonly isAcknowledgment: boolean;
  readonly signedAt: string;
}

/** Route 5 — one version with its sealed snapshot + quorum + collected signatures. */
export interface DisciplinePlanVersionDetail extends DisciplinePlanVersionListItem {
  readonly stateSnapshot: unknown;
  readonly requiredSignerSet: unknown;
  readonly signatures: readonly DisciplineSignatureView[];
}

/** Route 2 — the full plan the clinical surface renders. */
export interface DisciplinePlanDetail extends DisciplinePlanListItem {
  readonly aideMembershipId: string | null;
  readonly supervisingRnMembershipId: string | null;
  readonly supervisoryCadenceDaysOverride: number | null;
  readonly spiritualCareDeclined: string | null;
  readonly goals: readonly DisciplineGoalView[];
  readonly interventions: readonly DisciplineInterventionView[];
  readonly assessments: readonly DisciplineAssessmentView[];
  readonly supervisoryVisits: readonly AideSupervisoryVisitView[];
  readonly volunteerAssignments: readonly VolunteerAssignmentView[];
  readonly versions: readonly DisciplinePlanVersionListItem[];
  /** The §7.1 ladder as of now (null before the Aide POC clock arms / on a non-aide plan). */
  readonly supervisoryCadence: {
    readonly nextDueAt: string;
    readonly cadenceDays: number;
    readonly status: string;
    readonly hoursOverdue: number;
  } | null;
  /** §7.8 / §7.9 — the confidentiality categories withheld from this body for this caller. */
  readonly redacted_categories: readonly RedactedCategory[];
}

/** Route 3 — the patient-shareable summary. Both confidential categories are ALWAYS stripped (§7.9). */
export interface DisciplinePlanSummary {
  readonly planId: string;
  readonly kind: string;
  readonly status: string;
  readonly goals: readonly {
    readonly goalId: string;
    readonly text: string;
    readonly status: string;
    readonly targetAt: string | null;
  }[];
  readonly interventions: readonly {
    readonly interventionId: string;
    readonly scopeText: string;
    readonly frequencyText: string;
    readonly status: string;
  }[];
  /** §7.3 — the declination is acknowledged, never quoted, on a patient-facing surface. */
  readonly spiritualCareDeclined: boolean;
  readonly redacted_categories: readonly RedactedCategory[];
}

/** Route 19 — a `volunteer_compliance_gate` row, with its status re-derived over the validity window. */
export interface VolunteerComplianceGateView {
  readonly gateId: string;
  readonly volunteerMembershipId: string;
  readonly gateKind: string;
  /** The materialized column (what the last watcher run wrote). */
  readonly storedStatus: string;
  /** The status the validity window actually implies as of now (§2.2.6) — this is what the UI shows. */
  readonly effectiveStatus: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly revokedAt: string | null;
  readonly sourceDocumentId: string | null;
  readonly version: number;
}

/** Route 27 — the seam-shaped effective status M17's pre-schedule gate reads. */
export interface VolunteerEffectiveStatusView {
  readonly volunteerMembershipId: string;
  readonly isActive: boolean;
  readonly failingGates: readonly { readonly gateKind: string; readonly reason: string }[];
}

/** Route 25 — the discipline elements M8 / M14 / M22 pull for a patient's plans. */
export interface RelevantElementsView {
  readonly planId: string;
  readonly kind: string;
  readonly status: string;
  readonly goals: readonly DisciplineGoalView[];
  readonly interventions: readonly DisciplineInterventionView[];
}

/** Route 28 — the supervisory worklist row (the §7.1 ladder resolved per plan). */
export interface SupervisoryCadenceRowView {
  readonly planId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly aideMembershipId: string | null;
  readonly supervisingRnMembershipId: string | null;
  readonly nextDueAt: string;
  readonly cadenceDays: number;
  readonly status: string;
  readonly hoursOverdue: number;
  readonly gateEngaged: boolean;
}

/** §4.1 route 1 filters. */
export interface PlanListQuery {
  readonly patientId?: string;
  readonly admissionId?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** §4.1 route 19 filters. */
export interface GateListQuery {
  readonly volunteerMembershipId?: string;
  readonly gateKind?: string;
  readonly expiringWithinDays?: number;
  readonly cursor?: string;
  readonly limit?: number;
}

/** §4.1 route 23 — the 418.78(e) ratio read. */
export interface HourRatioQuery {
  readonly providerEntityId: string;
  readonly fiscalYear: number;
}

/** A keyset-paginated query over the internal seam surfaces (routes 25/26/28). */
export interface InternalListQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

/** The §4.1 GET surface. Implemented over Drizzle in prod (RLS-scoped per `withOrgContext`). */
export interface M15ReadService {
  /** 1 — cursor-paginated plan worklist (`updatedAt DESC, id`). */
  listPlans(actor: M15ReadActor, query: PlanListQuery): Promise<CursorPage<DisciplinePlanListItem>>;
  /** 2 — the full plan, SQL-filtered by the §7.8/§7.9 gates. Null = absent, cross-tenant, or off-caseload. */
  getPlan(actor: M15ReadActor, planId: string): Promise<DisciplinePlanDetail | null>;
  /** 3 — the patient-shareable summary (both confidential categories always stripped). */
  getPlanSummary(actor: M15ReadActor, planId: string): Promise<DisciplinePlanSummary | null>;
  /** 4 — cursor-paginated version chain (`sequence ASC, id`). */
  listVersions(
    actor: M15ReadActor,
    planId: string,
    query: InternalListQuery,
  ): Promise<CursorPage<DisciplinePlanVersionListItem> | null>;
  /** 5 — one version with its sealed snapshot + collected signatures. */
  getVersion(
    actor: M15ReadActor,
    planId: string,
    versionId: string,
  ): Promise<DisciplinePlanVersionDetail | null>;
  /** 19 — cursor-paginated compliance gates (`validUntil ASC, id`). */
  listVolunteerGates(
    actor: M15ReadActor,
    query: GateListQuery,
  ): Promise<CursorPage<VolunteerComplianceGateView>>;
  /** 23 — the 418.78(e) ratio (`unavailable` while the M27 hours denominator is unbound, M15-F04). */
  getVolunteerHourRatio(actor: M15ReadActor, query: HourRatioQuery): Promise<unknown>;
  /** 25 — the discipline elements for a patient's plans (system principals). */
  listRelevantElements(
    actor: M15ReadActor,
    input: { patientId?: string; planId?: string } & InternalListQuery,
  ): Promise<CursorPage<RelevantElementsView>>;
  /** 26 — the MSW psychosocial risk factors for an admission (system principals; M16). */
  listMswRiskFactors(
    actor: M15ReadActor,
    input: { admissionId: string } & InternalListQuery,
  ): Promise<CursorPage<unknown>>;
  /** 27 — the volunteer's effective 418.78 status (system principals; M17). */
  getVolunteerEffectiveStatus(
    actor: M15ReadActor,
    volunteerMembershipId: string,
  ): Promise<VolunteerEffectiveStatusView>;
  /** 28 — the supervisory cadence worklist for a scope (system principals; M17/M14). */
  listSupervisoryCadence(
    actor: M15ReadActor,
    input: {
      providerEntityId?: string;
      locationId?: string;
      overdueOnly?: boolean;
    } & InternalListQuery,
  ): Promise<CursorPage<SupervisoryCadenceRowView>>;
}
