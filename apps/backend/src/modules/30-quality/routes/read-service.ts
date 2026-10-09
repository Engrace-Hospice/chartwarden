// apps/backend/src/modules/30-quality/routes/read-service.ts — the M30ReadRouteService INTERFACE +
// its read DTO types (§4.1/§4.2 READ surface: quality measures, CAHPS reads, QAPI/SRA reads, the
// incident/mortality/infection lists + details, CoP citations, the risk register).
//
// Every GET route in §4.1 composes over this interface. Mirrors the M33 routes/read-service.ts contract
// EXACTLY (interface + DTO shapes; the Drizzle adapter lands in P2c and projects rows to the SAME
// shapes, reading inside ONE `withOrgContext(db, {organizationId, userId}, …)` transaction so Postgres
// RLS scopes to `app.org_id`; PHI reads also pass `requirePatientScope()` at the route guard). This
// file is INTERFACE-ONLY: no Fastify, no DB, no implementation — only the method contracts + DTO types
// the route plugins and the P2c read-service-drizzle bind to.
//
// DTO discipline: every view here is a deliberately-narrowed projection of the frozen schema row, never
// the raw `$inferSelect`. Audit-denylisted / cipher columns (`computation_snapshot` cipher fields,
// incident free-text `kind_data` ciphers, SRA finding detail) are NOT projected onto list views; the
// aggregate-only seams stay aggregate-only. The DTOs intentionally use string-union enums mirroring the
// @wardenx/quality contracts so the route layer never couples to a Drizzle import.
import type {
  CopStatus,
  IncidentKind,
  IncidentSeverity,
  IncidentState,
  MeasurePeriodKind,
  QapiProjectPhase,
  SraCycleStatus,
} from "@wardenx/quality";
import type { M30ReadActor } from "./actor";
import type { CursorPage } from "./concurrency";
import type { QualityPatientScope } from "./patient-scope";

// Re-export the actor so route plugins import the read contract + actor from one barrel.
export type { M30ReadActor };

// ── shared scalar shapes ──────────────────────────────────────────────────────────────────────────────

/** A measure-computation period — the kind plus an ISO-8601 `[start, end)` window (§4.2 MeasurePeriodT). */
export interface MeasurePeriodView {
  readonly kind: MeasurePeriodKind;
  /** ISO-8601 inclusive start. */
  readonly start: string;
  /** ISO-8601 exclusive end. */
  readonly end: string;
}

/** The four-band quality posture a measure value carries (§4.2 `bandColor`). */
export type MeasureBandColor = "green" | "yellow" | "red" | "insufficient_n";

// ── Quality Measures (R-01, R-02, R-03, R-05) ───────────────────────────────────────────────────────────

/** One emitted (non-superseded) measure value for one period — aggregate-only, no patient PHI (R-02). */
export interface MeasureValueView {
  readonly valueId: string;
  readonly organizationId: string;
  readonly measureId: string;
  readonly period: MeasurePeriodView;
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
  readonly thresholdMet: boolean | null;
  readonly bandColor: MeasureBandColor;
  /**
   * Why this measure could not be computed AT ALL, or null when the value is a real (or low-N) one.
   *
   * `insufficient_n` collapses two different facts into one band: "we counted and the population was under
   * the reportable floor" and "the input for this measure is not data a provider-side system holds"
   * (HCI 5/6/7, whose populations are the beneficiary's Medicare claims across every provider). Both show a
   * null rate, so without this the quality hub labels the second "Suppressed (low N)" — which is false, and
   * points a Director of Quality at a patient-volume problem that does not exist. Projected from the
   * persisted `computation_snapshot`, so the reason travels with the value a surveyor asks about.
   */
  readonly unavailableReason: string | null;
  readonly computedAt: string;
  readonly computeVersion: string;
  readonly snapshotContentHash: string;
  readonly supersededByValueId: string | null;
}

