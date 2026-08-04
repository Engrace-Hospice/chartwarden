// apps/backend/src/modules/32-ai-platform/safety/store-drizzle.ts — the Drizzle implementations of
// M32-T05's safety stores.
//
// ── THE CREDENTIAL SPLIT, AND WHY THE KILL SWITCH IS THE HARD ONE ─────────────────────────────────
//
// `ai_kill_switch_state` is M32's only mixed-scope table and 0116 splits its policies BY COMMAND:
// `wardenx_app` may SELECT the platform row plus its own, but may INSERT/UPDATE only rows carrying its
// own org. So:
//
//   · a TENANT-scoped write runs `withOrgContext` on the ordinary handle — RLS is what keeps one
//     agency's pause out of the next agency's row;
//   · a PLATFORM-scoped write (organization_id IS NULL) CANNOT run there at all. It runs under
//     `withPlatformContext` on the separately-pooled admin credential, allowlisted by
//     `M32_PLATFORM_JOB_ID` and audited by the `platform.bypass_invoked` auditor — and its `crossTenant`
//     flag is TRUE, unlike M32's governance writes, because a platform-wide kill changes what every
//     tenant on the platform may do. That is the one M32 bypass an operator should be paged about.
//   · READS take the ordinary handle: `ai_kill_switch_read` already admits the platform row, so opening
//     an audited bypass to answer a question a tenant connection can answer would put a
//     `platform.bypass_invoked` row in front of every invocation gate evaluation.
//
// `listAllActive` is the exception among reads — it deliberately crosses tenants (the §4.8 broadcast
// cache's warm-up needs every active row, including other tenants'), so it takes the bypass.
//
// `ai_hallucination_report` is org-scoped: EVERY method opens `withOrgContext`, and no method takes an
// org id it does not also pin into the session variable. `ai_evaluation_run` is platform-shared: reads
// on the tenant handle (`ai_evaluation_run_read` is `USING (true)`), writes under the audited bypass.
import { type DbClient, schema } from "@wardenx/db";
import { type PlatformBypassAuditor, withOrgContext, withPlatformContext } from "@wardenx/tenancy";
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
} from "@wardenx/types";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import type {
  AiEvaluationRunRowProjection,
  AiEvaluationRunStore,
  AiHallucinationReportRowProjection,
  AiHallucinationReportStore,
  AiKillSwitchRowProjection,
  AiKillSwitchStore,
} from "./store";

type KillSwitchSelect = typeof schema.aiKillSwitchState.$inferSelect;
type ReportSelect = typeof schema.aiHallucinationReport.$inferSelect;
type EvaluationSelect = typeof schema.aiEvaluationRun.$inferSelect;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toKillSwitchRow(row: KillSwitchSelect): AiKillSwitchRowProjection {
  return {
    id: row.id,
    organizationId: row.organizationId,
    capabilityId: row.capabilityId,
    active: row.active,
    reason: row.reason as AiKillSwitchReason | null,
    activationActorKind: row.activationActorKind as AiKillSwitchActorKind | null,
    activationActorMembershipId: row.activationActorMembershipId,
    activationMessage: row.activationMessage,
    activatedAt: iso(row.activatedAt),
    deactivationActorKind: row.deactivationActorKind as AiKillSwitchActorKind | null,
    deactivationActorMembershipId: row.deactivationActorMembershipId,
    deactivationMessage: row.deactivationMessage,
    deactivatedAt: iso(row.deactivatedAt),
  };
}

function toReportRow(row: ReportSelect): AiHallucinationReportRowProjection {
  return {
    id: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
    invocationId: row.invocationId,
    capabilityId: row.capabilityId,
    reporterMembershipId: row.reporterMembershipId,
    reporterRole: row.reporterRole,
    severity: row.severity as AiHallucinationSeverity,
    hallucinationKind: row.hallucinationKind as AiHallucinationKind,
    triageStatus: row.triageStatus as AiHallucinationTriageStatus,
    triageOwnerMembershipId: row.triageOwnerMembershipId,
    triageDisposition: row.triageDisposition as AiHallucinationTriageDisposition | null,
    mitigationActionRef: row.mitigationActionRef,
    reportedAt: isoRequired(row.reportedAt),
    triagedAt: iso(row.triagedAt),
    closedAt: iso(row.closedAt),
  };
}

