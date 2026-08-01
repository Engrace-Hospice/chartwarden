// apps/backend/src/modules/19-oncall/routes/read-service.ts — M19-T07, the §4.1 READ port + its DTOs.
//
// The Drizzle implementation is ./read-service-drizzle.ts. Every method takes the server-assembled
// {@link M19ReadActor} (never an org id off the wire) and opens its own `withOrgContext`, so RLS scopes
// each statement to `app.org_id`.
//
// THREE PROJECTION RULES THAT ARE THE POINT OF THIS FILE, not implementation detail:
//
//   1. THE VENDOR PROJECTION IS A DIFFERENT TYPE, NOT A FILTERED ONE. §8.3.1 requires the PHI-minimization
//      projection to be un-bypassable "by route-level code". A vendor operator reading a call gets
//      {@link VendorTriageCallView}, which HAS NO FIELD for the caller's phone, the caller quote, the
//      transcript or the free-text chief complaint — so no later edit to a handler can widen it, because
//      there is nowhere to widen it into. The same argument M22 made for `PortalTriageSummary`.
//   2. THE TRANSCRIPT IS ITS OWN METHOD AND ITS OWN DTO. §4.1 row 14 gives it a distinct permission,
//      step-up and a per-access M4 audit row. Folding the plaintext into {@link TriageCallDetail} behind a
//      nullable field would mean every detail read had to be trusted not to have populated it.
//   3. `redactedCategories` TRAVELS WITH THE ROW. When the 42 CFR Part 2 gate withholds SUD medications
//      (M19-T05's `redactSudMedications`), the count and the category ride the response. A clinician who
//      does not know the list is incomplete reads "no opioid on file" as a clinical fact — which is the
//      one failure mode redaction-without-notice creates that no-redaction does not.
import type {
  IsoInstant,
  OnCallActor,
  OncallModel,
  OncallShiftDiscipline,
  OncallShiftStatus,
  PortalTriageSummary,
  TriageAiConfidence,
  TriageCallCallerKind,
  TriageCallInboundChannel,
  TriageCallSource,
  TriageCallState,
  TriageDisposition,
  TriageDispositionData,
  TriageEscalationState,
  TriageEscalationTier,
  TriageEscalationTrigger,
  TriageProtocolAnswerType,
  TriageRedFlagMatch,
  TriageRiskBand,
} from "@wardenx/types";
import type { TriageMedicationContext } from "../clinical/medication-context";
import type { SelectableDisposition } from "../lifecycle/disposition";
import type { M19ReadActor } from "./actor";
import type { CursorPage } from "./concurrency";

/** A confidentiality category an M19 read may withhold (§8.2 / §7.13's M16 precedent). */
export type TriageRedactedCategory = "sud" | "ai_advisory" | "caller_free_text";

/** §4.1 row 2 — one row of the supervisor board / caseload list. */
export interface TriageCallListItem {
  readonly id: string;
  readonly providerEntityId: string;
  readonly patientId: string | null;
  readonly state: TriageCallState;
  readonly disposition: TriageDisposition | null;
  readonly callerKind: TriageCallCallerKind;
  readonly inboundChannel: TriageCallInboundChannel;
  readonly source: TriageCallSource;
  readonly chiefComplaintSnomed: string | null;
  readonly openedAt: IsoInstant;
  readonly firstResponseAt: IsoInstant | null;
  readonly closedAt: IsoInstant | null;
  /** The catalog label of the pinned protocol — never the caller's words. */
  readonly protocolLabel: string | null;
  /** Non-zero means somebody must look: §5's board sorts on it. */
  readonly openEscalationCount: number;
  readonly redFlagAnswerCount: number;
  readonly version: number;
}

/** One answer on a call, as the §5 stepper renders it (§2.2.3 amend-by-append: corrections are rows). */
export interface TriageAnswerView {
  readonly id: string;
  readonly questionId: string;
  readonly questionOrder: number;
  readonly prompt: string;
  readonly answerType: TriageProtocolAnswerType;
  readonly valueText: string | null;
  readonly valueInt: number | null;
  readonly valueBool: boolean | null;
  /** D5 — the SERVER's evaluation. Deliberately outside the §3.6 denylist: it is the tamper-evidence a
   *  suppression investigation reads. */
  readonly redFlagHit: boolean;
  readonly correctionOfAnswerId: string | null;
  readonly answeredAt: IsoInstant;
  readonly answeredByMembershipId: string;
}