/** A measure in the org's catalog with its latest value (R-01 list row). */
export interface MeasureSummaryView {
  readonly measureId: string;
  readonly displayName: string;
  readonly domain: "hci" | "ssvi" | "hvldl" | "hope" | "cahps" | "operational";
  readonly latestValue: MeasureValueView | null;
  /** Fiscal year the platform currently computes this measure for. */
  readonly fiscalYear: number;
}

/** The rolling-12-month series + history for one measure (R-02). */
export interface MeasureValueSeriesView {
  readonly measureId: string;
  readonly displayName: string;
  readonly values: readonly MeasureValueView[];
}

/** The reproducibility snapshot behind one emitted value (R-03; D1 invariant). */
export interface MeasureValueSnapshotView {
  readonly valueId: string;
  readonly measureId: string;
  readonly computeVersion: string;
  readonly snapshotContentHash: string;
  readonly computedAt: string;
  /** The hashed-over seam-input state (calculator-version-specific; aggregate-only). */
  readonly inputs: {
    readonly populationSourceTables: readonly string[];
    readonly populationFilter: string;
    readonly inputRowCounts: Readonly<Record<string, number>>;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly thresholdConstants: Readonly<Record<string, unknown>>;
  };
  readonly intermediates: Readonly<Record<string, unknown>> | null;
  readonly output: {
    readonly numerator: number;
    readonly denominator: number;
    readonly rate: number | null;
  };
}

/** A pending recompute job in the `m30.measure_recompute` queue (R-05). */
export interface RecomputeQueueEntryView {
  readonly jobId: string;
  readonly scope:
    | { readonly kind: "all" }
    | { readonly kind: "measure"; readonly measureId: string }
    | { readonly kind: "domain"; readonly domain: "hci" | "hvldl" | "hope" | "cahps" };
  readonly priority: "normal" | "high";
  readonly enqueuedAt: string;
  readonly state: "waiting" | "active" | "delayed" | "completed" | "failed";
}

// ── CAHPS (R-10, R-12, R-15, R-17) ──────────────────────────────────────────────────────────────────────

/** The active vendor binding for an org (R-10; immutable-history current row). */
export interface CahpsVendorBindingView {
  readonly bindingId: string;
  readonly organizationId: string;
  readonly vendorAdapterId: string;
  readonly vendorName: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly isActive: boolean;
}

/** A decedent in the current CAHPS sample window — PHI (R-12). */
export interface CahpsDecedentView {
  readonly sampleId: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly dateOfDeath: string;
  readonly samplePeriodStart: string;
  readonly samplePeriodEnd: string;
  readonly eligible: boolean;
  readonly exclusionReason: string | null;
}

/** A CAHPS export job + signed download URL once complete (R-15). */
export interface CahpsExportJobView {
  readonly exportId: string;
  readonly organizationId: string;
  readonly vendorAdapterId: string;
  readonly samplePeriodStart: string;
  readonly samplePeriodEnd: string;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly decedentCount: number;
  /** Present only when `status === "completed"`; short-lived signed URL minted by the M22 storage seam. */
  readonly downloadUrl: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly failureReason: string | null;
}

/** An aggregated CAHPS result summary by reporting period — aggregate-only (R-17). */
export interface CahpsResultSummaryView {
  readonly resultId: string;
  readonly organizationId: string;
  readonly measureId: string;
  readonly reportingPeriodStart: string;
  readonly reportingPeriodEnd: string;
  readonly topBoxPercent: number | null;
  /** True iff the cell was suppressed for falling below the min-cell threshold (PHI-safe). */
  readonly suppressedMinCell: boolean;
  readonly ingestedAt: string;
}

// ── QAPI (R-20, R-23, R-26, R-29, R-33) ─────────────────────────────────────────────────────────────────

/** A QAPI program (annual charter) — current + historical (R-20). */
export interface QapiProgramView {
  readonly programId: string;
  readonly organizationId: string;
  readonly planYear: number;
  readonly charterAdoptedAt: string;
  readonly governanceComposition: readonly {
    readonly role: string;
    readonly membershipId: string;
  }[];
  readonly status: "active" | "superseded";
}