function toEvaluationRow(row: EvaluationSelect): AiEvaluationRunRowProjection {
  return {
    id: row.id,
    capabilityId: row.capabilityId,
    backendId: row.backendId,
    datasetVersionRef: row.datasetVersionRef,
    mlflowRunId: row.mlflowRunId,
    stage: row.stage as AiEvaluationRunStage,
    summaryMetrics: (row.summaryMetrics ?? {}) as Record<string, unknown>,
    status: row.status as AiEvaluationRunStatus,
    decision: row.decision as AiEvaluationRunDecision,
    initiatedByMembershipId: row.initiatedByMembershipId,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    createdAt: isoRequired(row.createdAt),
  };
}

/** What the mixed-scope and platform-shared stores need to open their audited bypass. */
export interface AiSafetyStoreDeps {
  /** The ORDINARY tenant handle. */
  readonly db: DbClient;
  /** The separately-pooled platform login role. */
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  /** The allowlisted job id (`M32_PLATFORM_JOB_ID`; `wireM32Tenancy()` registered it). */
  readonly jobId: string;
  /** `app.user_id` for the session; the M4 write-audit trigger reads it. */
  readonly userId: string;
}

/** `ai_kill_switch_state` — the mixed-scope store (see the header). */
export function createDrizzleAiKillSwitchStore(deps: AiSafetyStoreDeps): AiKillSwitchStore {
  const ctx = (organizationId: string) => ({ organizationId, userId: deps.userId });

  function asPlatform<T>(reason: string, fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return withPlatformContext<DbClient, T>(
      deps.platformDb,
      // `crossTenant: true` — unlike M32's governance writes, a platform-wide kill changes what EVERY
      // tenant may do. Marking it routine would bury the one M32 bypass that warrants a page.
      { jobId: deps.jobId, reason, crossTenant: true },
      deps.auditBypass,
      fn,
    );
  }

  const scoped = (organizationId: string | null, capabilityId: string) =>
    and(
      eq(schema.aiKillSwitchState.capabilityId, capabilityId),
      organizationId === null
        ? isNull(schema.aiKillSwitchState.organizationId)
        : eq(schema.aiKillSwitchState.organizationId, organizationId),
    );

  return {
    findForCapability: (organizationId, capabilityId) =>
      withOrgContext(deps.db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select()
          .from(schema.aiKillSwitchState)
          .where(eq(schema.aiKillSwitchState.capabilityId, capabilityId));
        // RLS already restricts this to the platform row plus the caller's own; the projection is a
        // straight map, and `aiKillSwitchFor` does the OR.
        return rows.map(toKillSwitchRow);
      }),

    findScopedRow: async (organizationId, capabilityId) => {
      const read = async (tx: DbClient) => {
        const [row] = await tx
          .select()
          .from(schema.aiKillSwitchState)
          .where(scoped(organizationId, capabilityId))
          .limit(1);
        return row ? toKillSwitchRow(row) : null;
      };
      // A tenant read pins its org; the PLATFORM row is visible to every tenant connection under
      // `ai_kill_switch_read`, but there is no org to pin when the caller is asking about the platform
      // row alone (the §4.8 worker, R7's platform branch) — so that read takes the platform handle.
      return organizationId === null
        ? asPlatform(`read platform kill switch for capability ${capabilityId}`, read)
        : withOrgContext(deps.db, ctx(organizationId), read);
    },

    activate: async (organizationId, capabilityId, patch) => {
      const write = async (tx: DbClient) => {
        const [updated] = await tx
          .update(schema.aiKillSwitchState)
          .set({
            active: patch.active,
            reason: patch.reason,
            activationActorKind: patch.activationActorKind,
            activationActorMembershipId: patch.activationActorMembershipId,
            activationMessage: patch.activationMessage,
            activatedAt: new Date(patch.activatedAt),
            deactivationActorKind: patch.deactivationActorKind,
            deactivationActorMembershipId: patch.deactivationActorMembershipId,
            deactivationMessage: patch.deactivationMessage,
            deactivatedAt: patch.deactivatedAt,
            updatedAt: new Date(patch.activatedAt),
          })
          .where(scoped(organizationId, capabilityId))
          .returning();
        if (updated) return toKillSwitchRow(updated);
        // No row yet for this scope. §3.2.12's two partial unique indexes make the pair at most one
        // row, so an INSERT here cannot race a second platform kill into existence.
        const [inserted] = await tx
          .insert(schema.aiKillSwitchState)
          .values({
            organizationId,
            capabilityId,
            active: patch.active,
            reason: patch.reason,
            activationActorKind: patch.activationActorKind,
            activationActorMembershipId: patch.activationActorMembershipId,
            activationMessage: patch.activationMessage,
            activatedAt: new Date(patch.activatedAt),
          })
          .returning();
        if (!inserted)
          throw new Error(`ai_kill_switch_state insert returned no row for ${capabilityId}`);
        return toKillSwitchRow(inserted);
      };
      return organizationId === null
        ? asPlatform(
            `activate platform-wide AI kill switch for capability ${capabilityId} (W3/R7)`,
            write,
          )
        : withOrgContext(deps.db, ctx(organizationId), write);
    },

    deactivate: async (organizationId, capabilityId, patch) => {
      const write = async (tx: DbClient) => {
        const [row] = await tx
          .update(schema.aiKillSwitchState)
          .set({
            active: patch.active,
            deactivationActorKind: patch.deactivationActorKind,
            deactivationActorMembershipId: patch.deactivationActorMembershipId,
            deactivationMessage: patch.deactivationMessage,
            deactivatedAt: new Date(patch.deactivatedAt),
            updatedAt: new Date(patch.deactivatedAt),
          })
          .where(scoped(organizationId, capabilityId))
          .returning();
        if (!row) {
          throw new Error(
            `ai_kill_switch_state has no ${organizationId === null ? "platform" : "tenant"} row for capability ${capabilityId}`,
          );
        }
        return toKillSwitchRow(row);
      };
      return organizationId === null
        ? asPlatform(`lift platform-wide AI kill switch for capability ${capabilityId} (R8)`, write)
        : withOrgContext(deps.db, ctx(organizationId), write);
    },

    listActive: (organizationId) =>
      withOrgContext(deps.db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select()
          .from(schema.aiKillSwitchState)
          .where(eq(schema.aiKillSwitchState.active, true))
          .orderBy(desc(schema.aiKillSwitchState.activatedAt));
        return rows.map(toKillSwitchRow);
      }),

    listAllActive: () =>
      asPlatform("warm the AI kill-switch cache with every active row (§4.8)", async (tx) => {
        const rows = await tx
          .select()
          .from(schema.aiKillSwitchState)
          .where(eq(schema.aiKillSwitchState.active, true))
          .orderBy(desc(schema.aiKillSwitchState.activatedAt));
        return rows.map(toKillSwitchRow);
      }),
  };
}

