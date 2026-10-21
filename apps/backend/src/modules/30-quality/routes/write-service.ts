// apps/backend/src/modules/30-quality/routes/write-service.ts — the M30WriteRouteService INTERFACE +
// its request Arg types, the injected ports (WriteOutboxPort, RecomputeEnqueuePort), and the PURE
// cross-route domain-rule helpers (§4.1 MUTATING surface: recompute, CAHPS admin, QAPI/SRA authoring +
// two-person closes, the incident lifecycle, mortality completion, CoP review, infection recording).
//
// Every POST/PATCH route in §4.1 composes over this interface. Mirrors the M33 routes/write-service.ts
// contract EXACTLY (interface + Arg/port types + pure asserts; no DB, no Fastify). The P2c Drizzle
// adapter implements it running each method inside ONE `withOrgContext(db, {organizationId, userId}, …)`
// transaction so Postgres RLS scopes to `app.org_id`, and emits the §4.10 `m30.*` events through the
// {@link WriteOutboxPort} in the SAME unit of work as the mutation (transactional outbox). Org/actor/owner
// binding is ALWAYS the server-assembled {@link M30WriteActor} (context, never body).
//
// LIFECYCLE: the service does NOT re-implement state logic. It supplies the upstream-resolved FACTS to
// the pure reducers already in @wardenx/quality (`transitionIncident`, the QAPI project/PIP machines,
// the SRA cycle machine, the mortality machine) and persists their result. The only pure rule helpers
// added HERE are the ones not already owned by the package — and even those DELEGATE to the package's
// canonical guard (the two-person co-sign split, V-11 / V-12).
import type { DbClient } from "@wardenx/db";
import {
  type PipClosureCosign,
  type SraClosureCosign,
  assertPipClosureCosign,
  assertSraClosureCosign,
} from "@wardenx/quality";
import type {
  CopStatus,
  IncidentKind,
  IncidentSeverity,
  MeasurePeriodKind,
  QapiProjectPhase,
  SraCycleStatus,
} from "@wardenx/quality";
import type { M30WriteActor } from "./actor";
import type {
  CahpsDecedentView,
  CahpsExportJobView,
  CahpsResultSummaryView,
  CahpsVendorBindingView,
  CopCitationView,
  IncidentDetailView,
  IncidentInvestigationNoteView,
  InfectionEventView,
  InfectionOutbreakView,
  MortalityReviewDetailView,
  QapiGovernanceMinutesView,
  QapiIndicatorView,
  QapiPipView,
  QapiProgramView,
  QapiProjectView,
  SraCycleView,
  SraFindingView,
  SraRemediationView,
} from "./read-service";

// Re-export the write actor + cosign types so route plugins import the write contract from one barrel.
export type { M30WriteActor, PipClosureCosign, SraClosureCosign };

// ── injected ports (deny-stub-safe; keep the route + service free of BullMQ/outbox imports) ───────────

/**
 * The structural org-context transaction handle the §4.10 outbox row is inserted through: the SAME
 * `withOrgContext` tx the mutation already opened (transactional outbox — the event row commits atomically
 * with the write). Pinned to `DbClient` to MIRROR the bootstrap `OutboxTx`
 * (apps/backend/src/bootstrap/outbox-persister.ts) the composition root binds; `WriteTx`
 * (write-service-drizzle.ts) is also `DbClient`, so the tx the service passes satisfies this exactly.
 */
export type WriteOutboxTx = DbClient;