/** A QAPI indicator with its threshold + current status (R-23; aggregate). */
export interface QapiIndicatorView {
  readonly indicatorId: string;
  readonly organizationId: string;
  readonly qapiProgramId: string;
  readonly displayName: string;
  readonly measureId: string | null;
  readonly thresholdDirection: "min" | "max";
  readonly thresholdValue: number;
  readonly currentRate: number | null;
  readonly currentBand: MeasureBandColor | null;
  readonly breached: boolean;
}

/** A QAPI / performance-improvement project (R-26; aggregate). */
export interface QapiProjectView {
  readonly projectId: string;
  readonly organizationId: string;
  readonly qapiProgramId: string;
  readonly title: string;
  readonly phase: QapiProjectPhase;
  readonly indicatorId: string | null;
  readonly ledByMembershipId: string | null;
  readonly charteredAt: string;
  readonly completedAt: string | null;
}

/** A PIP cycle under a project (R-29; aggregate). */
export interface QapiPipView {
  readonly pipId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly phase:
    | "chartering"
    | "root_cause_analysis"
    | "intervention_in_progress"
    | "measurement"
    | "concluded"
    | "suspended";
  readonly charterText: string;
  readonly charteredByMembershipId: string;
  readonly outcome: string | null;
  readonly closedAt: string | null;
  /** GAP-046 — a close was initiated and awaits the nominee's own confirmation. */
  readonly closePending?: boolean;
  readonly closeNomineeMembershipId?: string | null;
}

/** A QAPI governance-committee minutes entry (R-33; chronological). */
export interface QapiGovernanceMinutesView {
  readonly minutesId: string;
  readonly organizationId: string;
  readonly qapiProgramId: string;
  readonly meetingAt: string;
  readonly recordedByMembershipId: string;
  readonly summary: string;
  readonly attendees: readonly { readonly role: string; readonly membershipId: string }[];
}

// ── SRA (R-40, R-42) ────────────────────────────────────────────────────────────────────────────────────

/** An annual SRA cycle (R-40 list row). */
export interface SraCycleView {
  readonly cycleId: string;
  readonly organizationId: string;
  readonly cycleYear: number;
  readonly status: SraCycleStatus;
  readonly scopeTemplateVersion: string;
  readonly ownerMembershipId: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  /** GAP-046 — a close was initiated and awaits the nominee's own confirmation. */
  readonly closePending?: boolean;
  readonly closeNomineeMembershipId?: string | null;
}

/** A single SRA finding (NIST control reference; R-42 detail child). */
export interface SraFindingView {
  readonly findingId: string;
  readonly cycleId: string;
  readonly findingNumber: number;
  readonly controlRef: string;
  readonly likelihood: number;
  readonly impact: number;
  readonly riskScore: number;
  readonly riskBand: "critical" | "high" | "medium" | "low";
  readonly disposition: "open" | "accepted" | "remediating" | "remediated" | "transferred";
}

/** A remediation plan under a finding (R-42 detail child). */
export interface SraRemediationView {
  readonly remediationId: string;
  readonly findingId: string;
  readonly remediationNumber: number;
  readonly plan: string;
  readonly ownerMembershipId: string;
  readonly dueAt: string | null;
  readonly status: "planned" | "in_progress" | "completed" | "deferred";
  readonly completedAt: string | null;
}

/** SRA cycle detail — progress + findings + remediations (R-42). */
export interface SraCycleDetailView extends SraCycleView {
  readonly progress: {
    readonly findingsCount: number;
    readonly openFindingsCount: number;
    readonly remediationsCount: number;
  };
  readonly findings: readonly SraFindingView[];
  readonly remediations: readonly SraRemediationView[];
}

// ── Incidents (R-50, R-52, R-61) ────────────────────────────────────────────────────────────────────────