/** `ai_hallucination_report` — tenant-scoped, PHI-bearing. Every method pins `app.org_id`. */
export function createDrizzleAiHallucinationReportStore(deps: {
  readonly db: DbClient;
  /** `app.user_id` for the session; the M4 write-audit trigger reads it. */
  readonly userId: string;
}): AiHallucinationReportStore {
  const db = deps.db;
  const ctx = (organizationId: string) => ({ organizationId, userId: deps.userId });
  return {
    insertReport: (insert) =>
      withOrgContext(db, ctx(insert.organizationId), async (tx) => {
        const [row] = await tx
          .insert(schema.aiHallucinationReport)
          .values({
            organizationId: insert.organizationId,
            providerEntityId: insert.providerEntityId,
            locationId: insert.locationId,
            invocationId: insert.invocationId,
            capabilityId: insert.capabilityId,
            reporterMembershipId: insert.reporterMembershipId,
            reporterRole: insert.reporterRole,
            severity: insert.severity,
            hallucinationKind: insert.hallucinationKind,
            reporterNarrativeCipher: Buffer.from(insert.reporterNarrativeCipher),
            triageStatus: insert.patch.triageStatus,
            triageOwnerMembershipId: insert.patch.triageOwnerMembershipId,
            triageDisposition: insert.patch.triageDisposition,
            mitigationActionRef: insert.patch.mitigationActionRef,
            reportedAt: new Date(insert.patch.reportedAt),
          })
          .returning();
        if (!row) throw new Error("ai_hallucination_report insert returned no row");
        return toReportRow(row);
      }),

    findReport: (organizationId, reportId) =>
      withOrgContext(db, ctx(organizationId), async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.aiHallucinationReport)
          .where(eq(schema.aiHallucinationReport.id, reportId))
          .limit(1);
        return row ? toReportRow(row) : null;
      }),

    listReports: (organizationId, filter) =>
      withOrgContext(db, ctx(organizationId), async (tx) => {
        const clauses = [];
        if (filter?.statuses !== undefined && filter.statuses.length > 0) {
          clauses.push(inArray(schema.aiHallucinationReport.triageStatus, [...filter.statuses]));
        }
        if (filter?.capabilityId !== undefined) {
          clauses.push(eq(schema.aiHallucinationReport.capabilityId, filter.capabilityId));
        }
        const rows = await tx
          .select()
          .from(schema.aiHallucinationReport)
          .where(clauses.length === 0 ? undefined : and(...clauses))
          .orderBy(desc(schema.aiHallucinationReport.reportedAt));
        return rows.map(toReportRow);
      }),

    applyTriage: (organizationId, reportId, patch) =>
      withOrgContext(db, ctx(organizationId), async (tx) => {
        const [row] = await tx
          .update(schema.aiHallucinationReport)
          .set({
            triageStatus: patch.triageStatus,
            severity: patch.severity,
            triageOwnerMembershipId: patch.triageOwnerMembershipId,
            triageDisposition: patch.triageDisposition,
            mitigationActionRef: patch.mitigationActionRef,
            triagedAt: new Date(patch.triagedAt),
            closedAt: patch.closedAt === null ? null : new Date(patch.closedAt),
          })
          .where(eq(schema.aiHallucinationReport.id, reportId))
          .returning();
        if (!row)
          throw new Error(
            `ai_hallucination_report ${reportId} not found for org ${organizationId}`,
          );
        return toReportRow(row);
      }),
  };
}