/**
 * The transactional-outbox emit port. M30 is OUTBOX-ONLY across module boundaries (D6); the command
 * routes emit the §4.10 `m30.*` events through this port in the SAME unit of work as the mutation.
 *
 * Mirrors the bootstrap `OutboxPublishPort`'s `publish(tx, input)` shape (the M33/M34 precedent): the
 * caller hands its open `tx` plus the catalog-routing fields (`organizationId` — the non-null tenant uuid
 * the `outbox_event` row is keyed on, `aggregateKind`/`aggregateId` — the non-null aggregate uuid) and the
 * `payload`. `callerModule` is fixed to `m30` by the composition-root adapter that binds this to
 * `buildTxOutboxPublisher`, so callers pass only the fields below. A non-conformant payload THROWS in the
 * dispatcher and rolls the mutation's tx back. The port is optional + best-effort here (the runtime
 * dispatcher binds at boot); when unbound the mutation still lands (zero regression). Each `eventName`
 * carries the `m30.` prefix the event-catalog gate enforces.
 */
export interface WriteOutboxPort {
  publish(
    tx: WriteOutboxTx,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/**
 * The §4.8 BullMQ queues the M30 command routes that enqueue background work produce to:
 *   - `m30.measure_recompute` — R-04 recompute (selective by measure/domain or `all`); the worker writes
 *     append-only `quality_measure_value` rows visible at R-02/R-03 once complete.
 *   - `m30.risk_register_refresh` — R-96 forced `risk_register_view` materialized-view refresh.
 */
export type M30WriteQueueName =
  | "m30.measure_recompute"
  | "m30.risk_register_refresh"
  | "m30.cahps_export";

/**
 * The thin worker-trigger port the R-04 / R-96 routes enqueue to (typed-TODO producer; bound in P2c). In
 * the slice it records the enqueue (so route tests assert the job was scheduled); PRODUCTION binds it to
 * the @wardenx/shared transactional-outbox / BullMQ producer. Keeping it injected keeps the route layer
 * free of any BullMQ/Valkey import.
 */
export interface RecomputeEnqueuePort {
  enqueue(
    queue: M30WriteQueueName,
    jobKey: string,
    payload: Record<string, unknown>,
  ): Promise<{ jobId: string }>;
}

// ── command-acceptance DTOs (HTTP 202 producers) ──────────────────────────────────────────────────────

/** R-04 — the recompute job accepted onto `m30.measure_recompute` (202). */
export interface RecomputeJobAcceptedView {
  readonly jobId: string;
  readonly scope:
    | { readonly kind: "all" }
    | { readonly kind: "measure"; readonly measureId: string }
    | { readonly kind: "domain"; readonly domain: "hci" | "hvldl" | "hope" | "cahps" };
  readonly priority: "normal" | "high";
}

/** R-96 — the risk-register MV refresh accepted onto `m30.risk_register_refresh` (202). */
export interface RiskRegisterRefreshAcceptedView {
  readonly jobId: string;
  readonly enqueuedAt: string;
}

/** R-16 — the result of a vendor-results ingest (aggregate; measures touched). */
export interface CahpsIngestResultView {
  readonly resultIds: readonly string[];
  readonly measuresAffected: readonly string[];
  readonly suppressedMinCellCount: number;
}

// ── request Arg types (the route layer maps the parsed TypeBox body to these) ──────────────────────────

// Quality measures (R-04)
export interface EnqueueRecomputeArgs {
  readonly scope:
    | { readonly kind: "all" }
    | { readonly kind: "measure"; readonly measureId: string }
    | { readonly kind: "domain"; readonly domain: "hci" | "hvldl" | "hope" | "cahps" };
  readonly reason: string;
  readonly priority?: "normal" | "high";
}

// CAHPS (R-11, R-13, R-14, R-16)
export interface BindCahpsVendorArgs {
  readonly vendorAdapterId: string;
  readonly effectiveFrom: string;
  /** GAP-087 — vendor connection configuration (validated by the adapter, sealed under the tenant DEK). */
  readonly configuration?: Readonly<Record<string, unknown>>;
}
export interface ExcludeCahpsDecedentArgs {
  readonly exclusionReason: string;
}
export interface CreateCahpsExportArgs {
  readonly samplePeriodStart: string;
  readonly samplePeriodEnd: string;
}
export interface IngestCahpsResultsArgs {
  readonly vendorAdapterId: string;
  readonly reportingPeriodStart: string;
  readonly reportingPeriodEnd: string;
  /** The aggregated, min-cell-bearing result rows the adapter posts (validated + suppressed on ingest). */
  readonly results: readonly {
    readonly measureId: string;
    readonly topBoxPercent: number | null;
    readonly respondentCount: number;
  }[];
  /** SHA-256 over the payload — the §4.1.1 idempotency body-mismatch discriminator. */
  readonly payloadHash: string;
}

// QAPI (R-21, R-22, R-24, R-25, R-27, R-28, R-30, R-31, R-32)
export interface AdoptQapiProgramArgs {
  readonly planYear: number;
  readonly governanceComposition: readonly {
    readonly role: string;
    readonly membershipId: string;
  }[];
}
export interface UpdateQapiGovernanceArgs {
  readonly governanceComposition: readonly {
    readonly role: string;
    readonly membershipId: string;
  }[];
}
export interface CreateQapiIndicatorArgs {
  readonly qapiProgramId: string;
  readonly displayName: string;
  readonly measureId?: string;
  readonly thresholdDirection: "min" | "max";
  readonly thresholdValue: number;
  /** The seam/source data path the indicator binds to (§4.1.1 idempotency discriminator). */
  readonly dataPath: string;
}
export interface UpdateQapiIndicatorArgs {
  readonly thresholdValue?: number;
  readonly thresholdDirection?: "min" | "max";
  readonly displayName?: string;
}
export interface CharterQapiProjectArgs {
  readonly qapiProgramId: string;
  readonly title: string;
  readonly indicatorId?: string;
  readonly charterNarrative: string;
}
export interface UpdateQapiProjectArgs {
  readonly phase?: QapiProjectPhase;
  readonly interventions?: readonly string[];
  readonly ledByMembershipId?: string;
}
export interface AddQapiPipArgs {
  readonly charterText: string;
}
/** R-31 — close a PIP (two-person co-sign; V-11). The route stamps `charteredByMembershipId` server-side. */
export interface CloseQapiPipArgs {
  readonly conclusionText: string;
  readonly outcome: string;
  /** GAP-088 — the NOMINATED co-signer (body); recorded un-attested. The only signer is `actor.membershipId` (session). */
  readonly cosignerMembershipId: string;
  /** Real step-up freshness for `qapi.close`, derived from `request.context` by the route. */
  readonly recentStepUp: boolean;
}
export interface RecordQapiGovernanceArgs {
  readonly qapiProgramId: string;
  readonly meetingAt: string;
  readonly summary: string;
  readonly attendees: readonly { readonly role: string; readonly membershipId: string }[];
}

// SRA (R-41, R-43, R-44, R-45, R-46, R-47)
export interface OpenSraCycleArgs {
  readonly cycleYear: number;
}
export interface AddSraFindingArgs {
  readonly findingNumber: number;
  readonly controlRef: string;
  readonly likelihood: number;
  readonly impact: number;
  readonly description: string;
}
export interface UpdateSraFindingArgs {
  readonly likelihood?: number;
  readonly impact?: number;
  readonly disposition?: "open" | "accepted" | "remediating" | "remediated" | "transferred";
}
export interface PlanSraRemediationArgs {
  readonly remediationNumber: number;
  readonly plan: string;
  readonly ownerMembershipId: string;
  readonly dueAt?: string;
}
export interface UpdateSraRemediationArgs {
  readonly status?: "planned" | "in_progress" | "completed" | "deferred";
  readonly dueAt?: string;
}
/** R-47 — close an SRA cycle (two-person co-sign; V-12). The route enforces a recent step-up. */
/** GAP-046 — the nominee confirming a pending close. No identity rides the wire: the confirmer is the session. */
export interface ConfirmCloseArgs {
  /** Real step-up freshness for the close operation, derived from `request.context` by the route. */
  readonly recentStepUp: boolean;
}
export interface CloseSraCycleArgs {
  /** GAP-088 — the NOMINATED co-signer (body); recorded un-attested. The only signer is `actor.membershipId` (session). */
  readonly cosignerMembershipId: string;
  /** Real step-up freshness for `sra.close`, derived from `request.context` by the route. */
  readonly recentStepUp: boolean;
}

// Incidents (R-51, R-53, R-55, R-56, R-57, R-58, R-60)
export interface CreateIncidentArgs {
  readonly kind: IncidentKind;
  readonly severity: IncidentSeverity;
  readonly patientId?: string;
  readonly occurredAt: string;
  /** The kind-discriminated structured payload (validated against the per-kind §4.2 schema). */
  readonly data: Readonly<Record<string, unknown>>;
}
export interface UpdateIncidentArgs {
  readonly severity?: IncidentSeverity;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly occurredAt?: string;
}
export interface TriageIncidentArgs {
  readonly assignedToMembershipId: string;
  readonly severity: IncidentSeverity;
}
export interface AddInvestigationNoteArgs {
  readonly body: string;
}
/** R-57 — open the CAP / begin investigation (triaged → under_investigation). */
export interface OpenInvestigationArgs {
  readonly rootCauseSummary: string;
  readonly actions: readonly {
    readonly action: string;
    readonly ownerMembershipId: string;
    readonly dueAt: string;
  }[];
  readonly verificationCriteria: string;
}
/** R-58 — resolve (under_investigation → resolved). Resolver MUST NOT be the assignee (WF-12 / SoD). */
export interface ResolveIncidentArgs {
  readonly resolutionNote: string;
}
export interface ReopenIncidentArgs {
  readonly reopenReason: string;
}

// Mortality (R-72, R-73)
export interface UpdateMortalityReviewArgs {
  readonly dimensions?: {
    readonly clinical?: Readonly<Record<string, unknown>>;
    readonly satisfaction?: Readonly<Record<string, unknown>>;
    readonly compliance?: Readonly<Record<string, unknown>>;
  };
  readonly assignedToMembershipId?: string;
}
export interface CompleteMortalityReviewArgs {
  /** All three dimensions must be present + complete (the package completeness predicates gate this). */
  readonly dimensions: {
    readonly clinical: Readonly<Record<string, unknown>>;
    readonly satisfaction: Readonly<Record<string, unknown>>;
    readonly compliance: Readonly<Record<string, unknown>>;
  };
}

// CoP compliance (R-81, R-82)
export interface UpdateCopCitationArgs {
  readonly status?: CopStatus;
  readonly evidencePointers?: readonly string[];
}
export interface ReviewCopCitationArgs {
  readonly attestation: string;
}

// Infection (R-91, R-93)
export interface RecordInfectionEventArgs {
  readonly patientId: string;
  readonly pathogen: string;
  readonly bodySite: string;
  readonly observedAt: string;
}
export interface UpdateInfectionOutbreakArgs {
  readonly status: "open" | "notified" | "contained" | "resolved";
  readonly resolutionNote?: string;
}

// ── pure cross-route domain-rule helpers (DELEGATE to the @wardenx/quality canonical guards) ───────────

/**
 * V-11 (R-31) — assert the two-person PIP-closure co-sign split. Delegates to the package's canonical
 * {@link assertPipClosureCosign} (the SPLIT-ACTOR invariant: two distinct cosigners, neither the
 * charterer). The route resolves the role identities + the charterer server-side, then calls this before
 * invoking the PIP `conclude` reducer. Pure: no IO. Throws the package's `ChartWardenError` on a violation.
 */
export function assertPipCloseSplitActor(cosign: PipClosureCosign): void {
  assertPipClosureCosign(cosign);
}

/**
 * V-12 (R-47) — assert the two-person SRA-cycle-closure co-sign split. Delegates to the package's
 * canonical {@link assertSraClosureCosign} (Security Officer + Compliance Officer, distinct individuals).
 * The route resolves the role identities server-side, then calls this before invoking the SRA `close`
 * reducer. Pure: no IO. Throws the package's `ChartWardenError` on a violation.
 */
export function assertSraCloseSplitActor(cosign: SraClosureCosign): void {
  assertSraClosureCosign(cosign);
}

// ── the route service the mutating handlers compose over ────────────────────────────────────────────────

/**
 * The M30 WRITE route-service contract: one method per §4.1 mutating (POST/PATCH) route. The P2c Drizzle
 * adapter implements each method inside ONE `withOrgContext` transaction, drives the pure @wardenx/quality
 * reducers for any lifecycle transition, and emits the §4.10 `m30.*` events through the injected
 * {@link WriteOutboxPort} in the same unit of work. A missing/RLS-hidden row is a non-leaking 404; a
 * domain-rule violation surfaces the package's typed `ChartWardenError`.
 */
export interface M30WriteRouteService {
  // Quality measures (R-04)
  enqueueRecompute(
    actor: M30WriteActor,
    args: EnqueueRecomputeArgs,
  ): Promise<RecomputeJobAcceptedView>;

  // CAHPS (R-11, R-13, R-14, R-16)
  bindCahpsVendor(actor: M30WriteActor, args: BindCahpsVendorArgs): Promise<CahpsVendorBindingView>;
  excludeCahpsDecedent(
    actor: M30WriteActor,
    sampleId: string,
    args: ExcludeCahpsDecedentArgs,
  ): Promise<CahpsDecedentView>;
  createCahpsExport(actor: M30WriteActor, args: CreateCahpsExportArgs): Promise<CahpsExportJobView>;
  ingestCahpsResults(
    actor: M30WriteActor,
    args: IngestCahpsResultsArgs,
  ): Promise<CahpsIngestResultView>;

  // QAPI (R-21, R-22, R-24, R-25, R-27, R-28, R-30, R-31, R-32)
  adoptQapiProgram(actor: M30WriteActor, args: AdoptQapiProgramArgs): Promise<QapiProgramView>;
  updateQapiProgramGovernance(
    actor: M30WriteActor,
    programId: string,
    args: UpdateQapiGovernanceArgs,
  ): Promise<QapiProgramView>;
  createQapiIndicator(
    actor: M30WriteActor,
    args: CreateQapiIndicatorArgs,
  ): Promise<QapiIndicatorView>;
  updateQapiIndicator(
    actor: M30WriteActor,
    indicatorId: string,
    args: UpdateQapiIndicatorArgs,
  ): Promise<QapiIndicatorView>;
  charterQapiProject(actor: M30WriteActor, args: CharterQapiProjectArgs): Promise<QapiProjectView>;
  updateQapiProject(
    actor: M30WriteActor,
    projectId: string,
    args: UpdateQapiProjectArgs,
  ): Promise<QapiProjectView>;
  addQapiPip(actor: M30WriteActor, projectId: string, args: AddQapiPipArgs): Promise<QapiPipView>;
  closeQapiPip(actor: M30WriteActor, pipId: string, args: CloseQapiPipArgs): Promise<QapiPipView>;
  confirmQapiPipClose(
    actor: M30WriteActor,
    pipId: string,
    args: ConfirmCloseArgs,
  ): Promise<QapiPipView>;
  recordQapiGovernance(
    actor: M30WriteActor,
    args: RecordQapiGovernanceArgs,
  ): Promise<QapiGovernanceMinutesView>;

  // SRA (R-41, R-43, R-44, R-45, R-46, R-47)
  openSraCycle(actor: M30WriteActor, args: OpenSraCycleArgs): Promise<SraCycleView>;
  addSraFinding(
    actor: M30WriteActor,
    cycleId: string,
    args: AddSraFindingArgs,
  ): Promise<SraFindingView>;
  updateSraFinding(
    actor: M30WriteActor,
    findingId: string,
    args: UpdateSraFindingArgs,
  ): Promise<SraFindingView>;
  planSraRemediation(
    actor: M30WriteActor,
    findingId: string,
    args: PlanSraRemediationArgs,
  ): Promise<SraRemediationView>;
  updateSraRemediation(
    actor: M30WriteActor,
    remediationId: string,
    args: UpdateSraRemediationArgs,
  ): Promise<SraRemediationView>;
  confirmSraCycleClose(
    actor: M30WriteActor,
    cycleId: string,
    args: ConfirmCloseArgs,
  ): Promise<SraCycleView>;
  closeSraCycle(
    actor: M30WriteActor,
    cycleId: string,
    args: CloseSraCycleArgs,
  ): Promise<SraCycleView>;

  // Incidents (R-51, R-53, R-54, R-55, R-56, R-57, R-58, R-59, R-60)
  createIncident(actor: M30WriteActor, args: CreateIncidentArgs): Promise<IncidentDetailView>;
  updateIncident(
    actor: M30WriteActor,
    incidentId: string,
    args: UpdateIncidentArgs,
  ): Promise<IncidentDetailView>;
  submitIncident(actor: M30WriteActor, incidentId: string): Promise<IncidentDetailView>;
  triageIncident(
    actor: M30WriteActor,
    incidentId: string,
    args: TriageIncidentArgs,
  ): Promise<IncidentDetailView>;
  addIncidentInvestigationNote(
    actor: M30WriteActor,
    incidentId: string,
    args: AddInvestigationNoteArgs,
  ): Promise<IncidentInvestigationNoteView>;
  openIncidentInvestigation(
    actor: M30WriteActor,
    incidentId: string,
    args: OpenInvestigationArgs,
  ): Promise<IncidentDetailView>;
  resolveIncident(
    actor: M30WriteActor,
    incidentId: string,
    args: ResolveIncidentArgs,
  ): Promise<IncidentDetailView>;
  closeIncident(actor: M30WriteActor, incidentId: string): Promise<IncidentDetailView>;
  reopenIncident(
    actor: M30WriteActor,
    incidentId: string,
    args: ReopenIncidentArgs,
  ): Promise<IncidentDetailView>;

  // Mortality (R-72, R-73)
  updateMortalityReview(
    actor: M30WriteActor,
    reviewId: string,
    args: UpdateMortalityReviewArgs,
  ): Promise<MortalityReviewDetailView>;
  completeMortalityReview(
    actor: M30WriteActor,
    reviewId: string,
    args: CompleteMortalityReviewArgs,
  ): Promise<MortalityReviewDetailView>;

  // CoP compliance (R-81, R-82)
  updateCopCitation(
    actor: M30WriteActor,
    citationId: string,
    args: UpdateCopCitationArgs,
  ): Promise<CopCitationView>;
  reviewCopCitation(
    actor: M30WriteActor,
    citationId: string,
    args: ReviewCopCitationArgs,
  ): Promise<CopCitationView>;

  // Infection (R-91, R-93)
  recordInfectionEvent(
    actor: M30WriteActor,
    args: RecordInfectionEventArgs,
  ): Promise<InfectionEventView>;
  updateInfectionOutbreak(
    actor: M30WriteActor,
    caseId: string,
    args: UpdateInfectionOutbreakArgs,
  ): Promise<InfectionOutbreakView>;

  // Risk register (R-96)
  refreshRiskRegister(actor: M30WriteActor): Promise<RiskRegisterRefreshAcceptedView>;
}

// Re-export the read views the write methods echo back, so route plugins import from one barrel.
export type {
  CahpsDecedentView,
  CahpsExportJobView,
  CahpsResultSummaryView,
  CahpsVendorBindingView,
};
export type { MeasurePeriodKind, SraCycleStatus };