/** An incident-register list row — PHI when patient-linked (R-50 / R-61). */
export interface IncidentSummaryView {
  readonly incidentId: string;
  readonly organizationId: string;
  readonly kind: IncidentKind;
  readonly state: IncidentState;
  readonly severity: IncidentSeverity;
  readonly patientId: string | null;
  readonly occurredAt: string;
  readonly reportedAt: string;
  readonly reportedByMembershipId: string;
  readonly assignedToMembershipId: string | null;
}

/** A state-history entry on an incident (R-52 detail child). */
export interface IncidentStateHistoryView {
  readonly fromState: IncidentState | null;
  readonly toState: IncidentState;
  readonly actorMembershipId: string;
  readonly occurredAt: string;
}

/** An append-only investigation note (R-52 detail child; created by R-56). */
export interface IncidentInvestigationNoteView {
  readonly noteId: string;
  readonly incidentId: string;
  readonly authorMembershipId: string;
  readonly body: string;
  readonly createdAt: string;
}

/** The corrective-action plan attached during investigation (R-52 detail child). */
export interface IncidentCapPlanView {
  readonly rootCauseSummary: string;
  readonly actions: readonly {
    readonly action: string;
    readonly ownerMembershipId: string;
    readonly dueAt: string;
    readonly completedAt: string | null;
  }[];
  readonly verificationCriteria: string;
}

