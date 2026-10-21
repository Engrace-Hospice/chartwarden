import type {
  AiEvaluationRunPatch,
  AiEvaluationRunSnapshot,
  AiHallucinationFilingPatch,
  AiHallucinationTriagePatch,
  AiKillSwitchActivationPatch,
  AiKillSwitchDeactivationPatch,
  AiKillSwitchRowSnapshot,
} from "@chartwarden/ai-platform";
// apps/backend/src/modules/32-ai-platform/safety/store.ts — the data PORTS M32-T05's safety services
// compose over, plus in-memory implementations for the slice tests.
//
// THREE PORTS, SPLIT BY CREDENTIAL — the M32-T03/T04 posture, continued:
//
//   · `AiKillSwitchStore`         — `ai_kill_switch_state` is M32's ONE mixed-scope table, and the split
//     is what the port has to encode. 0116 gives `chartwarden_app` a SELECT policy that admits the platform
//     row plus the caller's own, but INSERT/UPDATE policies that admit ONLY the caller's own — so a
//     PLATFORM-scoped write has to run on the platform credential. `activate`/`deactivate` therefore
//     take the scope from the row (`organizationId === null`), never from an argument the caller could
//     get wrong: a tenant admin able to mint a NULL-org row would stop the capability for every other
//     agency on the platform.
//   · `AiHallucinationReportStore` — `ai_hallucination_report` is TENANT-SCOPED and PHI-bearing (the
//     narrative quotes what the model said about a patient). Every method opens `withOrgContext`.
//   · `AiEvaluationRunStore`      — `ai_evaluation_run` is PLATFORM-SHARED: reads on the tenant handle
//     (`ai_evaluation_run_read` is `USING (true)`), writes under the audited platform bypass.
//
// TIMESTAMPS CROSS THE PORT AS ISO STRINGS, so the in-memory store and the Drizzle one stay
// structurally identical and the slice tests keep proving something about the real table.
import type {
  AiEvaluationRunDecision,
  AiEvaluationRunStage,
  AiEvaluationRunStatus,
  AiHallucinationKind,
  AiHallucinationSeverity,
  AiHallucinationTriageDisposition,
  AiHallucinationTriageStatus,
  AiKillSwitchActorKind,
  AiKillSwitchReason,
} from "@chartwarden/types";

// ── projections ────────────────────────────────────────────────────────────────────────────────────

/** An `ai_hallucination_report` row as the §5.1.5 triage queue reads it.
 *
 *  `reporterNarrativeCipher` is DELIBERATELY ABSENT from the projection: the queue lists reports, and a
 *  list endpoint that carried every DEK envelope would decrypt PHI to render a count. The detail route
 *  (T07) fetches the cipher explicitly. */
export interface AiHallucinationReportRowProjection {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly invocationId: string | null;
  readonly capabilityId: string;
  readonly reporterMembershipId: string;
  readonly reporterRole: string;
  readonly severity: AiHallucinationSeverity;
  readonly hallucinationKind: AiHallucinationKind;
  readonly triageStatus: AiHallucinationTriageStatus;
  readonly triageOwnerMembershipId: string | null;
  readonly triageDisposition: AiHallucinationTriageDisposition | null;
  readonly mitigationActionRef: string | null;
  readonly reportedAt: string;
  readonly triagedAt: string | null;
  readonly closedAt: string | null;
}

/** What R18 writes. The narrative arrives already DEK-encrypted (§3.6). */
export interface AiHallucinationReportInsert {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly invocationId: string | null;
  readonly capabilityId: string;
  readonly reporterMembershipId: string;
  readonly reporterRole: string;
  readonly severity: AiHallucinationSeverity;
  readonly hallucinationKind: AiHallucinationKind;
  readonly reporterNarrativeCipher: Uint8Array;
  readonly patch: AiHallucinationFilingPatch;
}

/** What R26 writes when an evaluation run is queued. */
export interface AiEvaluationRunInsert {
  readonly capabilityId: string;
  readonly backendId: string;
  readonly datasetVersionRef: string;
  readonly mlflowRunId: string;
  readonly stage: AiEvaluationRunStage;
  readonly summaryMetrics: Record<string, unknown>;
  readonly initiatedByMembershipId: string;
  /** Passed explicitly rather than left to the column default, so the in-memory store and the Drizzle
   *  one produce the same row and the slice tests keep proving something about the real table. */
  readonly createdAt: string;
}