/** One escalation on a call. */
export interface TriageEscalationView {
  readonly id: string;
  readonly tier: TriageEscalationTier;
  readonly triggerKind: TriageEscalationTrigger;
  readonly state: TriageEscalationState;
  /** D7 — a `mandatory_protocol` row may not be auto-resolved by a call close (§2.2.4). */
  readonly mandatory: boolean;
  readonly escalatedToMembershipId: string | null;
  readonly escalatedToExternalActorId: string | null;
  readonly escalatedAt: IsoInstant;
  readonly acknowledgedAt: IsoInstant | null;
  readonly resolvedAt: IsoInstant | null;
  readonly resolvedByMembershipId: string | null;
}

/** One `triage_call_state_history` row — the call's own ordered narrative (§2.7's outage-gap scan). */
export interface TriageStateHistoryView {
  readonly id: string;
  readonly fromState: TriageCallState | null;
  readonly toState: TriageCallState;
  readonly transitionedAt: IsoInstant;
  readonly actorMembershipId: string | null;
  readonly systemActor: boolean;
}

/** §4.1 row 3 — the full staff projection of one call. */
export interface TriageCallDetail extends TriageCallListItem {
  readonly locationId: string | null;
  readonly admissionId: string | null;
  readonly callerDisplayName: string | null;
  /** §3.6-denylisted; present for the staff projection, absent from {@link VendorTriageCallView}. */
  readonly callerPhoneE164: string | null;
  readonly callerRelationshipLabel: string | null;
  readonly callerCaregiverId: string | null;
  readonly chiefComplaintText: string | null;
  readonly onCallShiftId: string;
  readonly selectedProtocolId: string | null;
  readonly selectedProtocolVersion: string | null;
  /** D12 — ADVISORY. Recorded and displayed; gates nothing. */
  readonly suggestedProtocolId: string | null;
  readonly suggestedProtocolConfidence: TriageAiConfidence | null;
  /** D11 — ADVISORY. Excluded from the portal projection by construction. */
  readonly hospitalizationRiskBand: TriageRiskBand | null;
  readonly dispositionData: TriageDispositionData | null;
  readonly linkedEncounterId: string | null;
  readonly linkedVerbalOrderIds: readonly string[];
  readonly linkedVisitProposalId: string | null;
  readonly paperOriginFlag: boolean;
  readonly paperOriginalOpenedAt: IsoInstant | null;
  readonly documentedAt: IsoInstant | null;
  readonly answers: readonly TriageAnswerView[];
  readonly escalations: readonly TriageEscalationView[];
  readonly stateHistory: readonly TriageStateHistoryView[];
  /** §7.1 — the server's own cursor. The client renders from it and cannot move it (D5). */
  readonly nextQuestionId: string | null;
  /** §7.3 / D6 — what THIS actor's selector may offer. Server and UI refuse the same set. */
  readonly permittedDispositions: readonly SelectableDisposition[];
  /** D15 — the M12 medication/refill context the panel shows, with its own per-slice availability. */
  readonly medicationContext: TriageMedicationContext | null;
  /** §8.2 — categories this caller is NOT cleared for on this call (rule 3). */
  readonly redactedCategories: readonly TriageRedactedCategory[];
  /** True when a mandatory escalation is unacknowledged — the §7.2 disposition block, rendered. */
  readonly dispositionBlockedByMandatoryEscalation: boolean;
}

/**
 * §7.5 / D13 — the PHI-minimized projection an external triage vendor operator reads (rule 1).
 *
 * Structurally incapable of carrying the caller's phone, the caller quote, the transcript, the free-text
 * chief complaint, the caregiver identity or the AI advisories. The patient anchor is present because a
 * vendor operator must be able to work the call; what they get ABOUT the patient comes from
 * `@wardenx/triage-vendors`' `minimizeForVendor`, and this DTO carries only the triage-call facts.
 */
export interface VendorTriageCallView {
  readonly id: string;
  readonly providerEntityId: string;
  readonly state: TriageCallState;
  readonly callerKind: TriageCallCallerKind;
  readonly inboundChannel: TriageCallInboundChannel;
  readonly chiefComplaintSnomed: string | null;
  readonly openedAt: IsoInstant;
  readonly onCallShiftId: string;
  readonly selectedProtocolId: string | null;
  readonly selectedProtocolVersion: string | null;
  readonly answers: readonly TriageAnswerView[];
  readonly escalations: readonly TriageEscalationView[];
  readonly nextQuestionId: string | null;
  readonly permittedDispositions: readonly SelectableDisposition[];
  readonly version: number;
}

