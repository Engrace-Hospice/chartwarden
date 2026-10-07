// apps/backend/src/modules/30-quality/routes/write-service-drizzle.ts — the Drizzle-backed
// M30WriteRouteService (§4.1 MUTATING surface: recompute, CAHPS admin, QAPI/SRA authoring + two-person
// closes, the incident lifecycle, mortality completion, CoP review, infection recording, risk refresh).
//
// Implements the SAME {@link M30WriteRouteService} interface as the in-memory slice, but every method runs
// inside ONE `withOrgContext(db, {organizationId, userId}, …)` transaction on the PRIMARY so Postgres RLS
// scopes each statement to `app.org_id` (the M33 routes/write-service-drizzle precedent). Org/actor/owner
// binding is ALWAYS the server-assembled {@link M30WriteActor} (never the body). The lifecycle methods do
// NOT re-implement state logic — they supply the upstream-resolved FACTS to the pure @wardenx/quality
// reducers (`transitionIncident`, the QAPI project/PIP machines, the SRA cycle machine, the mortality
// machine) and persist the result. The §4.10 `m30.*` events are emitted through the injected
// {@link WriteOutboxPort} in the SAME unit of work as the mutation (transactional outbox), and the §4.8
// recompute / risk-refresh jobs through the injected {@link RecomputeEnqueuePort}.
//
// FROZEN-SCHEMA NOTES (the 18-table schema is locked; some richer DTO members have no dedicated column):
//   - the incident CAP plan, investigation notes, state history, and the triage ASSIGNEE have no columns,
//     so they live in a reserved `_m30` sidecar on `incident_report.kind_data` (the open jsonb payload);
//   - a QAPI PIP has no `chartered_by` column, so the SoD-closer-≠-charterer fact (V-11) is resolved from
//     the PIP's linked-project owner;
//   - `provider_entity_id` is NOT NULL on several tables but is not on the actor, so it is resolved
//     server-side through the injected {@link ProviderEntityPort} (fail-closed until bound).
// These mappings are best-effort projections; see the structured deviations in the phase report.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import {
  type CahpsAdapterRegistry,
  type CahpsAdapterResolutionMap,
  CahpsRepository,
  type CahpsVendorAdapterId,
  CopComplianceRepository,
  IncidentRepository,
  InfectionRepository,
  MeasureRecomputeQueueRepository,
  MortalityReviewRepository,
  type PipClosureCosign,
  QapiRepository,
  type QualityDb,
  QualityMeasureValueRepository,
  type SraClosureCosign,
  SraRepository,
  computeNextReviewDueAt,
  detectOutbreakClusters,
  isAllowedSubkind,
  isMandatoryReportRequired,
  normalizeBodySite,
  normalizePathogen,
  normalizeSurveillanceRow,
  toNewOutbreakCase,
  transitionIncident,
  transitionMortalityReview,
  transitionQapiPip,
  transitionQapiProject,
  transitionSraCycle,
  validateIncidentKindData,
} from "@wardenx/quality";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, NotFoundError, WardenXError } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import { ROLE_QAPI_COORDINATOR, ROLE_SECURITY_OFFICER } from "../abac-predicates";
import { createOrGetLiveExportJob, toCahpsExportJobView } from "../cahps/export-job-store";
import type { CahpsPhiCipher } from "../cahps/phi-cipher";
import { CAHPS_PENDING_CONFIGURATION } from "../cahps/pipeline";
import { selectActiveMemberRoleKeys } from "../member-roles";
import type { M30WriteActor } from "./actor";
import {
  PIP_CLOSE_ROLES,
  SRA_CLOSE_ROLES,
  buildCloseAttestation,
  buildPipClosureColumns,
  buildSraClosureColumns,
  resolveCloseCosigners,
} from "./close-cosign";
import { incidentOwnedBy } from "./incident-ownership";
import { resolveProviderEntityForSubject } from "./provider-entity-for-subject";
import type {
  CahpsDecedentView,
  CahpsExportJobView,
  CahpsVendorBindingView,
  CopCitationView,
  IncidentCapPlanView,
  IncidentDetailView,
  IncidentInvestigationNoteView,
  IncidentStateHistoryView,
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
import { type PatientScopeResolver, defaultPatientScopeResolver } from "./scope-resolver";
import { assertSraCycleAccess } from "./sra-ownership";
import { assertWritePatientInScope } from "./write-scope";
import type {
  AddInvestigationNoteArgs,
  AddQapiPipArgs,
  AddSraFindingArgs,
  AdoptQapiProgramArgs,
  BindCahpsVendorArgs,
  CahpsIngestResultView,
  CharterQapiProjectArgs,
  CloseQapiPipArgs,
  CloseSraCycleArgs,
  CompleteMortalityReviewArgs,
  CreateCahpsExportArgs,
  CreateIncidentArgs,
  CreateQapiIndicatorArgs,
  EnqueueRecomputeArgs,
  ExcludeCahpsDecedentArgs,
  IngestCahpsResultsArgs,
  M30WriteRouteService,
  OpenInvestigationArgs,
  OpenSraCycleArgs,
  PlanSraRemediationArgs,
  RecomputeEnqueuePort,
  RecomputeJobAcceptedView,
  RecordInfectionEventArgs,
  RecordQapiGovernanceArgs,
  ReopenIncidentArgs,
  ResolveIncidentArgs,
  ReviewCopCitationArgs,
  RiskRegisterRefreshAcceptedView,
  TriageIncidentArgs,
  UpdateCopCitationArgs,
  UpdateIncidentArgs,
  UpdateInfectionOutbreakArgs,
  UpdateMortalityReviewArgs,
  UpdateQapiGovernanceArgs,
  UpdateQapiIndicatorArgs,
  UpdateQapiProjectArgs,
  UpdateSraFindingArgs,
  UpdateSraRemediationArgs,
  WriteOutboxPort,
} from "./write-service";

/** The structural org-context transaction handle the repos write through (mirrors M33's WriteTx). */
export type WriteTx = QualityDb;

/**
 * Resolves the server-side `provider_entity_id` for an org (the M40 directory). M30 may not import another
 * feature module's package, so this is a typed PORT the composition root binds (e.g. to
 * `context.providerEntityIds[0]` or a single-provider lookup). The default deny-stub fails CLOSED.
 */
export interface ProviderEntityPort {
  primaryProviderEntityId(tx: WriteTx, organizationId: string): Promise<string>;
  /** GAP-154 - the subject's (patient's active admission) provider entity; null when none. Optional. */
  providerEntityIdForPatient?(organizationId: string, patientId: string): Promise<string | null>;
}

/** Deps the production M30 write service binds at boot (P2c) — every cross-boundary edge is a port. */
export interface M30WriteServicePorts {
  /** The §4.10 `m30.*` transactional-outbox emitter (best-effort until the dispatcher binds). */
  readonly outbox?: WriteOutboxPort;
  /** The §4.8 BullMQ producer for `m30.measure_recompute` / `m30.risk_register_refresh` (R-04 / R-96). */
  readonly recompute?: RecomputeEnqueuePort;
  /** Resolves `provider_entity_id` server-side for the NOT-NULL provider-scoped inserts (fail-closed default). */
  readonly providerEntity?: ProviderEntityPort;
  /** The per-org live CAHPS adapter registry (§4.5) — supplies the vendor's minimum-cell size on ingest. */
  readonly cahps?: CahpsAdapterRegistry;
  /** GAP-087 — the tenant-DEK cipher that seals a vendor binding's configuration on R-11. */
  readonly cahpsCipher?: CahpsPhiCipher;
  /** GAP-087 — `@wardenx/cahps-vendors`' factory map: R-11 validates a supplied configuration with the adapter. */
  readonly cahpsAdapterFactories?: CahpsAdapterResolutionMap;
  /**
   * GAP-091 follow-up — the PHI patient-scope resolver the service enforces ITSELF (second layer behind the
   * route predicate). Default: org-wide roles ⇒ org, everyone else ⇒ their M5 caseload via the seam, failing
   * closed. A typed system actor (`m30SystemWriteActor`) bypasses it.
   */
  readonly patientScope?: PatientScopeResolver;
  /** Injected clock (deterministic timestamps in tests). */
  readonly now?: () => Date;
}

// ── reserved incident sidecar (frozen-schema overflow lives in `kind_data._m30`) ───────────────────────

/** The operational sub-state an incident carries that has no dedicated column (stored under `kind_data._m30`). */
interface IncidentSidecar {
  assignedToMembershipId?: string;
  capPlan?: IncidentCapPlanView;
  capVerifiedByMembershipId?: string;
  capVerifiedAt?: string;
  closedByMembershipId?: string;
  investigationNotes?: IncidentInvestigationNoteView[];
  stateHistory?: IncidentStateHistoryView[];
}

const SIDECAR_KEY = "_m30";

function readSidecar(row: schema.IncidentReport): IncidentSidecar {
  const raw = (row.kindData as Record<string, unknown>)[SIDECAR_KEY];
  return raw && typeof raw === "object" ? (raw as IncidentSidecar) : {};
}

/** Merge a sidecar patch back onto the row's `kind_data`, preserving the per-kind payload members. */
function withSidecar(row: schema.IncidentReport, patch: IncidentSidecar): schema.IncidentKindData {
  const { [SIDECAR_KEY]: _drop, ...rest } = row.kindData as Record<string, unknown>;
  void _drop;
  return { ...rest, [SIDECAR_KEY]: { ...readSidecar(row), ...patch } } as schema.IncidentKindData;
}

// ── small mapping helpers ───────────────────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Vendor display name for a persisted `vendor_adapter_id` (the lower-snake → human-facing map). */
const CAHPS_VENDOR_NAMES: Readonly<Record<string, string>> = {
  shp: "SHP",
  press_ganey: "Press Ganey",
  deyta: "Deyta",
  healthcarefirst: "HEALTHCAREfirst",
  manual: "Manual",
};

/** The 5×5 residual score → posture band (1–25; the SRA finding risk-band projection). */
/** GAP-156 — `ownsSraCycle` for finding/remediation mutations: load the parent cycle, then owner-or-admin. */
async function assertOwnsFindingCycle(
  repo: SraRepository,
  actor: M30WriteActor,
  cycleId: string,
): Promise<void> {
  const cycle = await repo.findCycleById(cycleId);
  if (!cycle || cycle.organizationId !== actor.organizationId) throw new NotFoundError("sra cycle");
  assertSraCycleAccess(actor, cycle);
}

function riskBandOf(score: number): SraFindingView["riskBand"] {
  if (score >= 15) return "critical";
  if (score >= 10) return "high";
  if (score >= 5) return "medium";
  return "low";
}

/** `sra_finding.status` → the §4.2 disposition union the view projects. */
function findingDisposition(status: schema.SraFinding["status"]): SraFindingView["disposition"] {
  switch (status) {
    case "mitigated":
      return "remediated";
    case "accepted_risk":
      return "accepted";
    case "mitigation_planned":
    case "mitigation_in_progress":
      return "remediating";
    default:
      return "open";
  }
}

/** The inverse of {@link findingDisposition} for R-44 disposition writes. */
function dispositionToFindingStatus(
  disposition: NonNullable<UpdateSraFindingArgs["disposition"]>,
): schema.SraFinding["status"] {
  switch (disposition) {
    case "accepted":
    case "transferred":
      return "accepted_risk";
    case "remediating":
      return "mitigation_in_progress";
    case "remediated":
      return "mitigated";
    default:
      return "identified";
  }
}

/** `sra_remediation.status` → the §4.2 remediation-status union the view projects. */
function remediationStatusToView(
  status: schema.SraRemediation["status"],
): SraRemediationView["status"] {
  switch (status) {
    case "proposed":
      return "planned";
    case "abandoned":
      return "deferred";
    default:
      return status; // in_progress | completed
  }
}

/** The inverse of {@link remediationStatusToView} for R-46 writes. */
function remediationStatusToSchema(
  status: NonNullable<UpdateSraRemediationArgs["status"]>,
): schema.SraRemediation["status"] {
  switch (status) {
    case "planned":
      return "proposed";
    case "deferred":
      return "abandoned";
    default:
      return status; // in_progress | completed
  }
}

/** `mortality_review.status` → the §4.2 summary-status union (the view has no `overdue` member). */
function mortalityStatusToView(
  status: schema.MortalityReview["status"],
): MortalityReviewDetailView["status"] {
  switch (status) {
    case "pending":
      return "created";
    case "overdue":
      return "in_progress";
    default:
      return status; // in_progress | completed
  }
}

/** The §4.2 infection-outbreak status union → the frozen `m30_outbreak_status`. */
function outbreakStatusToSchema(
  status: UpdateInfectionOutbreakArgs["status"],
): schema.InfectionOutbreakCase["status"] {
  switch (status) {
    case "notified":
      return "idg_reviewed";
    case "resolved":
      return "closed";
    default:
      return status; // open | contained
  }
}

/** The inverse of {@link outbreakStatusToSchema}. */
function outbreakStatusToView(
  status: schema.InfectionOutbreakCase["status"],
): InfectionOutbreakView["status"] {
  switch (status) {
    case "idg_reviewed":
      return "notified";
    case "closed":
      return "resolved";
    default:
      return status; // open | contained
  }
}

/** Last calendar day of the month a `sampling_cycle_month` (YYYY-MM-01) anchors, as a YYYY-MM-DD string. */
function endOfMonth(firstOfMonth: string): string {
  const start = new Date(`${firstOfMonth.slice(0, 10)}T00:00:00.000Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return end.toISOString().slice(0, 10);
}

/** First day of the month an ISO instant falls in, as a YYYY-MM-DD string (the CAHPS cycle key). */
function firstOfMonth(isoInstant: string): string {
  const d = new Date(isoInstant);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${yyyy}-${mm}-01`;
}

// ── the factory ────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the Drizzle-backed {@link M30WriteRouteService}. `db` is the PRIMARY (RLS-enforced) client; every
 * method opens the actor's own `withOrgContext` transaction so Postgres scopes to `app.org_id`. The
 * returned object IS the route service the §4.1 mutating handlers compose over.
 */
export function buildDrizzleM30WriteService(
  db: DbClient,
  ports: M30WriteServicePorts = {},
): M30WriteRouteService {
  const now = ports.now ?? (() => new Date());
  const patientScope = ports.patientScope ?? defaultPatientScopeResolver;
  const recompute: RecomputeEnqueuePort = ports.recompute ?? {
    enqueue: async () => ({ jobId: randomUUID() }),
  };
  const providerEntity: ProviderEntityPort = ports.providerEntity ?? {
    async primaryProviderEntityId() {
      // Fail-closed: the composition root MUST bind this before provider-scoped inserts succeed.
      throw new WardenXError(
        "PROVIDER_ENTITY_UNRESOLVED",
        "no provider-entity resolver is bound; cannot stamp provider_entity_id server-side",
        503,
      );
    },
  };

  /** Run `fn` inside the actor's org-context tx (RLS scopes to `app.org_id`; never bypass). */
  const inOrgCtx = <T>(actor: M30WriteActor, fn: (tx: WriteTx) => Promise<T>): Promise<T> =>
    withOrgContext<WriteTx, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  /**
   * Emit a §4.10 `m30.*` event through the (optional) transactional-outbox port, on the CALLER'S tx so the
   * row commits in the same unit of work as the mutation. `organizationId`/`aggregateKind`/`aggregateId`
   * route the persisted `outbox_event` row (the org-scoped table requires both uuids non-null); the
   * `payload` is Value.Check'd against the registered catalog schema by the dispatcher (refuse-on-failure).
   */
  const emit = async (
    tx: WriteTx,
    input: {
      eventName: string;
      payload: Record<string, unknown>;
      organizationId: string;
      aggregateKind: string;
      aggregateId: string;
    },
  ): Promise<void> => {
    if (ports.outbox) await ports.outbox.publish(tx, input);
  };

  // ── partitioned point-loads (the partition key is unknown to the route; scan by id, then org-check) ──

  const loadIncident = async (
    tx: WriteTx,
    actor: M30WriteActor,
    incidentId: string,
  ): Promise<schema.IncidentReport> => {
    const [row] = await tx
      .select()
      .from(schema.incidentReport)
      .where(eq(schema.incidentReport.id, incidentId))
      .limit(1);
    if (!row || row.organizationId !== actor.organizationId)
      throw new NotFoundError("incident report");
    // GAP-091 — every lifecycle write (update / submit / triage / investigate / resolve / close / reopen) is
    // caseload-scoped HERE, at the service. The own-record arm (reporter, triager, assigned investigator)
    // keeps an assigned investigator from being locked out; a patient-less row stays org-level; a typed
    // system actor is exempt. The M30 org-wide READ arm does not apply to a write (no read surface passed).
    await assertWritePatientInScope(
      actor,
      row.patientId,
      patientScope,
      "incident report",
      incidentOwnedBy(row, actor.membershipId),
    );
    return row;
  };

  const loadMortality = async (
    tx: WriteTx,
    actor: M30WriteActor,
    reviewId: string,
  ): Promise<schema.MortalityReview> => {
    const [row] = await tx
      .select()
      .from(schema.mortalityReview)
      .where(eq(schema.mortalityReview.id, reviewId))
      .limit(1);
    if (!row || row.organizationId !== actor.organizationId)
      throw new NotFoundError("mortality review");
    return row;
  };

  /** GAP-091 — the read side's own-record arm: the assigned reviewer keeps access to the review they own. */
  const assertMortalityWriteScope = (
    actor: M30WriteActor,
    row: schema.MortalityReview,
  ): Promise<void> =>
    assertWritePatientInScope(
      actor,
      row.deceasedPatientId,
      patientScope,
      "mortality review",
      row.assignedReviewerMembershipId === actor.membershipId,
    );

  const loadCahpsSample = async (
    tx: WriteTx,
    actor: M30WriteActor,
    sampleId: string,
  ): Promise<schema.CahpsDecedentSample> => {
    const [row] = await tx
      .select()
      .from(schema.cahpsDecedentSample)
      .where(eq(schema.cahpsDecedentSample.id, sampleId))
      .limit(1);
    if (!row || row.organizationId !== actor.organizationId) {
      throw new NotFoundError("cahps decedent sample");
    }
    return row;
  };

  // ── incident projection (sidecar-aware) ──────────────────────────────────────────────────────────

  function mapIncidentDetail(row: schema.IncidentReport): IncidentDetailView {
    const sidecar = readSidecar(row);
    const { [SIDECAR_KEY]: _drop, ...data } = row.kindData as Record<string, unknown>;
    void _drop;
    return {
      incidentId: row.id,
      organizationId: row.organizationId,
      kind: row.kind,
      state: row.lifecycle,
      severity: row.severity,
      patientId: row.patientId ?? null,
      occurredAt: row.occurredAt.toISOString(),
      reportedAt: row.reportedAt.toISOString(),
      reportedByMembershipId: row.reportedByMembershipId,
      assignedToMembershipId: sidecar.assignedToMembershipId ?? null,
      data,
      capPlan: sidecar.capPlan ?? null,
      capVerifiedByMembershipId: sidecar.capVerifiedByMembershipId ?? null,
      capVerifiedAt: sidecar.capVerifiedAt ?? null,
      closedByMembershipId: sidecar.closedByMembershipId ?? null,
      closedAt: iso(row.closedAt),
      stateHistory: sidecar.stateHistory ?? [],
      investigationNotes: sidecar.investigationNotes ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Append an `(from → to)` entry to the incident's sidecar state-history list. */
  function appendHistory(
    row: schema.IncidentReport,
    toState: schema.IncidentReport["lifecycle"],
    actor: M30WriteActor,
    at: string,
  ): IncidentStateHistoryView[] {
    return [
      ...(readSidecar(row).stateHistory ?? []),
      { fromState: row.lifecycle, toState, actorMembershipId: actor.membershipId, occurredAt: at },
    ];
  }

  /** Emit the catalog `m30.incident.state_changed` for any incident transition (on the caller's tx). */
  const emitIncidentStateChange = (
    tx: WriteTx,
    actor: M30WriteActor,
    row: schema.IncidentReport,
    toState: schema.IncidentReport["lifecycle"],
    at: string,
  ): Promise<void> =>
    emit(tx, {
      eventName: "m30.incident.state_changed",
      organizationId: actor.organizationId,
      aggregateKind: "incident_report",
      aggregateId: row.id,
      payload: {
        orgId: actor.organizationId,
        incidentId: row.id,
        fromState: row.lifecycle,
        toState,
        actorUserId: actor.userId,
        occurredAt: at,
      },
    });

  // ── projections for the remaining domains ────────────────────────────────────────────────────────

  const mapBinding = (row: schema.CahpsVendorBinding): CahpsVendorBindingView => ({
    bindingId: row.id,
    organizationId: row.organizationId,
    vendorAdapterId: row.vendorAdapterId,
    vendorName: CAHPS_VENDOR_NAMES[row.vendorAdapterId] ?? row.vendorAdapterId,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: iso(row.effectiveUntil),
    isActive: row.active,
  });

  const mapDecedent = (row: schema.CahpsDecedentSample): CahpsDecedentView => {
    const month = `${row.samplingCycleMonth.slice(0, 10)}`;
    return {
      sampleId: row.id,
      organizationId: row.organizationId,
      patientId: row.deceasedPatientId,
      dateOfDeath: month, // no DoD column on the sample row — the cycle month is the only date anchor
      samplePeriodStart: month,
      samplePeriodEnd: endOfMonth(month),
      eligible: row.exclusionReason === null,
      exclusionReason: row.exclusionReason ?? null,
    };
  };

  const mapProgram = (row: schema.QapiProgram): QapiProgramView => ({
    programId: row.id,
    organizationId: row.organizationId,
    planYear: row.planYear,
    charterAdoptedAt: row.createdAt.toISOString(),
    governanceComposition: (row.governingBodyRoster ?? []).map((m) => ({
      role: m.role,
      membershipId: m.membershipId,
    })),
    status: row.closed ? "superseded" : "active",
  });

  const mapIndicator = (
    row: schema.QapiIndicator,
    thresholdDirection: QapiIndicatorView["thresholdDirection"],
  ): QapiIndicatorView => ({
    indicatorId: row.id,
    organizationId: row.organizationId,
    qapiProgramId: row.qapiProgramId,
    displayName: row.indicatorName,
    measureId: row.dataPath.startsWith("measure:") ? row.dataPath.slice("measure:".length) : null,
    thresholdDirection,
    thresholdValue: Number(row.tenantTargetValue ?? 0),
    currentRate: null,
    currentBand: null,
    breached: false,
  });

  const mapProject = (row: schema.QapiProject): QapiProjectView => ({
    projectId: row.id,
    organizationId: row.organizationId,
    qapiProgramId: row.qapiProgramId,
    title: row.title,
    phase: row.status,
    indicatorId: row.linkedIndicatorId ?? null,
    ledByMembershipId: row.ownerMembershipId ?? null,
    charteredAt: row.createdAt.toISOString(),
    completedAt: row.status === "completed" ? row.updatedAt.toISOString() : null,
  });

  const mapPip = (row: schema.QapiPip, charteredByMembershipId: string): QapiPipView => ({
    pipId: row.id,
    organizationId: row.organizationId,
    projectId: row.linkedProjectId ?? "",
    phase: row.status,
    charterText: row.charterText,
    charteredByMembershipId,
    outcome: row.conclusionText ?? null,
    closedAt: iso(row.closedAt),
  });

  const mapMinutes = (
    row: schema.QapiGovernanceMinutes,
    recordedByMembershipId: string,
  ): QapiGovernanceMinutesView => ({
    minutesId: row.id,
    organizationId: row.organizationId,
    qapiProgramId: row.qapiProgramId,
    meetingAt: row.meetingAt.toISOString(),
    recordedByMembershipId,
    summary: row.minutesText,
    attendees: (row.attendeeRoster ?? []).map((a) => ({
      role: a.role ?? "",
      membershipId: a.membershipId,
    })),
  });

  const mapCycle = (row: schema.SraCycle): SraCycleView => ({
    cycleId: row.id,
    organizationId: row.organizationId,
    cycleYear: row.cycleYear,
    status: row.status,
    scopeTemplateVersion: row.templateVersion,
    ownerMembershipId: row.openedByMembershipId,
    openedAt: row.openedAt.toISOString(),
    closedAt: iso(row.closedAt),
  });

  const mapFinding = (
    row: schema.SraFinding,
    echo: { controlRef?: string; likelihood?: number; impact?: number } = {},
  ): SraFindingView => ({
    findingId: row.id,
    cycleId: row.sraCycleId,
    findingNumber: row.findingNumber,
    controlRef: echo.controlRef ?? "",
    likelihood: echo.likelihood ?? 0,
    impact: echo.impact ?? 0,
    riskScore: row.residual5x5Score,
    riskBand: riskBandOf(row.residual5x5Score),
    disposition: findingDisposition(row.status),
  });

  const mapRemediation = (row: schema.SraRemediation): SraRemediationView => ({
    remediationId: row.id,
    findingId: row.sraFindingId,
    remediationNumber: row.remediationNumber,
    plan: row.descriptionText,
    ownerMembershipId: row.ownerMembershipId,
    dueAt: row.targetDate ?? null,
    status: remediationStatusToView(row.status),
    completedAt: iso(row.completedAt),
  });

  const mapMortality = (row: schema.MortalityReview): MortalityReviewDetailView => ({
    reviewId: row.id,
    organizationId: row.organizationId,
    patientId: row.deceasedPatientId,
    dateOfDeath: row.deathAt.toISOString(),
    assignedToMembershipId: row.assignedReviewerMembershipId ?? null,
    status: mortalityStatusToView(row.status),
    targetCompletionAt: row.targetCompletionAt.toISOString(),
    completedAt: iso(row.completedAt),
    dimensions: {
      clinical: row.clinicalDimensionData ?? null,
      satisfaction: row.satisfactionDimensionData ?? null,
      compliance: row.complianceDimensionData ?? null,
    },
    reviewerMembershipId: row.assignedReviewerMembershipId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  const mapCop = (row: schema.CopComplianceStatus): CopCitationView => ({
    citationId: row.id,
    organizationId: row.organizationId,
    citationRef: row.copCitation,
    displayName: row.copCitation,
    status: row.status,
    evidencePointers: row.evidenceDocumentIds ?? [],
    lastReviewedAt: iso(row.lastReviewedAt),
    nextReviewDueAt: iso(row.nextReviewDueAt),
  });

  const mapOutbreak = (row: schema.InfectionOutbreakCase): InfectionOutbreakView => ({
    caseId: row.id,
    organizationId: row.organizationId,
    pathogen: row.pathogen,
    bodySite: row.bodySite,
    eventCount: row.triggeringEventCount,
    firstEventAt: row.windowStart.toISOString(),
    lastEventAt: row.windowEnd.toISOString(),
    status: outbreakStatusToView(row.status),
    resolvedAt: iso(row.closedAt),
  });

  // ── the service ───────────────────────────────────────────────────────────────────────────────────

  const service: M30WriteRouteService = {
    // ── quality measures (R-04) ──
    async enqueueRecompute(actor, args: EnqueueRecomputeArgs): Promise<RecomputeJobAcceptedView> {
      const scopeKey =
        args.scope.kind === "measure"
          ? `measure:${args.scope.measureId}`
          : args.scope.kind === "domain"
            ? `domain:${args.scope.domain}`
            : "all";
      const { jobId } = await recompute.enqueue(
        "m30.measure_recompute",
        `${actor.organizationId}:${scopeKey}`,
        {
          orgId: actor.organizationId,
          scope: args.scope,
          reason: args.reason,
          priority: args.priority ?? "normal",
        },
      );
      return { jobId, scope: args.scope, priority: args.priority ?? "normal" };
    },

    // ── CAHPS (R-11, R-13, R-14, R-16) ──
    async bindCahpsVendor(actor, args: BindCahpsVendorArgs): Promise<CahpsVendorBindingView> {
      // GAP-087 — a supplied configuration is validated by the vendor adapter, then sealed under the tenant DEK
      // (never stored in the clear, never echoed). Without one the binding opens unconfigured — fine for `manual`.
      let configurationCipher = CAHPS_PENDING_CONFIGURATION;
      let configurationKeyVersion = 1;
      if (args.configuration !== undefined) {
        const factory = ports.cahpsAdapterFactories?.[args.vendorAdapterId as CahpsVendorAdapterId];
        if (!ports.cahpsCipher || !factory) {
          throw new WardenXError(
            "CAHPS_CONFIGURATION_UNAVAILABLE",
            "this deployment cannot store a CAHPS vendor configuration (no tenant key cipher / adapter factory bound)",
            503,
          );
        }
        const verdict = await factory(args.configuration as Record<string, unknown>).validateConfig(
          args.configuration as Record<string, unknown>,
        );
        if (!verdict.ok) {
          throw new WardenXError(
            "VALIDATION_FAILED",
            `the CAHPS vendor configuration is invalid: ${verdict.errors
              .map((e) => `${e.field}: ${e.reason}`)
              .join("; ")}`,
            422,
          );
        }
        const sealed = await ports.cahpsCipher.encrypt(
          actor.organizationId,
          "cahps_vendor_binding.configuration_cipher",
          JSON.stringify(args.configuration),
        );
        configurationCipher = sealed.envelope;
        configurationKeyVersion = sealed.keyVersion;
      }
      return inOrgCtx(actor, async (tx) => {
        const repo = new CahpsRepository(tx);
        const prior = await repo.findActiveBinding(actor.organizationId);
        if (prior) {
          // V-7: ≤1 active binding per org — retire the incumbent before activating the rotation.
          await repo.updateBinding(prior.id, {
            active: false,
            effectiveUntil: now(),
            updatedAt: now(),
          });
        }
        const row = await repo.createBinding({
          organizationId: actor.organizationId,
          vendorAdapterId: args.vendorAdapterId,
          active: true,
          effectiveFrom: new Date(args.effectiveFrom),
          configurationCipher,
          configurationKeyVersion,
        });
        return mapBinding(row);
      });
    },

    async excludeCahpsDecedent(
      actor,
      sampleId,
      args: ExcludeCahpsDecedentArgs,
    ): Promise<CahpsDecedentView> {
      return inOrgCtx(actor, async (tx) => {
        const sample = await loadCahpsSample(tx, actor, sampleId);
        const row = await new CahpsRepository(tx).updateSampleExportStatus(
          sample.id,
          sample.samplingCycleMonth,
          { exclusionReason: args.exclusionReason },
        );
        return mapDecedent(row);
      });
    },

    async createCahpsExport(actor, args: CreateCahpsExportArgs): Promise<CahpsExportJobView> {
      // GAP-087 — a real job: persist the row, then enqueue it onto `m30.cahps_export` (the worker renders the vendor
      // file, seals + stores it on the row and pushes it). A LIVE job for the same cycle is returned instead of a
      // second one, so a retry converges. Rows that failed a prior export are re-opened here (§4.8: the QAPI
      // Coordinator manually re-triggers via R-14 after `export_failed`).
      const { row, created } = await inOrgCtx(actor, async (tx) => {
        const repo = new CahpsRepository(tx);
        const binding = await repo.findActiveBinding(actor.organizationId);
        if (!binding)
          throw new ConflictError("the org has no active CAHPS vendor binding to export to");
        const cycleMonth = firstOfMonth(args.samplePeriodStart);
        await tx
          .update(schema.cahpsDecedentSample)
          .set({ status: "pending_export" })
          .where(
            and(
              eq(schema.cahpsDecedentSample.organizationId, actor.organizationId),
              eq(schema.cahpsDecedentSample.samplingCycleMonth, cycleMonth),
              eq(schema.cahpsDecedentSample.status, "export_failed"),
            ),
          );
        const pending = await repo.listSamplesForCycle(
          actor.organizationId,
          cycleMonth,
          "pending_export",
        );
        if (pending.length === 0) {
          throw new ConflictError("there are no sampled decedents pending export for that cycle");
        }
        return createOrGetLiveExportJob(tx, {
          organizationId: actor.organizationId,
          vendorBindingId: binding.id,
          vendorAdapterId: binding.vendorAdapterId,
          samplingCycleMonth: cycleMonth,
          samplePeriodStart: args.samplePeriodStart.slice(0, 10),
          samplePeriodEnd: args.samplePeriodEnd.slice(0, 10),
          decedentCount: pending.length,
          requestedByUserId: actor.userId,
        });
      });
      if (created) {
        try {
          await recompute.enqueue("m30.cahps_export", `${actor.organizationId}:${row.id}`, {
            jobId: row.id,
            exportId: row.id,
            organizationId: actor.organizationId,
            samplingCycleMonth: row.samplingCycleMonth,
            samplePeriodStart: row.samplePeriodStart,
            samplePeriodEnd: row.samplePeriodEnd,
            vendorBindingId: row.vendorBindingId,
          });
        } catch (cause) {
          // The row committed but nothing will ever run it: close it out rather than leave a "queued" ghost.
          await inOrgCtx(actor, (tx) =>
            tx
              .update(schema.cahpsExportJob)
              .set({
                status: "failed",
                failureReason: "the export could not be enqueued (queue unavailable)",
                completedAt: now(),
              })
              .where(eq(schema.cahpsExportJob.id, row.id)),
          );
          throw cause;
        }
      }
      return toCahpsExportJobView(row);
    },

    async ingestCahpsResults(actor, args: IngestCahpsResultsArgs): Promise<CahpsIngestResultView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new CahpsRepository(tx);
        const providerEntityId = await providerEntity.primaryProviderEntityId(
          tx,
          actor.organizationId,
        );
        const startDate = args.reportingPeriodStart.slice(0, 10);
        const endDate = args.reportingPeriodEnd.slice(0, 10);
        // Idempotent on (provider, vendor, period, payloadHash) — a redelivered vendor payload no-ops.
        const existing = await repo.findResultIdempotent(
          providerEntityId,
          args.vendorAdapterId,
          startDate,
          endDate,
          args.payloadHash,
        );
        if (existing) {
          return {
            resultIds: [existing.id],
            measuresAffected: Object.keys(existing.topBoxPercentages ?? {}),
            suppressedMinCellCount: 0,
          };
        }
        const minCell = ports.cahps?.has(actor.organizationId)
          ? ports.cahps.resolve(actor.organizationId).minimumCellSize()
          : 30; // CMS small-cell default
        const topBox: schema.CahpsTopBoxPercentages = {};
        const measuresAffected: string[] = [];
        let suppressed = 0;
        let responseCount = 0;
        for (const r of args.results) {
          if (r.respondentCount <= minCell) {
            suppressed += 1; // small-cell protection — the score is not published
            continue;
          }
          topBox[r.measureId] = r.topBoxPercent ?? 0;
          measuresAffected.push(r.measureId);
          responseCount = Math.max(responseCount, r.respondentCount);
        }
        const row = await repo.insertResultSummary({
          organizationId: actor.organizationId,
          providerEntityId,
          reportingPeriodStart: startDate,
          reportingPeriodEnd: endDate,
          vendorAdapterId: args.vendorAdapterId,
          topBoxPercentages: topBox,
          compositeScores: {},
          responseCount,
          attemptedSampleCount: responseCount,
          responseRate: null,
          vendorResponsePayloadHash: args.payloadHash,
        });
        await emit(tx, {
          eventName: "m30.cahps.results_ingested",
          organizationId: actor.organizationId,
          aggregateKind: "cahps_result_summary",
          aggregateId: row.id,
          payload: {
            orgId: actor.organizationId,
            period: { start: args.reportingPeriodStart, end: args.reportingPeriodEnd },
            measuresAffected,
          },
        });
        return { resultIds: [row.id], measuresAffected, suppressedMinCellCount: suppressed };
      });
    },

    // ── QAPI (R-21, R-22, R-24, R-25, R-27, R-28, R-30, R-31, R-32) ──
    async adoptQapiProgram(actor, args: AdoptQapiProgramArgs): Promise<QapiProgramView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new QapiRepository(tx);
        if (await repo.findProgramByYear(actor.organizationId, args.planYear)) {
          throw new ConflictError(`a QAPI program already exists for plan year ${args.planYear}`);
        }
        const providerEntityId = await providerEntity.primaryProviderEntityId(
          tx,
          actor.organizationId,
        );
        const row = await repo.createProgram({
          organizationId: actor.organizationId,
          providerEntityId,
          planYear: args.planYear,
          programDescription: `QAPI Program ${args.planYear}`,
          governingBodyRoster: args.governanceComposition.map((m) => ({
            membershipId: m.membershipId,
            role: m.role,
          })),
        });
        return mapProgram(row);
      });
    },

    async updateQapiProgramGovernance(
      actor,
      programId,
      args: UpdateQapiGovernanceArgs,
    ): Promise<QapiProgramView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new QapiRepository(tx);
        const program = await repo.findProgramById(programId);
        if (!program || program.organizationId !== actor.organizationId) {
          throw new NotFoundError("qapi program");
        }
        const row = await repo.updateProgram(programId, {
          governingBodyRoster: args.governanceComposition.map((m) => ({
            membershipId: m.membershipId,
            role: m.role,
          })),
          updatedAt: now(),
          version: program.version + 1,
        });
        return mapProgram(row);
      });
    },

    async createQapiIndicator(actor, args: CreateQapiIndicatorArgs): Promise<QapiIndicatorView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new QapiRepository(tx);
        const program = await repo.findProgramById(args.qapiProgramId);
        if (!program || program.organizationId !== actor.organizationId) {
          throw new NotFoundError("qapi program");
        }
        const row = await repo.createIndicator({
          qapiProgramId: args.qapiProgramId,
          organizationId: actor.organizationId,
          indicatorName: args.displayName,
          dataPath: args.dataPath,
          tenantTargetValue: String(args.thresholdValue),
        });
        return mapIndicator(row, args.thresholdDirection);
      });
    },

    async updateQapiIndicator(
      actor,
      indicatorId,
      args: UpdateQapiIndicatorArgs,
    ): Promise<QapiIndicatorView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new QapiRepository(tx);
        const existing = await repo.findIndicatorById(indicatorId);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("qapi indicator");
        }
        const row = await repo.updateIndicator(indicatorId, {
          indicatorName: args.displayName ?? existing.indicatorName,
          tenantTargetValue:
            args.thresholdValue !== undefined
              ? String(args.thresholdValue)
              : existing.tenantTargetValue,
        });
        return mapIndicator(row, args.thresholdDirection ?? "min");
      });
    },

    async charterQapiProject(actor, args: CharterQapiProjectArgs): Promise<QapiProjectView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new QapiRepository(tx);
        const program = await repo.findProgramById(args.qapiProgramId);
        if (!program || program.organizationId !== actor.organizationId) {
          throw new NotFoundError("qapi program");
        }
        const row = await repo.createProject({
          qapiProgramId: args.qapiProgramId,
          organizationId: actor.organizationId,
          title: args.title,
          goalText: args.charterNarrative,
          ownerMembershipId: actor.membershipId,
          linkedIndicatorId: args.indicatorId ?? null,
        });
        if (args.indicatorId) {
          await emit(tx, {
            eventName: "m30.qapi.project_chartered",
            organizationId: actor.organizationId,
            aggregateKind: "qapi_project",
            aggregateId: row.id,
            payload: {
              orgId: actor.organizationId,
              projectId: row.id,
              indicatorId: args.indicatorId,
              phase: "planned",
            },
          });
        }
        return mapProject(row);
      });
    },

    async updateQapiProject(
      actor,
      projectId,
      args: UpdateQapiProjectArgs,
    ): Promise<QapiProjectView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new QapiRepository(tx);
        const existing = await repo.findProjectById(projectId);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("qapi project");
        }
        let status = existing.status;
        if (args.phase && args.phase !== existing.status) {
          // Drive the PURE project machine — never re-implement the §2.2 transition logic here.
          switch (args.phase) {
            case "active":
              status = transitionQapiProject(existing.status, { type: "activate" });
              break;
            case "corrective_action":
              status = transitionQapiProject(existing.status, {
                type: "enterCorrectiveAction",
                rootCauseIdentified: true,
              });
              break;
            case "completed":
              status = transitionQapiProject(existing.status, {
                type: "complete",
                outcomeText: existing.outcomeText ?? "",
                outcomeMeetsTarget: true,
              });
              break;
            case "abandoned":
              status = transitionQapiProject(existing.status, {
                type: "abandon",
                reason: existing.abandonReason ?? "",
              });
              break;
            default:
              throw new ConflictError(`a QAPI project cannot transition to '${args.phase}'`);
          }
        }
        const row = await repo.updateProject(projectId, {
          status,
          ownerMembershipId: args.ledByMembershipId ?? existing.ownerMembershipId,
          updatedAt: now(),
          version: existing.version + 1,
        });
        return mapProject(row);
      });
    },

    async addQapiPip(actor, projectId, args: AddQapiPipArgs): Promise<QapiPipView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new QapiRepository(tx);
        const project = await repo.findProjectById(projectId);
        if (!project || project.organizationId !== actor.organizationId) {
          throw new NotFoundError("qapi project");
        }
        const row = await repo.createPip({
          qapiProgramId: project.qapiProgramId,
          linkedProjectId: projectId,
          organizationId: actor.organizationId,
          title: project.title,
          charterText: args.charterText,
        });
        // No `chartered_by` column — the linked project's owner is the PIP's charterer of record (V-11 SoD).
        return mapPip(row, project.ownerMembershipId);
      });
    },

    async closeQapiPip(actor, pipId, args: CloseQapiPipArgs): Promise<QapiPipView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new QapiRepository(tx);
        const pip = await repo.findPipById(pipId);
        if (!pip || pip.organizationId !== actor.organizationId)
          throw new NotFoundError("qapi pip");
        // Resolve the charterer server-side (the linked project's owner) — NEVER read off the wire.
        const project = pip.linkedProjectId
          ? await repo.findProjectById(pip.linkedProjectId)
          : null;
        const charteredByMembershipId = project?.ownerMembershipId ?? "";
        // GAP-088: signer = the authenticated caller; the nominated co-signer is validated (active, distinct,
        // complementary role, fresh step-up) against facts loaded in THIS tx — never trusted off the wire.
        const signers = resolveCloseCosigners({
          actorMembershipId: actor.membershipId,
          actorRoles: actor.roles,
          cosignerMembershipId: args.cosignerMembershipId,
          cosignerRoleKeys: await selectActiveMemberRoleKeys(
            tx,
            actor.organizationId,
            args.cosignerMembershipId,
          ),
          recentStepUp: args.recentStepUp,
          roles: PIP_CLOSE_ROLES,
        });
        // Nominee-based one-step close: the closer alone signs; the nominee is recorded un-attested both in the
        // event payload and on the row (migration 0335: nominee slot `_at` NULL + `closure_cosign_attested`
        // false; V-11 requires both `_at` only for attested closes).
        const attestation = buildCloseAttestation(signers);
        const callerIsCoordinator = signers.callerRole === ROLE_QAPI_COORDINATOR;
        const cosign: PipClosureCosign = {
          qapiCoordinatorMembershipId: callerIsCoordinator ? signers.first : signers.second,
          medicalDirectorMembershipId: callerIsCoordinator ? signers.second : signers.first,
          charteredByMembershipId,
        };
        // The pure PIP machine enforces the V-11 two-person split + closer-≠-charterer SoD via the cosign.
        const status = transitionQapiPip(pip.status, {
          type: "conclude",
          conclusionText: args.conclusionText,
          cosign,
        });
        const at = now();
        const row = await repo.updatePip(pipId, {
          status,
          conclusionText: args.conclusionText,
          ...buildPipClosureColumns(signers, at),
          closedAt: at,
          updatedAt: at,
          version: pip.version + 1,
        });
        await emit(tx, {
          eventName: "m30.qapi.pip_closed",
          organizationId: actor.organizationId,
          aggregateKind: "qapi_pip",
          aggregateId: pipId,
          payload: {
            orgId: actor.organizationId,
            projectId: pip.linkedProjectId ?? null,
            pipId,
            outcome: args.outcome,
            closedAt: at.toISOString(),
            ...attestation,
          },
        });
        return mapPip(row, charteredByMembershipId);
      });
    },

    async recordQapiGovernance(
      actor,
      args: RecordQapiGovernanceArgs,
    ): Promise<QapiGovernanceMinutesView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new QapiRepository(tx);
        const program = await repo.findProgramById(args.qapiProgramId);
        if (!program || program.organizationId !== actor.organizationId) {
          throw new NotFoundError("qapi program");
        }
        const row = await repo.createMinutes({
          qapiProgramId: args.qapiProgramId,
          organizationId: actor.organizationId,
          meetingAt: new Date(args.meetingAt),
          attendeeRoster: args.attendees.map((a) => ({
            membershipId: a.membershipId,
            role: a.role,
          })),
          minutesText: args.summary,
          reviewedProjectIds: [],
          reviewedPipIds: [],
        });
        // No `recorded_by` column — the acting member is the recorder of record (echoed on the write).
        return mapMinutes(row, actor.membershipId);
      });
    },

    // ── SRA (R-41, R-43, R-44, R-45, R-46, R-47) ──
    async openSraCycle(actor, args: OpenSraCycleArgs): Promise<SraCycleView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new SraRepository(tx);
        if (await repo.findCycleByYear(actor.organizationId, args.cycleYear)) {
          throw new ConflictError(`an SRA cycle already exists for ${args.cycleYear}`);
        }
        const opened = now();
        const dueAt = new Date(opened.getTime() + 365 * 24 * 60 * 60 * 1000);
        const row = await repo.createCycle({
          organizationId: actor.organizationId,
          cycleYear: args.cycleYear,
          openedByMembershipId: actor.membershipId,
          dueAt,
        });
        await emit(tx, {
          eventName: "m30.sra.cycle_opened",
          organizationId: actor.organizationId,
          aggregateKind: "sra_cycle",
          aggregateId: row.id,
          payload: {
            orgId: actor.organizationId,
            cycleId: row.id,
            fiscalYear: args.cycleYear,
            scopeTemplateVersion: row.templateVersion,
          },
        });
        return mapCycle(row);
      });
    },

    async addSraFinding(actor, cycleId, args: AddSraFindingArgs): Promise<SraFindingView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new SraRepository(tx);
        const cycle = await repo.findCycleById(cycleId);
        if (!cycle || cycle.organizationId !== actor.organizationId)
          throw new NotFoundError("sra cycle");
        assertSraCycleAccess(actor, cycle);
        // Server-authoritative sequential number (the per-cycle uq_sra_finding_in_cycle surface).
        const findingNumber = (await repo.highestFindingNumber(cycleId)) + 1;
        const score = args.likelihood * args.impact;
        const row = await repo.createFinding({
          sraCycleId: cycleId,
          organizationId: actor.organizationId,
          findingNumber,
          threatDescription: args.description,
          vulnerabilityDescription: args.description,
          impactDescription: args.description,
          affectedAssetCategory: "technical",
          inherent5x5Score: score,
          residual5x5Score: score,
        });
        await emit(tx, {
          eventName: "m30.sra.finding_added",
          organizationId: actor.organizationId,
          aggregateKind: "sra_finding",
          aggregateId: row.id,
          payload: {
            orgId: actor.organizationId,
            cycleId,
            findingId: row.id,
            controlRef: args.controlRef,
            riskBand: riskBandOf(score),
          },
        });
        return mapFinding(row, {
          controlRef: args.controlRef,
          likelihood: args.likelihood,
          impact: args.impact,
        });
      });
    },

    async updateSraFinding(actor, findingId, args: UpdateSraFindingArgs): Promise<SraFindingView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new SraRepository(tx);
        const existing = await repo.findFindingById(findingId);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("sra finding");
        }
        await assertOwnsFindingCycle(repo, actor, existing.sraCycleId);
        const likelihood = args.likelihood;
        const impact = args.impact;
        const residual =
          likelihood !== undefined && impact !== undefined
            ? likelihood * impact
            : existing.residual5x5Score;
        const row = await repo.updateFinding(findingId, {
          residual5x5Score: residual,
          status: args.disposition ? dispositionToFindingStatus(args.disposition) : existing.status,
          updatedAt: now(),
          version: existing.version + 1,
        });
        return mapFinding(row, { likelihood, impact });
      });
    },

    async planSraRemediation(
      actor,
      findingId,
      args: PlanSraRemediationArgs,
    ): Promise<SraRemediationView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new SraRepository(tx);
        const finding = await repo.findFindingById(findingId);
        if (!finding || finding.organizationId !== actor.organizationId) {
          throw new NotFoundError("sra finding");
        }
        await assertOwnsFindingCycle(repo, actor, finding.sraCycleId);
        const remediationNumber = (await repo.highestRemediationNumber(findingId)) + 1;
        const targetDate = (
          args.dueAt ? new Date(args.dueAt) : new Date(now().getTime() + 90 * 24 * 60 * 60 * 1000)
        )
          .toISOString()
          .slice(0, 10);
        const row = await repo.createRemediation({
          sraFindingId: findingId,
          organizationId: actor.organizationId,
          remediationNumber,
          ownerMembershipId: args.ownerMembershipId,
          descriptionText: args.plan,
          targetDate,
        });
        return mapRemediation(row);
      });
    },

    async updateSraRemediation(
      actor,
      remediationId,
      args: UpdateSraRemediationArgs,
    ): Promise<SraRemediationView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new SraRepository(tx);
        const existing = await repo.findRemediationById(remediationId);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("sra remediation");
        }
        const parent = await repo.findFindingById(existing.sraFindingId);
        if (!parent) throw new NotFoundError("sra finding");
        await assertOwnsFindingCycle(repo, actor, parent.sraCycleId);
        const status = args.status ? remediationStatusToSchema(args.status) : existing.status;
        const row = await repo.updateRemediation(remediationId, {
          status,
          targetDate: args.dueAt ? args.dueAt.slice(0, 10) : existing.targetDate,
          completedAt:
            status === "completed" ? (existing.completedAt ?? now()) : existing.completedAt,
          updatedAt: now(),
          version: existing.version + 1,
        });
        return mapRemediation(row);
      });
    },

    async closeSraCycle(actor, cycleId, args: CloseSraCycleArgs): Promise<SraCycleView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new SraRepository(tx);
        const cycle = await repo.findCycleById(cycleId);
        if (!cycle || cycle.organizationId !== actor.organizationId)
          throw new NotFoundError("sra cycle");
        // GAP-088: signer = the authenticated caller; the nominated co-signer is validated (active, distinct,
        // complementary role, fresh step-up) against facts loaded in THIS tx — never trusted off the wire.
        const signers = resolveCloseCosigners({
          actorMembershipId: actor.membershipId,
          actorRoles: actor.roles,
          cosignerMembershipId: args.cosignerMembershipId,
          cosignerRoleKeys: await selectActiveMemberRoleKeys(
            tx,
            actor.organizationId,
            args.cosignerMembershipId,
          ),
          recentStepUp: args.recentStepUp,
          roles: SRA_CLOSE_ROLES,
        });
        // Nominee-based one-step close: see closeQapiPip — the closer alone signs, the nominee slot's `_at` stays NULL.
        const attestation = buildCloseAttestation(signers);
        const callerIsSecurityOfficer = signers.callerRole === ROLE_SECURITY_OFFICER;
        const cosign: SraClosureCosign = {
          securityOfficerMembershipId: callerIsSecurityOfficer ? signers.first : signers.second,
          complianceOfficerMembershipId: callerIsSecurityOfficer ? signers.second : signers.first,
        };
        // The pure SRA machine re-asserts the V-12 split; the step-up is the REAL freshness, not a constant.
        const status = transitionSraCycle(cycle.status, {
          type: "close",
          cosign,
          recentStepUp: args.recentStepUp,
        });
        const at = now();
        const row = await repo.updateCycle(cycleId, {
          status,
          ...buildSraClosureColumns(signers, at),
          closedAt: at,
          updatedAt: at,
          version: cycle.version + 1,
        });
        const open = (await repo.listFindings(cycleId)).filter(
          (f) => f.status !== "mitigated" && f.status !== "accepted_risk",
        ).length;
        await emit(tx, {
          eventName: "m30.sra.cycle_closed",
          organizationId: actor.organizationId,
          aggregateKind: "sra_cycle",
          aggregateId: cycleId,
          payload: {
            orgId: actor.organizationId,
            cycleId,
            closedAt: at.toISOString(),
            openFindingsAtClose: open,
            ...attestation,
          },
        });
        return mapCycle(row);
      });
    },

    // ── incidents (R-51, R-53..R-60) ──
    async createIncident(actor, args: CreateIncidentArgs): Promise<IncidentDetailView> {
      // GAP-091 — service-layer scope: a patient-linked report about a patient outside the actor's scope is a
      // 404 even if the route predicate was skipped. Checked BEFORE opening the transaction.
      await assertWritePatientInScope(actor, args.patientId, patientScope);
      return inOrgCtx(actor, async (tx) => {
        // §4.2 per-kind validation: a present-but-disallowed exposure subkind is refused at create.
        const subkind = typeof args.data.subkind === "string" ? args.data.subkind : undefined;
        if (
          args.kind === "exposure_event" &&
          subkind !== undefined &&
          !isAllowedSubkind(args.kind, subkind)
        ) {
          throw new WardenXError(
            "VALIDATION_FAILED",
            `'${subkind}' is not a valid exposure subkind`,
            422,
          );
        }
        const providerEntityId = await resolveProviderEntityForSubject(
          providerEntity,
          tx,
          actor.organizationId,
          args.patientId,
        );
        const row = await new IncidentRepository(tx).create({
          organizationId: actor.organizationId,
          providerEntityId,
          kind: args.kind,
          kindData: { ...args.data } as schema.IncidentKindData,
          patientId: args.patientId ?? null,
          occurredAt: new Date(args.occurredAt),
          reportedByMembershipId: actor.membershipId,
          severity: args.severity,
          lifecycle: "draft",
        });
        return mapIncidentDetail(row);
      });
    },

    async updateIncident(actor, incidentId, args: UpdateIncidentArgs): Promise<IncidentDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new IncidentRepository(tx);
        const row = await loadIncident(tx, actor, incidentId);
        // `occurred_at` is the partition key — it cannot be moved here; only severity / kind_data edit.
        const kindData =
          args.data !== undefined
            ? ({ ...args.data, [SIDECAR_KEY]: readSidecar(row) } as schema.IncidentKindData)
            : row.kindData;
        const updated = await repo.update(row.id, row.occurredAt, {
          severity: args.severity ?? row.severity,
          kindData,
          updatedAt: now(),
          version: row.version + 1,
        });
        return mapIncidentDetail(updated);
      });
    },

    async submitIncident(actor, incidentId): Promise<IncidentDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new IncidentRepository(tx);
        const row = await loadIncident(tx, actor, incidentId);
        const subkind = typeof row.kindData.subkind === "string" ? row.kindData.subkind : undefined;
        const result = transitionIncident(row.lifecycle, {
          type: "submit",
          kind: row.kind,
          severity: row.severity,
          requiredFieldsComplete: validateIncidentKindData(row.kind, row.kindData).ok,
          mandatoryReportRequired: isMandatoryReportRequired(row.kind, subkind),
          mandatoryReportFlagSet: row.mandatoryReportFlag,
        });
        const at = now();
        const updated = await repo.update(row.id, row.occurredAt, {
          lifecycle: result.to,
          kindData: withSidecar(row, {
            stateHistory: appendHistory(row, result.to, actor, at.toISOString()),
          }),
          updatedAt: at,
          version: row.version + 1,
        });
        await emit(tx, {
          eventName: "m30.incident.submitted",
          organizationId: actor.organizationId,
          aggregateKind: "incident_report",
          aggregateId: row.id,
          payload: {
            orgId: actor.organizationId,
            incidentId: row.id,
            kind: row.kind,
            severity: row.severity,
            reportedAt: row.reportedAt.toISOString(),
            hasPatientLink: row.patientId !== null,
          },
        });
        await emitIncidentStateChange(tx, actor, row, result.to, at.toISOString());
        return mapIncidentDetail(updated);
      });
    },

    async triageIncident(actor, incidentId, args: TriageIncidentArgs): Promise<IncidentDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new IncidentRepository(tx);
        const row = await loadIncident(tx, actor, incidentId);
        const result = transitionIncident(row.lifecycle, {
          type: "triage",
          kind: row.kind,
          assignedToMembershipId: args.assignedToMembershipId,
        });
        const at = now();
        const updated = await repo.update(row.id, row.occurredAt, {
          lifecycle: result.to,
          severity: args.severity,
          triagedByMembershipId: actor.membershipId,
          triagedAt: at,
          kindData: withSidecar(row, {
            assignedToMembershipId: args.assignedToMembershipId,
            stateHistory: appendHistory(row, result.to, actor, at.toISOString()),
          }),
          updatedAt: at,
          version: row.version + 1,
        });
        await emitIncidentStateChange(tx, actor, row, result.to, at.toISOString());
        return mapIncidentDetail(updated);
      });
    },

    async addIncidentInvestigationNote(
      actor,
      incidentId,
      args: AddInvestigationNoteArgs,
    ): Promise<IncidentInvestigationNoteView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new IncidentRepository(tx);
        const row = await loadIncident(tx, actor, incidentId);
        const note: IncidentInvestigationNoteView = {
          noteId: randomUUID(),
          incidentId: row.id,
          authorMembershipId: actor.membershipId,
          body: args.body,
          createdAt: now().toISOString(),
        };
        await repo.update(row.id, row.occurredAt, {
          kindData: withSidecar(row, {
            investigationNotes: [...(readSidecar(row).investigationNotes ?? []), note],
          }),
          updatedAt: now(),
          version: row.version + 1,
        });
        return note;
      });
    },

    async openIncidentInvestigation(
      actor,
      incidentId,
      args: OpenInvestigationArgs,
    ): Promise<IncidentDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new IncidentRepository(tx);
        const row = await loadIncident(tx, actor, incidentId);
        const result = transitionIncident(row.lifecycle, {
          type: "beginInvestigation",
          kind: row.kind,
        });
        const at = now();
        const capPlan: IncidentCapPlanView = {
          rootCauseSummary: args.rootCauseSummary,
          actions: args.actions.map((a) => ({ ...a, completedAt: null })),
          verificationCriteria: args.verificationCriteria,
        };
        const updated = await repo.update(row.id, row.occurredAt, {
          lifecycle: result.to,
          kindData: withSidecar(row, {
            capPlan,
            stateHistory: appendHistory(row, result.to, actor, at.toISOString()),
          }),
          updatedAt: at,
          version: row.version + 1,
        });
        await emitIncidentStateChange(tx, actor, row, result.to, at.toISOString());
        return mapIncidentDetail(updated);
      });
    },

    async resolveIncident(
      actor,
      incidentId,
      args: ResolveIncidentArgs,
    ): Promise<IncidentDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new IncidentRepository(tx);
        const row = await loadIncident(tx, actor, incidentId);
        const assignedToMembershipId = readSidecar(row).assignedToMembershipId;
        if (!assignedToMembershipId) {
          throw new ConflictError(
            "the incident has no assignee; it must be triaged before it can resolve",
          );
        }
        // The pure machine enforces WF-12 / R-58: the resolver MUST NOT be the assignee (two-person control).
        const result = transitionIncident(row.lifecycle, {
          type: "resolve",
          kind: row.kind,
          assignedToMembershipId,
          resolvedByMembershipId: actor.membershipId,
        });
        const at = now();
        const updated = await repo.update(row.id, row.occurredAt, {
          lifecycle: result.to,
          correctiveActionTakenText: args.resolutionNote,
          kindData: withSidecar(row, {
            capVerifiedByMembershipId: actor.membershipId,
            capVerifiedAt: at.toISOString(),
            stateHistory: appendHistory(row, result.to, actor, at.toISOString()),
          }),
          updatedAt: at,
          version: row.version + 1,
        });
        await emitIncidentStateChange(tx, actor, row, result.to, at.toISOString());
        return mapIncidentDetail(updated);
      });
    },

    async closeIncident(actor, incidentId): Promise<IncidentDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new IncidentRepository(tx);
        const row = await loadIncident(tx, actor, incidentId);
        const result = transitionIncident(row.lifecycle, {
          type: "close",
          kind: row.kind,
          severity: row.severity,
          correctiveActionTextLength: (row.correctiveActionTakenText ?? "").length,
        });
        const at = now();
        const updated = await repo.update(row.id, row.occurredAt, {
          lifecycle: result.to,
          closedAt: at,
          kindData: withSidecar(row, {
            closedByMembershipId: actor.membershipId,
            stateHistory: appendHistory(row, result.to, actor, at.toISOString()),
          }),
          updatedAt: at,
          version: row.version + 1,
        });
        await emitIncidentStateChange(tx, actor, row, result.to, at.toISOString());
        return mapIncidentDetail(updated);
      });
    },

    async reopenIncident(actor, incidentId, args: ReopenIncidentArgs): Promise<IncidentDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new IncidentRepository(tx);
        const row = await loadIncident(tx, actor, incidentId);
        const result = transitionIncident(row.lifecycle, {
          type: "reopen",
          kind: row.kind,
          reopenReasonLength: args.reopenReason.trim().length,
        });
        const at = now();
        const updated = await repo.update(row.id, row.occurredAt, {
          lifecycle: result.to,
          reopenedAt: at,
          reopenReason: args.reopenReason,
          kindData: withSidecar(row, {
            stateHistory: appendHistory(row, result.to, actor, at.toISOString()),
          }),
          updatedAt: at,
          version: row.version + 1,
        });
        await emitIncidentStateChange(tx, actor, row, result.to, at.toISOString());
        return mapIncidentDetail(updated);
      });
    },

    // ── mortality (R-72, R-73) ──
    async updateMortalityReview(
      actor,
      reviewId,
      args: UpdateMortalityReviewArgs,
    ): Promise<MortalityReviewDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new MortalityReviewRepository(tx);
        const row = await loadMortality(tx, actor, reviewId);
        await assertMortalityWriteScope(actor, row);
        const assignedReviewerMembershipId =
          args.assignedToMembershipId ?? row.assignedReviewerMembershipId ?? null;
        let status = row.status;
        if (row.status === "pending" && assignedReviewerMembershipId) {
          // The pure machine gates `start`: a review cannot begin without an assigned reviewer.
          status = transitionMortalityReview(row.status, {
            type: "start",
            hasAssignedReviewer: true,
          }).to;
        }
        const updated = await repo.update(row.id, row.deathAt, {
          status,
          assignedReviewerMembershipId,
          clinicalDimensionData: args.dimensions?.clinical ?? row.clinicalDimensionData,
          satisfactionDimensionData: args.dimensions?.satisfaction ?? row.satisfactionDimensionData,
          complianceDimensionData: args.dimensions?.compliance ?? row.complianceDimensionData,
          updatedAt: now(),
          version: row.version + 1,
        });
        return mapMortality(updated);
      });
    },

    async completeMortalityReview(
      actor,
      reviewId,
      args: CompleteMortalityReviewArgs,
    ): Promise<MortalityReviewDetailView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new MortalityReviewRepository(tx);
        const row = await loadMortality(tx, actor, reviewId);
        await assertMortalityWriteScope(actor, row);
        const dimensionsComplete =
          Object.keys(args.dimensions.clinical).length > 0 &&
          Object.keys(args.dimensions.satisfaction).length > 0 &&
          Object.keys(args.dimensions.compliance).length > 0;
        const at = now();
        // The pure machine gates `complete`: all three dimensions + the reviewer signature must be present;
        // internal-source reviews never gate on the external-source cosign (W-M30-27).
        const result = transitionMortalityReview(row.status, {
          type: "complete",
          dimensionsComplete,
          reviewerSignaturePresent: true,
          externalSourceCosignSatisfied: true,
        });
        const updated = await repo.update(row.id, row.deathAt, {
          status: result.to,
          clinicalDimensionData: args.dimensions.clinical,
          satisfactionDimensionData: args.dimensions.satisfaction,
          complianceDimensionData: args.dimensions.compliance,
          reviewerSignatureAt: at,
          completedAt: at,
          updatedAt: at,
          version: row.version + 1,
        });
        await emit(tx, {
          eventName: "m30.mortality.review_completed",
          organizationId: actor.organizationId,
          aggregateKind: "mortality_review",
          aggregateId: row.id,
          payload: {
            orgId: actor.organizationId,
            reviewId: row.id,
            dimensions: { clinical: "recorded", satisfaction: "recorded", compliance: "recorded" },
          },
        });
        return mapMortality(updated);
      });
    },

    // ── CoP compliance (R-81, R-82) ──
    async updateCopCitation(
      actor,
      citationId,
      args: UpdateCopCitationArgs,
    ): Promise<CopCitationView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new CopComplianceRepository(tx);
        const existing = await repo.findById(citationId);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("cop citation");
        }
        const status = args.status ?? existing.status;
        const row = await repo.update(citationId, {
          status,
          evidenceDocumentIds: args.evidencePointers
            ? [...args.evidencePointers]
            : existing.evidenceDocumentIds,
          updatedAt: now(),
          version: existing.version + 1,
        });
        if (args.status && args.status !== existing.status) {
          await emit(tx, {
            eventName: "m30.cop.status_changed",
            organizationId: actor.organizationId,
            aggregateKind: "cop_compliance_status",
            aggregateId: citationId,
            payload: {
              orgId: actor.organizationId,
              citationId,
              fromStatus: existing.status,
              toStatus: args.status,
              lastReviewedAt: iso(existing.lastReviewedAt),
            },
          });
        }
        return mapCop(row);
      });
    },

    async reviewCopCitation(
      actor,
      citationId,
      args: ReviewCopCitationArgs,
    ): Promise<CopCitationView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new CopComplianceRepository(tx);
        const existing = await repo.findById(citationId);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("cop citation");
        }
        const at = now();
        const row = await repo.update(citationId, {
          lastReviewedAt: at,
          lastReviewedByMembershipId: actor.membershipId,
          nextReviewDueAt: new Date(computeNextReviewDueAt(at)), // WF-17 — 6-month cadence
          selfAssessmentNotes: args.attestation,
          updatedAt: at,
          version: existing.version + 1,
        });
        return mapCop(row);
      });
    },

    // ── infection (R-91, R-93) ──
    async recordInfectionEvent(actor, args: RecordInfectionEventArgs): Promise<InfectionEventView> {
      await assertWritePatientInScope(actor, args.patientId, patientScope);
      return inOrgCtx(actor, async (tx) => {
        const repo = new InfectionRepository(tx);
        const providerEntityId = await resolveProviderEntityForSubject(
          providerEntity,
          tx,
          actor.organizationId,
          args.patientId,
        );
        const pathogen = normalizePathogen(args.pathogen);
        const bodySite = normalizeBodySite(args.bodySite);
        const observedAt = new Date(args.observedAt);
        const row = await repo.insertEvent({
          organizationId: actor.organizationId,
          providerEntityId,
          patientId: args.patientId,
          observedAt,
          pathogen,
          bodySite,
          transmissionContext: "unknown",
          filedByMembershipId: actor.membershipId,
        });
        await emit(tx, {
          eventName: "m30.infection.event_recorded",
          organizationId: actor.organizationId,
          aggregateKind: "infection_surveillance_event",
          aggregateId: row.id,
          payload: {
            orgId: actor.organizationId,
            eventId: row.id,
            pathogen,
            bodySite,
            patientId: args.patientId,
          },
        });
        // §7.8 inline outbreak detection: ≥3 events sharing (provider, pathogen, body_site) in any 14d window.
        let outbreakCaseId: string | null = null;
        const windowStart = new Date(observedAt.getTime() - 14 * 24 * 60 * 60 * 1000);
        const windowRows = await repo.listEventsForOutbreakWindow(
          providerEntityId,
          pathogen,
          bodySite,
          windowStart,
          observedAt,
        );
        const clusters = detectOutbreakClusters(windowRows.map(normalizeSurveillanceRow));
        const cluster = clusters[0];
        if (cluster) {
          const outbreak = await repo.createOutbreak(toNewOutbreakCase(cluster));
          outbreakCaseId = outbreak.id;
          await emit(tx, {
            eventName: "m30.infection.outbreak_opened",
            organizationId: actor.organizationId,
            aggregateKind: "infection_outbreak_case",
            aggregateId: outbreak.id,
            payload: {
              orgId: actor.organizationId,
              caseId: outbreak.id,
              pathogen: outbreak.pathogen,
              bodySite: outbreak.bodySite,
              eventCount: outbreak.triggeringEventCount,
              firstEventAt: outbreak.windowStart.toISOString(),
              lastEventAt: outbreak.windowEnd.toISOString(),
            },
          });
        }
        return {
          eventId: row.id,
          organizationId: row.organizationId,
          patientId: row.patientId ?? "",
          pathogen: row.pathogen,
          bodySite: row.bodySite,
          observedAt: row.observedAt.toISOString(),
          filedByMembershipId: row.filedByMembershipId,
          outbreakCaseId,
        };
      });
    },

    async updateInfectionOutbreak(
      actor,
      caseId,
      args: UpdateInfectionOutbreakArgs,
    ): Promise<InfectionOutbreakView> {
      return inOrgCtx(actor, async (tx) => {
        const repo = new InfectionRepository(tx);
        const existing = await repo.findOutbreakById(caseId);
        if (!existing || existing.organizationId !== actor.organizationId) {
          throw new NotFoundError("infection outbreak case");
        }
        const status = outbreakStatusToSchema(args.status);
        const at = now();
        const row = await repo.updateOutbreak(caseId, {
          status,
          idgReviewedAt: status === "idg_reviewed" ? at : existing.idgReviewedAt,
          containedAt: status === "contained" ? at : existing.containedAt,
          containedAttestationMembershipId:
            status === "contained" ? actor.membershipId : existing.containedAttestationMembershipId,
          closedAt: status === "closed" ? at : existing.closedAt,
        });
        if (args.status === "resolved") {
          await emit(tx, {
            eventName: "m30.infection.outbreak_resolved",
            organizationId: actor.organizationId,
            aggregateKind: "infection_outbreak_case",
            aggregateId: caseId,
            payload: {
              orgId: actor.organizationId,
              caseId,
              resolutionNote: args.resolutionNote ?? "",
              resolvedAt: at.toISOString(),
            },
          });
        }
        return mapOutbreak(row);
      });
    },

    // ── risk register (R-96) ──
    async refreshRiskRegister(actor): Promise<RiskRegisterRefreshAcceptedView> {
      // The payload MUST match `RiskRegisterRefreshJob` (organizationId + force) — the worker reads these
      // exact field names off `job.data`, not `orgId` (WX-PR-014: this mismatch meant every R-96-triggered
      // refresh would have failed with `organizationId` undefined the moment the worker actually ran; no
      // live test had ever exercised this route end-to-end before).
      const { jobId } = await recompute.enqueue(
        "m30.risk_register_refresh",
        `${actor.organizationId}:risk_register`,
        {
          jobId: `${actor.organizationId}:risk_register`,
          organizationId: actor.organizationId,
          force: true,
        },
      );
      return { jobId, enqueuedAt: now().toISOString() };
    },
  };

  return service;
}