/** An `ai_evaluation_run` row as §5.1.7 reads it. */
export interface AiEvaluationRunRowProjection extends AiEvaluationRunSnapshot {
  readonly datasetVersionRef: string;
  readonly mlflowRunId: string;
  readonly summaryMetrics: Record<string, unknown>;
  readonly initiatedByMembershipId: string;
  readonly createdAt: string;
}

/** A kill-switch row plus the columns §5.1.3's dashboard needs beyond the gate's snapshot. */
export interface AiKillSwitchRowProjection extends AiKillSwitchRowSnapshot {
  readonly deactivationActorKind: AiKillSwitchActorKind | null;
  readonly deactivationActorMembershipId: string | null;
  readonly deactivationMessage: string | null;
  readonly deactivatedAt: string | null;
}

// ── ports ──────────────────────────────────────────────────────────────────────────────────────────

/** `ai_kill_switch_state`, mixed-scope (see the header). */
export interface AiKillSwitchStore {
  /**
   * Every row for the capability the caller may see: the platform row plus the caller's own.
   *
   * Returns BOTH rather than a resolved boolean, because `aiKillSwitchFor` has to OR them and name
   * which one decided — a store that pre-collapsed them would take that decision away from the rule
   * that documents it.
   */
  findForCapability(
    organizationId: string,
    capabilityId: string,
  ): Promise<readonly AiKillSwitchRowSnapshot[]>;
  /** The row for exactly one scope. `organizationId: null` is the platform row. */
  findScopedRow(
    organizationId: string | null,
    capabilityId: string,
  ): Promise<AiKillSwitchRowSnapshot | null>;
  /** Upsert-then-patch: §3.2.12's two partial unique indexes make (scope, capability) at most one row,
   *  and a deactivated row is KEPT (the incident record), so activation writes to the existing row when
   *  there is one. */
  activate(
    organizationId: string | null,
    capabilityId: string,
    patch: AiKillSwitchActivationPatch,
  ): Promise<AiKillSwitchRowProjection>;
  deactivate(
    organizationId: string | null,
    capabilityId: string,
    patch: AiKillSwitchDeactivationPatch,
  ): Promise<AiKillSwitchRowProjection>;
  /** R9's dashboard: every ACTIVE row the caller may see (platform + own). */
  listActive(organizationId: string): Promise<readonly AiKillSwitchRowProjection[]>;
  /** Every ACTIVE row platform-wide — the §4.8 broadcast cache's warm-up. Platform credential. */
  listAllActive(): Promise<readonly AiKillSwitchRowProjection[]>;
}

/** `ai_hallucination_report`, tenant-scoped. */
export interface AiHallucinationReportStore {
  insertReport(insert: AiHallucinationReportInsert): Promise<AiHallucinationReportRowProjection>;
  findReport(
    organizationId: string,
    reportId: string,
  ): Promise<AiHallucinationReportRowProjection | null>;
  /** R19's queue. `statuses` empty = every status. */
  listReports(
    organizationId: string,
    filter?: {
      readonly statuses?: readonly AiHallucinationTriageStatus[];
      readonly capabilityId?: string;
    },
  ): Promise<readonly AiHallucinationReportRowProjection[]>;
  applyTriage(
    organizationId: string,
    reportId: string,
    patch: AiHallucinationTriagePatch,
  ): Promise<AiHallucinationReportRowProjection>;
}

/** `ai_evaluation_run`, platform-shared. */
export interface AiEvaluationRunStore {
  insertRun(insert: AiEvaluationRunInsert): Promise<AiEvaluationRunRowProjection>;
  findRun(runId: string): Promise<AiEvaluationRunRowProjection | null>;
  listRuns(filter?: {
    readonly capabilityId?: string;
    readonly statuses?: readonly AiEvaluationRunStatus[];
  }): Promise<readonly AiEvaluationRunRowProjection[]>;
  applyTransition(
    runId: string,
    patch: AiEvaluationRunPatch,
  ): Promise<AiEvaluationRunRowProjection>;
}