/** `ai_evaluation_run` — platform-shared: reads on the tenant handle, writes under the audited bypass. */
export function createDrizzleAiEvaluationRunStore(deps: AiSafetyStoreDeps): AiEvaluationRunStore {
  function asPlatform<T>(reason: string, fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return withPlatformContext<DbClient, T>(
      deps.platformDb,
      // `crossTenant: false` — an evaluation run is performed against the model on a held-out dataset,
      // not inside any tenant's data. The bypass is a privilege escalation, not a boundary crossing.
      { jobId: deps.jobId, reason, crossTenant: false },
      deps.auditBypass,
      fn,
    );
  }

  return {
    insertRun: (insert) =>
      asPlatform(
        `queue AI evaluation run for capability ${insert.capabilityId} (R26/W6)`,
        async (tx) => {
          const [row] = await tx
            .insert(schema.aiEvaluationRun)
            .values({
              capabilityId: insert.capabilityId,
              backendId: insert.backendId,
              datasetVersionRef: insert.datasetVersionRef,
              mlflowRunId: insert.mlflowRunId,
              stage: insert.stage,
              summaryMetrics: insert.summaryMetrics,
              status: "pending",
              decision: "no_decision",
              initiatedByMembershipId: insert.initiatedByMembershipId,
              createdAt: new Date(insert.createdAt),
            })
            .returning();
          if (!row) throw new Error("ai_evaluation_run insert returned no row");
          return toEvaluationRow(row);
        },
      ),

    findRun: async (runId) => {
      const [row] = await deps.db
        .select()
        .from(schema.aiEvaluationRun)
        .where(eq(schema.aiEvaluationRun.id, runId))
        .limit(1);
      return row ? toEvaluationRow(row) : null;
    },

    listRuns: async (filter) => {
      const clauses = [];
      if (filter?.capabilityId !== undefined) {
        clauses.push(eq(schema.aiEvaluationRun.capabilityId, filter.capabilityId));
      }
      if (filter?.statuses !== undefined && filter.statuses.length > 0) {
        clauses.push(inArray(schema.aiEvaluationRun.status, [...filter.statuses]));
      }
      const rows = await deps.db
        .select()
        .from(schema.aiEvaluationRun)
        .where(clauses.length === 0 ? undefined : and(...clauses))
        .orderBy(desc(schema.aiEvaluationRun.createdAt));
      return rows.map(toEvaluationRow);
    },

    applyTransition: (runId, patch) =>
      asPlatform(`record AI evaluation run ${runId} -> ${patch.status} (W6)`, async (tx) => {
        const [row] = await tx
          .update(schema.aiEvaluationRun)
          .set({
            status: patch.status,
            decision: patch.decision,
            ...(patch.summaryMetrics === null ? {} : { summaryMetrics: patch.summaryMetrics }),
            startedAt: patch.startedAt === null ? null : new Date(patch.startedAt),
            completedAt: patch.completedAt === null ? null : new Date(patch.completedAt),
          })
          .where(eq(schema.aiEvaluationRun.id, runId))
          .returning();
        if (!row) throw new Error(`ai_evaluation_run ${runId} not found`);
        return toEvaluationRow(row);
      }),
  };
}