/** §4.1 row 14 — the step-up, per-access-audited transcript read (rule 2). */
export interface TriageTranscriptView {
  readonly triageCallId: string;
  /** Decrypted under the per-tenant DEK envelope (D14). `null` when the call carries no transcript. */
  readonly transcript: string | null;
  readonly callerQuote: string | null;
  readonly decryptedAt: IsoInstant;
}

/** §4.1 row 16 — one row of the escalation inbox. */
export interface EscalationInboxItem extends TriageEscalationView {
  readonly triageCallId: string;
  readonly providerEntityId: string;
  readonly patientId: string | null;
  readonly callState: TriageCallState;
  /** Minutes the row has been open — what the §4.8 escalation-SLA worker and the §5 inbox sort on. */
  readonly minutesOpen: number;
  readonly version: number;
}

/** §4.1 rows 19-23 — one `on_call_shift` row. */
export interface OnCallShiftView {
  readonly id: string;
  readonly providerEntityId: string;
  readonly shiftStartsAt: IsoInstant;
  readonly shiftEndsAt: IsoInstant;
  readonly discipline: OncallShiftDiscipline;
  readonly status: OncallShiftStatus;
  readonly primaryOnCallMembershipId: string | null;
  readonly backupMembershipId: string | null;
  readonly externalActorId: string | null;
  readonly externalActorLabel: string | null;
  readonly openedAt: IsoInstant | null;
  readonly closedAt: IsoInstant | null;
  readonly m17VisitAssignmentRef: string | null;
  readonly cancellationReason: string | null;
  readonly version: number;
}

/**
 * §4.1 row 24 — who is on call NOW, per ProviderEntity.
 *
 * `actors: []` for a ProviderEntity is a REAL ANSWER meaning "nobody is covering" (the M19-T06 finding),
 * which is why the response is keyed per PE rather than flattened: a union across PEs lets one covered
 * entity mask another's dark night, and CoP 418.100(c)(2) is per-CCN.
 */
export interface CurrentOnCallView {
  readonly asOf: IsoInstant;
  readonly perProviderEntity: readonly {
    readonly providerEntityId: string;
    readonly actors: readonly OnCallActor[];
    /** True when no `clinical_rn` actor covers `asOf` — the CoP coverage floor, per PE. */
    readonly rnCoverageGap: boolean;
  }[];
}

/** §4.1 rows 25-26 — the tenant policy row. */
export interface OncallPolicyView {
  readonly id: string;
  readonly providerEntityId: string;
  readonly model: OncallModel;
  readonly escalationTiers: unknown;
  readonly callbackSlaPerSeverity: unknown;
  readonly stateOverrides: unknown;
  readonly externalTriageVendorId: string | null;
  readonly emergencyContactE164: string | null;
  readonly aiProtocolSuggestionEnabled: boolean;
  readonly aiHospitalizationRiskEnabled: boolean;
  readonly version: number;
}

/** §4.1 rows 27-32 — one catalog question. */
export interface TriageProtocolQuestionView {
  readonly id: string;
  readonly questionOrder: number;
  readonly prompt: string;
  readonly answerType: TriageProtocolAnswerType;
  readonly answerEnumValues: readonly string[] | null;
  readonly required: boolean;
  readonly isRedFlagQuestion: boolean;
  readonly redFlagMatch: TriageRedFlagMatch | null;
  readonly isSystemLocked: boolean;
}

/** §4.1 rows 27-32 — one protocol. `organizationId === null` is the platform floor every tenant reads. */
export interface TriageProtocolView {
  readonly id: string;
  readonly organizationId: string | null;
  readonly key: string;
  readonly chiefComplaintLabel: string;
  readonly snomedCode: string;
  readonly disciplineRequired: string;
  readonly isSystemLocked: boolean;
  readonly requiresMandatoryEscalation: boolean;
  readonly mandatoryEscalationTier: TriageEscalationTier | null;
  readonly version: string;
  readonly effectiveFrom: IsoInstant;
  readonly effectiveTo: IsoInstant | null;
  readonly sortOrder: number;
  readonly questions: readonly TriageProtocolQuestionView[];
}

/** §4.1 rows 33-35 — one vendor binding. NO secret is ever projected (ADR-0026: none is stored). */
export interface VendorBindingView {
  readonly id: string;
  readonly mdmVendorId: string;
  readonly name: string;
  readonly adapterKey: string;
  readonly rnCoverageAttested: boolean;
  readonly baaInEffect: boolean;
  readonly baaExpiresOn: string | null;
  readonly minimizationProfile: string;
  /** §8.5 — is an adapter for this key actually registered right now? A binding whose adapter is not
   *  loaded cannot carry calls, and the admin screen must be able to say so before 2 a.m. */
  readonly adapterRegistered: boolean;
}