/** Incident detail — state history + investigation notes + CAP plan (R-52). PHI when patient-linked. */
export interface IncidentDetailView extends IncidentSummaryView {
  /** The kind-discriminated structured payload (validated against the per-kind §4.2 schema on write). */
  readonly data: Readonly<Record<string, unknown>>;
  readonly capPlan: IncidentCapPlanView | null;
  readonly capVerifiedByMembershipId: string | null;
  readonly capVerifiedAt: string | null;
  readonly closedByMembershipId: string | null;
  readonly closedAt: string | null;
  readonly stateHistory: readonly IncidentStateHistoryView[];
  readonly investigationNotes: readonly IncidentInvestigationNoteView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Mortality (R-70, R-71) ──────────────────────────────────────────────────────────────────────────────

/** A mortality-review list row — PHI (R-70). */
export interface MortalityReviewSummaryView {
  readonly reviewId: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly dateOfDeath: string;
  readonly assignedToMembershipId: string | null;
  readonly status: "created" | "in_progress" | "completed";
  readonly targetCompletionAt: string;
  readonly completedAt: string | null;
  /**
   * D19 — "First L." display name from M5's minimum-necessary display seam. PRESENT ONLY when the caller holds
   * `mortality.read_with_patient` (and M5 resolved the patient); absent otherwise — callers fall back to the id.
   */
  readonly patientDisplayName?: string;
  /** D19 — last four characters of the MRN (same gate as {@link patientDisplayName}); null when the MRN is blank. */
  readonly patientMrnSuffix?: string | null;
}

/** Mortality-review detail — the three review dimensions (R-71). PHI. */
export interface MortalityReviewDetailView extends MortalityReviewSummaryView {
  readonly dimensions: {
    readonly clinical: Readonly<Record<string, unknown>> | null;
    readonly satisfaction: Readonly<Record<string, unknown>> | null;
    readonly compliance: Readonly<Record<string, unknown>> | null;
  };
  readonly reviewerMembershipId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── CoP Compliance (R-80) ───────────────────────────────────────────────────────────────────────────────

/** A Condition-of-Participation citation row + current self-assessed status (R-80; one of 23). */
export interface CopCitationView {
  readonly citationId: string;
  readonly organizationId: string;
  readonly citationRef: string;
  readonly displayName: string;
  readonly status: CopStatus;
  readonly evidencePointers: readonly string[];
  readonly lastReviewedAt: string | null;
  readonly nextReviewDueAt: string | null;
}

// ── Infection (R-90, R-92) ──────────────────────────────────────────────────────────────────────────────

/** An infection-surveillance event — PHI (R-90). */
export interface InfectionEventView {
  readonly eventId: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly pathogen: string;
  readonly bodySite: string;
  readonly observedAt: string;
  readonly filedByMembershipId: string;
  readonly outbreakCaseId: string | null;
}

/** An outbreak case — aggregate-only (R-92). */
export interface InfectionOutbreakView {
  readonly caseId: string;
  readonly organizationId: string;
  readonly pathogen: string;
  readonly bodySite: string;
  readonly eventCount: number;
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly status: "open" | "notified" | "contained" | "resolved";
  readonly resolvedAt: string | null;
}

// ── Risk Register (R-95) ────────────────────────────────────────────────────────────────────────────────

/** A unified risk-register entry — aggregate-only, projected from the `risk_register_view` MV (R-95). */
export interface RiskRegisterEntryView {
  readonly entryId: string;
  readonly organizationId: string;
  readonly source: "incident" | "qapi" | "sra" | "infection" | "cop" | "measure";
  readonly sourceRef: string;
  readonly title: string;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly status: string;
  readonly openedAt: string;
  readonly lastActivityAt: string;
}

// ── filters ─────────────────────────────────────────────────────────────────────────────────────────────

export interface MeasureListFilter {
  readonly domain?: "hci" | "ssvi" | "hvldl" | "hope" | "cahps" | "operational";
}
export interface MeasureValuesFilter {
  readonly windowStart?: string;
  readonly windowEnd?: string;
}
export interface CahpsDecedentFilter {
  readonly samplePeriodStart?: string;
  readonly samplePeriodEnd?: string;
  readonly eligibleOnly?: boolean;
}
export interface CahpsResultFilter {
  readonly reportingPeriodStart?: string;
  readonly reportingPeriodEnd?: string;
  readonly measureId?: string;
}
export interface QapiProjectFilter {
  readonly phases?: readonly QapiProjectPhase[];
  readonly programId?: string;
}
export interface IncidentListFilter {
  readonly kinds?: readonly IncidentKind[];
  readonly states?: readonly IncidentState[];
  readonly severities?: readonly IncidentSeverity[];
  readonly occurredAfter?: string;
  readonly occurredBefore?: string;
  readonly patientId?: string;
  /**
   * Whether the caller may see `allegation_of_abuse` rows — i.e. holds `incident.abuse_review`.
   *
   * ABSENT OR FALSE MEANS HIDE THEM. The route resolves this from the actor's effective permissions and
   * passes it in; the read service never infers it. A per-incident ABAC predicate cannot gate a LIST (it
   * has no incident to key on), so the collection enforces the same rule the way a collection must — by
   * dropping the rows server-side, before they reach a page or a cursor.
   */
  readonly mayViewAbuseAllegations?: boolean;
}
export interface MortalityListFilter {
  readonly status?: "created" | "in_progress" | "completed";
  readonly patientId?: string;
}
export interface InfectionEventFilter {
  readonly pathogen?: string;
  readonly patientId?: string;
  readonly observedAfter?: string;
  readonly observedBefore?: string;
}
export interface InfectionOutbreakFilter {
  readonly status?: "open" | "notified" | "contained" | "resolved";
  readonly pathogen?: string;
}
export interface RiskRegisterFilter {
  readonly source?: "incident" | "qapi" | "sra" | "infection" | "cop" | "measure";
  readonly severity?: "critical" | "high" | "medium" | "low";
}

// ── the route service the GET handlers compose over ─────────────────────────────────────────────────────

/**
 * The M30 READ route-service contract: one method per §4.1 GET route (R-01, 02, 03, 05, 10, 12, 15, 17,
 * 20, 23, 26, 29, 33, 40, 42, 50, 52, 61, 70, 71, 80, 90, 92, 95). The P2c Drizzle adapter implements
 * this reading inside ONE `withOrgContext` transaction; a missing/RLS-hidden row is a non-leaking 404.
 * List methods take `(actor, [filter], cursor?, limit?)` and return a {@link CursorPage}; detail methods
 * take `(actor, …ids)`.
 */
export interface M30ReadRouteService {
  // Quality measures (R-01, R-02, R-03, R-05)
  listMeasures(
    actor: M30ReadActor,
    filter: MeasureListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<MeasureSummaryView>>;
  getMeasureValues(
    actor: M30ReadActor,
    measureId: string,
    filter: MeasureValuesFilter,
  ): Promise<MeasureValueSeriesView>;
  getMeasureValueSnapshot(
    actor: M30ReadActor,
    measureId: string,
    valueId: string,
  ): Promise<MeasureValueSnapshotView>;
  listRecomputeQueue(actor: M30ReadActor): Promise<readonly RecomputeQueueEntryView[]>;

  // CAHPS (R-10, R-12, R-15, R-17)
  getCahpsVendor(actor: M30ReadActor): Promise<CahpsVendorBindingView | null>;
  listCahpsDecedents(
    actor: M30ReadActor,
    filter: CahpsDecedentFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<CahpsDecedentView>>;
  getCahpsExport(actor: M30ReadActor, exportId: string): Promise<CahpsExportJobView>;
  listCahpsResults(
    actor: M30ReadActor,
    filter: CahpsResultFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<CahpsResultSummaryView>>;

  // QAPI (R-20, R-23, R-26, R-29, R-33)
  listQapiPrograms(
    actor: M30ReadActor,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<QapiProgramView>>;
  listQapiIndicators(
    actor: M30ReadActor,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<QapiIndicatorView>>;
  listQapiProjects(
    actor: M30ReadActor,
    filter: QapiProjectFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<QapiProjectView>>;
  listQapiPips(
    actor: M30ReadActor,
    projectId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<QapiPipView>>;
  listQapiGovernance(
    actor: M30ReadActor,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<QapiGovernanceMinutesView>>;

  // SRA (R-40, R-42)
  listSraCycles(
    actor: M30ReadActor,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<SraCycleView>>;
  getSraCycle(actor: M30ReadActor, cycleId: string): Promise<SraCycleDetailView>;

  // Incidents (R-50, R-52, R-61) — PHI
  listIncidents(
    actor: M30ReadActor,
    filter: IncidentListFilter,
    cursor: string | undefined,
    limit: number | undefined,
    scope: QualityPatientScope,
  ): Promise<CursorPage<IncidentSummaryView>>;
  getIncident(
    actor: M30ReadActor,
    incidentId: string,
    scope: QualityPatientScope,
  ): Promise<IncidentDetailView>;
  listAbuseAllegations(
    actor: M30ReadActor,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<IncidentSummaryView>>;

  // Mortality (R-70, R-71) — PHI
  listMortalityReviews(
    actor: M30ReadActor,
    filter: MortalityListFilter,
    cursor: string | undefined,
    limit: number | undefined,
    scope: QualityPatientScope,
  ): Promise<CursorPage<MortalityReviewSummaryView>>;
  getMortalityReview(
    actor: M30ReadActor,
    reviewId: string,
    scope: QualityPatientScope,
  ): Promise<MortalityReviewDetailView>;

  // CoP compliance (R-80)
  listCopCitations(
    actor: M30ReadActor,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<CopCitationView>>;

  // Infection (R-90, R-92)
  listInfectionEvents(
    actor: M30ReadActor,
    filter: InfectionEventFilter,
    cursor: string | undefined,
    limit: number | undefined,
    scope: QualityPatientScope,
  ): Promise<CursorPage<InfectionEventView>>;
  listInfectionOutbreaks(
    actor: M30ReadActor,
    filter: InfectionOutbreakFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<InfectionOutbreakView>>;

  // Risk register (R-95)
  listRiskRegister(
    actor: M30ReadActor,
    filter: RiskRegisterFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<RiskRegisterEntryView>>;
}