// ── in-memory implementation (slice tests) ─────────────────────────────────────────────────────────

/** Seed for {@link createInMemoryAiSafetyStores}. */
export interface InMemoryAiSafetySeed {
  readonly killSwitches?: readonly AiKillSwitchRowProjection[];
  readonly reports?: readonly (AiHallucinationReportRowProjection & {
    readonly reporterNarrativeCipher?: Uint8Array;
  })[];
  readonly evaluationRuns?: readonly AiEvaluationRunRowProjection[];
}

let inMemorySequence = 0;
function nextId(prefix: string): string {
  inMemorySequence += 1;
  return `${prefix}-${String(inMemorySequence).padStart(6, "0")}`;
}

/**
 * In-memory safety stores.
 *
 * Holds the invariants a naive fake would break and then "pass" on: at most one row per
 * (scope, capability) — §3.2.12's two partial unique indexes — and a deactivated row that KEEPS its
 * activation attribution, which is the incident record the post-mortem reads.
 */
export function createInMemoryAiSafetyStores(seed: InMemoryAiSafetySeed = {}): {
  killSwitches: AiKillSwitchStore;
  reports: AiHallucinationReportStore;
  evaluations: AiEvaluationRunStore;
  killSwitchRows: AiKillSwitchRowProjection[];
  reportRows: (AiHallucinationReportRowProjection & { reporterNarrativeCipher: Uint8Array })[];
  evaluationRows: AiEvaluationRunRowProjection[];
} {
  const killSwitchRows: AiKillSwitchRowProjection[] = [...(seed.killSwitches ?? [])];
  const reportRows: (AiHallucinationReportRowProjection & {
    reporterNarrativeCipher: Uint8Array;
  })[] = (seed.reports ?? []).map((r) => ({
    ...r,
    reporterNarrativeCipher: r.reporterNarrativeCipher ?? new Uint8Array([1]),
  }));
  const evaluationRows: AiEvaluationRunRowProjection[] = [...(seed.evaluationRuns ?? [])];

  function scopedIndex(organizationId: string | null, capabilityId: string): number {
    return killSwitchRows.findIndex(
      (r) => r.organizationId === organizationId && r.capabilityId === capabilityId,
    );
  }

  const killSwitches: AiKillSwitchStore = {
    findForCapability: async (organizationId, capabilityId) =>
      killSwitchRows.filter(
        (r) =>
          r.capabilityId === capabilityId &&
          (r.organizationId === null || r.organizationId === organizationId),
      ),
    findScopedRow: async (organizationId, capabilityId) => {
      const i = scopedIndex(organizationId, capabilityId);
      return i === -1 ? null : killSwitchRows[i]!;
    },
    activate: async (organizationId, capabilityId, patch) => {
      const i = scopedIndex(organizationId, capabilityId);
      const base: AiKillSwitchRowProjection =
        i === -1
          ? {
              id: nextId("aks"),
              organizationId,
              capabilityId,
              active: false,
              reason: null,
              activationActorKind: null,
              activationActorMembershipId: null,
              activationMessage: null,
              activatedAt: null,
              deactivationActorKind: null,
              deactivationActorMembershipId: null,
              deactivationMessage: null,
              deactivatedAt: null,
            }
          : killSwitchRows[i]!;
      const next: AiKillSwitchRowProjection = { ...base, ...patch };
      if (i === -1) killSwitchRows.push(next);
      else killSwitchRows[i] = next;
      return next;
    },
    deactivate: async (organizationId, capabilityId, patch) => {
      const i = scopedIndex(organizationId, capabilityId);
      if (i === -1) {
        throw new Error(
          `in-memory ai_kill_switch_state has no ${organizationId === null ? "platform" : "tenant"} row for capability ${capabilityId}`,
        );
      }
      // The activation half is left alone on purpose — see the port's header.
      const next: AiKillSwitchRowProjection = { ...killSwitchRows[i]!, ...patch };
      killSwitchRows[i] = next;
      return next;
    },
    listActive: async (organizationId) =>
      killSwitchRows.filter(
        (r) => r.active && (r.organizationId === null || r.organizationId === organizationId),
      ),
    listAllActive: async () => killSwitchRows.filter((r) => r.active),
  };

  const reports: AiHallucinationReportStore = {
    insertReport: async (insert) => {
      const row: AiHallucinationReportRowProjection & { reporterNarrativeCipher: Uint8Array } = {
        id: nextId("ahr"),
        organizationId: insert.organizationId,
        providerEntityId: insert.providerEntityId,
        locationId: insert.locationId,
        invocationId: insert.invocationId,
        capabilityId: insert.capabilityId,
        reporterMembershipId: insert.reporterMembershipId,
        reporterRole: insert.reporterRole,
        severity: insert.severity,
        hallucinationKind: insert.hallucinationKind,
        reporterNarrativeCipher: insert.reporterNarrativeCipher,
        triageStatus: insert.patch.triageStatus,
        triageOwnerMembershipId: insert.patch.triageOwnerMembershipId,
        triageDisposition: insert.patch.triageDisposition,
        mitigationActionRef: insert.patch.mitigationActionRef,
        reportedAt: insert.patch.reportedAt,
        triagedAt: null,
        closedAt: null,
      };
      reportRows.push(row);
      return row;
    },
    findReport: async (organizationId, reportId) =>
      reportRows.find((r) => r.id === reportId && r.organizationId === organizationId) ?? null,
    listReports: async (organizationId, filter) =>
      reportRows.filter(
        (r) =>
          r.organizationId === organizationId &&
          (filter?.statuses === undefined ||
            filter.statuses.length === 0 ||
            filter.statuses.includes(r.triageStatus)) &&
          (filter?.capabilityId === undefined || r.capabilityId === filter.capabilityId),
      ),
    applyTriage: async (organizationId, reportId, patch) => {
      const i = reportRows.findIndex(
        (r) => r.id === reportId && r.organizationId === organizationId,
      );
      if (i === -1) {
        throw new Error(
          `in-memory ai_hallucination_report ${reportId} not found for org ${organizationId}`,
        );
      }
      const next = { ...reportRows[i]!, ...patch };
      reportRows[i] = next;
      return next;
    },
  };

  const evaluations: AiEvaluationRunStore = {
    insertRun: async (insert) => {
      const row: AiEvaluationRunRowProjection = {
        id: nextId("aer"),
        capabilityId: insert.capabilityId,
        backendId: insert.backendId,
        datasetVersionRef: insert.datasetVersionRef,
        mlflowRunId: insert.mlflowRunId,
        stage: insert.stage,
        summaryMetrics: insert.summaryMetrics,
        status: "pending",
        decision: "no_decision",
        initiatedByMembershipId: insert.initiatedByMembershipId,
        startedAt: null,
        completedAt: null,
        createdAt: insert.createdAt,
      };
      evaluationRows.push(row);
      return row;
    },
    findRun: async (runId) => evaluationRows.find((r) => r.id === runId) ?? null,
    listRuns: async (filter) =>
      evaluationRows.filter(
        (r) =>
          (filter?.capabilityId === undefined || r.capabilityId === filter.capabilityId) &&
          (filter?.statuses === undefined ||
            filter.statuses.length === 0 ||
            filter.statuses.includes(r.status)),
      ),
    applyTransition: async (runId, patch) => {
      const i = evaluationRows.findIndex((r) => r.id === runId);
      if (i === -1) throw new Error(`in-memory ai_evaluation_run ${runId} not found`);
      const next: AiEvaluationRunRowProjection = {
        ...evaluationRows[i]!,
        ...patch,
        summaryMetrics: patch.summaryMetrics ?? evaluationRows[i]!.summaryMetrics,
      };
      evaluationRows[i] = next;
      return next;
    },
  };

  return {
    killSwitches,
    reports,
    evaluations,
    killSwitchRows,
    reportRows,
    evaluationRows,
  };
}

/** Re-exported so a test seeding the safety stores needs one import. */
export type {
  AiEvaluationRunSnapshot,
  AiKillSwitchActorKind,
  AiKillSwitchReason,
  AiKillSwitchRowSnapshot,
  AiEvaluationRunDecision,
};