/** §2.7 — one outstanding paper-re-entry worklist row (the DON's BCP list). */
export interface PaperReentryWorklistView {
  readonly id: string;
  readonly providerEntityId: string;
  readonly outageWindowId: string;
  readonly shiftId: string | null;
  readonly shiftStartsAt: IsoInstant;
  readonly shiftEndsAt: IsoInstant;
  readonly assignedToMembershipId: string | null;
  readonly reenteredAt: IsoInstant | null;
  readonly linkedTriageCallId: string | null;
  readonly expiresAt: IsoInstant;
}

/** Filters the read service accepts, already validated by the route's TypeBox. */
export interface TriageCallFilters {
  readonly cursor?: string;
  readonly limit?: number;
  readonly state?: TriageCallState;
  readonly openOnly?: boolean;
  readonly providerEntityId?: string;
  readonly patientId?: string;
  readonly openedFrom?: string;
  readonly openedTo?: string;
}

export interface EscalationFilters {
  readonly cursor?: string;
  readonly limit?: number;
  readonly tier?: TriageEscalationTier;
  readonly openOnly?: boolean;
  readonly triageCallId?: string;
}

export interface ShiftFilters {
  readonly cursor?: string;
  readonly limit?: number;
  readonly providerEntityId?: string;
  readonly discipline?: OncallShiftDiscipline;
  readonly from?: string;
  readonly to?: string;
}

export interface ProtocolFilters {
  readonly cursor?: string;
  readonly limit?: number;
  readonly effectiveOnly?: boolean;
  readonly disciplineRequired?: string;
  readonly search?: string;
}

export interface PortalRecentFilters {
  readonly cursor?: string;
  readonly limit?: number;
  readonly sinceDays?: number;
}

/** The §4.1 READ surface. */
export interface M19ReadService {
  // §4.1 rows 2-3, 14 — triage calls
  listTriageCalls(
    actor: M19ReadActor,
    filters: TriageCallFilters,
  ): Promise<CursorPage<TriageCallListItem>>;
  /**
   * §4.1 row 3. Returns the STAFF projection or the VENDOR one depending on the actor's session class
   * (rule 1) — one method, two return types, so a caller cannot request the wide shape.
   */
  getTriageCall(
    actor: M19ReadActor,
    triageCallId: string,
  ): Promise<TriageCallDetail | VendorTriageCallView>;
  /** §4.1 row 14 — step-up + per-access audit; the plaintext never rides the detail DTO (rule 2). */
  getTranscript(actor: M19ReadActor, triageCallId: string): Promise<TriageTranscriptView>;

  // §4.1 row 16 — escalations
  listEscalations(
    actor: M19ReadActor,
    filters: EscalationFilters,
  ): Promise<CursorPage<EscalationInboxItem>>;

  // §4.1 rows 19, 24 — shifts
  listShifts(actor: M19ReadActor, filters: ShiftFilters): Promise<CursorPage<OnCallShiftView>>;
  getCurrentOnCall(
    actor: M19ReadActor,
    input: { readonly providerEntityId?: string; readonly asOf?: string },
  ): Promise<CurrentOnCallView>;

  // §4.1 row 25 — policy
  getPolicy(actor: M19ReadActor, providerEntityId: string): Promise<OncallPolicyView>;

  // §4.1 rows 27-28 — protocols
  listProtocols(
    actor: M19ReadActor,
    filters: ProtocolFilters,
  ): Promise<CursorPage<TriageProtocolView>>;
  getProtocol(actor: M19ReadActor, protocolId: string): Promise<TriageProtocolView>;

  // §4.1 row 33 — vendor bindings
  listVendorBindings(actor: M19ReadActor): Promise<readonly VendorBindingView[]>;

  // §4.1 row 36 — the M31 portal projection (lay-language; D11/D13 scrubbed by construction)
  listPortalRecent(
    actor: M19ReadActor,
    patientId: string,
    filters: PortalRecentFilters,
  ): Promise<CursorPage<PortalTriageSummary>>;

  /** §2.7 — the DON's outstanding BCP re-entry worklist. */
  listPaperReentryWorklist(actor: M19ReadActor): Promise<readonly PaperReentryWorklistView[]>;
}
