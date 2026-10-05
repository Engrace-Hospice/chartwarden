// apps/backend/src/modules/15-discipline-care-plans/routes/write-service.ts — the M15 WRITE service
// interface (the §4.1 POST/PATCH surface) + the transactional-outbox port.
//
// Every command runs under `withOrgContext` (RLS), decides through the PURE §2.2/§2.3 machines in
// `../lifecycle` and `../volunteer` (no business rule lives in the SQL layer), stamps the SERVER-assembled
// acting membership, and emits its §2.4 `m15.*` event on the caller's own transaction through the injected
// {@link WriteOutboxPort} — the transactional outbox, so an event can never describe a write that rolled
// back. The M22 discipline-plan PDF is exactly that handshake: M15 emits `m15.plan.version_signed` with
// the sealed snapshot, M22 owns the render (D12 phase boundary).
//
// Optimistic concurrency is §2.5: every PATCH / state transition carries `expectedVersion` (the `If-Match`
// header) and a mismatch raises `STALE_VERSION` → 412 with the current row.
import type { M15ReadActor, M15WriteActor } from "./actor";
import type {
  AideSupervisoryVisitView,
  DisciplineAssessmentView,
  DisciplineGoalView,
  DisciplineInterventionView,
  DisciplinePlanVersionDetail,
  VolunteerAssignmentView,
  VolunteerComplianceGateView,
} from "./read-service";

/** A §2.4 `m15.*` transactional-outbox emission. PHI-free by construction (§8.1 payload scrubbing).
 *
 * F-103 — `organizationId` was ABSENT from this shape and from all six emit sites. `outbox_event`
 * has no default for the column, so every `m15.*` emission wrote NULL and the RLS WITH CHECK refused it
 * with 42501 — rolling back the whole mutation. Signing a plan version, amending a discipline assessment,
 * completing an aide supervisory visit and all three volunteer-assignment inactivations therefore 500 in
 * production. Nothing caught it because M15 has no live suite: every existing M15 test drives the write
 * service with a no-op outbox, which accepts anything. REQUIRED rather than optional on purpose — the
 * omission is exactly what the type should have made impossible. */
export interface OutboxEmission {
  /** The tenant the row belongs to. The publisher writes it; the column is nullable ONLY for genuinely
   *  platform-wide events, which no `m15.*` event is. */
  readonly organizationId: string;
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  /** Required, like `organizationId`: the `outbox_event` columns are NOT NULL and all six emit sites
   *  already supply both. Optional here made the port assignable to the real publisher only by method
   *  bivariance, which is precisely the check that let the missing `organizationId` through. */
  readonly aggregateKind: string;
  readonly aggregateId: string;
}

/**
 * The transactional-outbox port (the composition root binds the catalog-validating M1 publisher pinned to
 * callerModule `m15`); `publish` writes the `outbox_event` row on the CALLER'S tx (same unit of work).
 * The default is a no-op so the slice/tests run without a dispatcher.
 */
export interface WriteOutboxPort {
  publish(tx: unknown, emission: OutboxEmission): Promise<void>;
}

/** Route 6 — finalize a draft version (`draft → in_review`; seals the snapshot + D11 quorum). */
export interface FinalizeVersionInput {
  readonly expectedVersion: number | null;
  /** A tenant may TIGHTEN the D11 floor; a loosening set is refused by the pure resolver. */
  readonly requiredSignerSet?: unknown;
}

/** Route 7 — record one signature against the SEALED required-signer set. */
export interface SignVersionInput {
  readonly expectedVersion: number | null;
  readonly signerRole: string;
  /** Captured verbatim at sign time; audit-denylisted (§3.6). */
  readonly attestationText: string;
  /** True for the CoP 418.76 CHHA acknowledgment (§3.5 D11) — not a cosignature. */
  readonly isAcknowledgment?: boolean;
}

/** Route 8 — author a discipline goal under an IPOC problem (§2.1). */
export interface CreateGoalInput {
  readonly parentProblemId: string;
  readonly parentGoalId?: string | null;
  readonly source: string;
  readonly originalText: string;
  readonly measurableOutcome?: string | null;
  readonly targetAt?: string | null;
  readonly frequencyText?: string | null;
  readonly frequencyValue?: string | null;
  readonly modalityText?: string | null;
  readonly sudRelated?: boolean;
  /** Required with `source='agent_stated'` — the M39 consent naming the acting agent (§2.3). */
  readonly actingConsentId?: string | null;
  readonly addedByDiscipline: string;
}

/** Route 9 — edit a goal (status transition and/or the §2.3 revision fields). */
export interface UpdateGoalInput {
  readonly expectedVersion: number | null;
  readonly event?: {
    readonly type: string;
    readonly revisedText?: string;
    readonly reason?: string;
  };
  readonly measurableOutcome?: string | null;
  readonly targetAt?: string | null;
  readonly frequencyText?: string | null;
  readonly frequencyValue?: string | null;
  readonly modalityText?: string | null;
}

/** Route 10 — author a discipline intervention. */
export interface CreateInterventionInput {
  readonly parentInterventionId?: string | null;
  readonly goalRefs?: readonly string[];
  readonly scopeText: string;
  readonly frequencyText: string;
  readonly frequencyValue: string;
  readonly discipline: string;
  readonly responsibleRoles?: readonly string[];
  readonly addedByDiscipline: string;
}

/** Route 11 — edit an intervention (status transition and/or scope/frequency). */
export interface UpdateInterventionInput {
  readonly expectedVersion: number | null;
  readonly event?: { readonly type: string; readonly reason?: string };
  readonly scopeText?: string;
  readonly frequencyText?: string;
  readonly frequencyValue?: string;
  readonly responsibleRoles?: readonly string[];
}

/** Route 12 — capture a discipline assessment (draft). */
export interface CreateAssessmentInput {
  readonly kind: string;
  readonly capturedAt: string;
  readonly isInitial?: boolean;
  readonly sudFlag?: boolean;
  readonly familyViolenceFlag?: boolean;
  readonly sourceEncounterId?: string | null;
  readonly data: unknown;
}

/** Route 13 — sign a drafted assessment (step-up; closes the D10 initial clock when `is_initial`). */
export interface SignAssessmentInput {
  readonly expectedVersion: number | null;
}

/** Route 14 — append-only amendment of a signed assessment (M9 D9 correction-of-record). */
export interface AmendAssessmentInput {
  readonly expectedVersion: number | null;
  readonly amendmentReason: string;
  readonly data: unknown;
  readonly amendedFields?: readonly string[];
}

/** Route 15 — record a 418.76(h) supervisory attestation. */
export interface CreateSupervisoryVisitInput {
  readonly aideMembershipId: string;
  readonly supervisingRnMembershipId: string;
  readonly sourceEncounterId: string | null;
  readonly supervisoryAt: string;
  readonly attestationMode: string;
  readonly aidePerformanceSatisfactory: boolean;
  readonly correctiveActions: string | null;
  readonly supervisoryNarrative: string;
}

/** Route 16 — sign a supervisory attestation (step-up). */
export interface SignSupervisoryVisitInput {
  readonly expectedVersion: number | null;
}

/** Route 17 — create a volunteer assignment (the §7.4 gate check runs first). */
export interface CreateVolunteerAssignmentInput {
  readonly volunteerMembershipId: string;
  readonly activities: readonly string[];
  readonly startsAt: string;
  readonly endsAt?: string | null;
  /** §8.6 — the audited bypass of an unmet 418.78 gate; ≥40 chars or the write is refused. */
  readonly overrideReason?: string | null;
}

/** Route 18 — edit / inactivate / reactivate an assignment. */
export interface UpdateVolunteerAssignmentInput {
  readonly expectedVersion: number | null;
  readonly activities?: readonly string[];
  readonly endsAt?: string | null;
  readonly coordinatorAcknowledged?: boolean;
  readonly inactivate?: { readonly reason: string };
  /** §7.5 — a previously-inactivated assignment is reactivated MANUALLY, never automatically. */
  readonly reactivate?: boolean;
}

/** Route 20 — record a 418.78 compliance gate. */
export interface CreateVolunteerGateInput {
  readonly volunteerMembershipId: string;
  readonly gateKind: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly sourceDocumentId?: string | null;
  readonly notes?: string | null;
}

/** Route 21 — correct a recorded gate's window / evidence. */
export interface UpdateVolunteerGateInput {
  readonly expectedVersion: number | null;
  readonly validUntil?: string | null;
  readonly sourceDocumentId?: string | null;
  readonly notes?: string | null;
}

/** Route 22 — revoke a satisfied gate (a deliberate act; cascades the §7.5 inactivation). */
export interface RevokeVolunteerGateInput {
  readonly expectedVersion: number | null;
  readonly revokedReason: string;
}

/** Route 24 — a manual hour adjustment on the 418.78(e) ledger. */
export interface CreateHourEntryInput {
  readonly providerEntityId: string;
  readonly fiscalYear: number;
  readonly volunteerMembershipId: string;
  readonly durationMinutes: number;
  readonly occurredAt: string;
  readonly adjustmentReason: string;
}

/** The 418.78(e) ledger row an hour entry lands on. */
export interface VolunteerHourEntryView {
  readonly hourEntryId: string;
  readonly ledgerId: string;
  readonly volunteerMembershipId: string;
  readonly source: string;
  readonly durationMinutes: number;
  readonly occurredAt: string;
  readonly ledgerTotalMinutes: number;
}

/** The §4.1 POST/PATCH surface. Implemented over Drizzle in prod (RLS-scoped per `withOrgContext`). */
export interface M15WriteService {
  /**
   * GAP-046 — the patient a plan belongs to, for the route-layer `caseload_or_scope` gate; `null` when the
   * plan is absent / cross-tenant (the gate turns that into a 404, never an allow).
   */
  planPatientId(actor: M15ReadActor, planId: string): Promise<string | null>;
  finalizeVersion(
    actor: M15WriteActor,
    planId: string,
    versionId: string,
    input: FinalizeVersionInput,
  ): Promise<DisciplinePlanVersionDetail>;
  signVersion(
    actor: M15WriteActor,
    planId: string,
    versionId: string,
    input: SignVersionInput,
  ): Promise<DisciplinePlanVersionDetail>;
  createGoal(
    actor: M15WriteActor,
    planId: string,
    input: CreateGoalInput,
  ): Promise<DisciplineGoalView>;
  updateGoal(
    actor: M15WriteActor,
    planId: string,
    goalId: string,
    input: UpdateGoalInput,
  ): Promise<DisciplineGoalView>;
  createIntervention(
    actor: M15WriteActor,
    planId: string,
    input: CreateInterventionInput,
  ): Promise<DisciplineInterventionView>;
  updateIntervention(
    actor: M15WriteActor,
    planId: string,
    interventionId: string,
    input: UpdateInterventionInput,
  ): Promise<DisciplineInterventionView>;
  createAssessment(
    actor: M15WriteActor,
    planId: string,
    input: CreateAssessmentInput,
  ): Promise<DisciplineAssessmentView>;
  signAssessment(
    actor: M15WriteActor,
    planId: string,
    assessmentId: string,
    input: SignAssessmentInput,
  ): Promise<DisciplineAssessmentView>;
  amendAssessment(
    actor: M15WriteActor,
    planId: string,
    assessmentId: string,
    input: AmendAssessmentInput,
  ): Promise<DisciplineAssessmentView>;
  createSupervisoryVisit(
    actor: M15WriteActor,
    planId: string,
    input: CreateSupervisoryVisitInput,
  ): Promise<AideSupervisoryVisitView>;
  signSupervisoryVisit(
    actor: M15WriteActor,
    planId: string,
    visitId: string,
    input: SignSupervisoryVisitInput,
  ): Promise<AideSupervisoryVisitView>;
  createVolunteerAssignment(
    actor: M15WriteActor,
    planId: string,
    input: CreateVolunteerAssignmentInput,
  ): Promise<VolunteerAssignmentView>;
  updateVolunteerAssignment(
    actor: M15WriteActor,
    planId: string,
    assignmentId: string,
    input: UpdateVolunteerAssignmentInput,
  ): Promise<VolunteerAssignmentView>;
  createVolunteerGate(
    actor: M15WriteActor,
    input: CreateVolunteerGateInput,
  ): Promise<VolunteerComplianceGateView>;
  updateVolunteerGate(
    actor: M15WriteActor,
    gateId: string,
    input: UpdateVolunteerGateInput,
  ): Promise<VolunteerComplianceGateView>;
  revokeVolunteerGate(
    actor: M15WriteActor,
    gateId: string,
    input: RevokeVolunteerGateInput,
  ): Promise<VolunteerComplianceGateView>;
  createHourEntry(
    actor: M15WriteActor,
    input: CreateHourEntryInput,
  ): Promise<VolunteerHourEntryView>;
}
