// apps/backend/src/modules/32-ai-platform/routes/read-service-drizzle.ts — the Drizzle implementation of
// M32-T07's §4.1 read port.
//
// THE CREDENTIAL SPLIT, CONTINUED (§3.3 / migration 0116). `ai_invocation`, `ai_token_ledger` and
// `ai_routing_override` are ORG-SCOPED, so every method here opens `withOrgContext` and RLS on
// `app.org_id` is what keeps one agency's disclosures out of the next agency's compliance search. The
// PLATFORM-SHARED reads (`ai_model_backend` for R32, `ai_capability` for the key/label joins,
// `ai_evaluation_run` for R31) take the ordinary tenant handle — 0116 grants `wardenx_app` SELECT on all
// three — and take NO platform bypass, because opening an audited cross-tenant credential for a read a
// tenant connection can already perform writes a `platform.bypass_invoked` row per dashboard refresh.
//
// ── THE PARTITION KEY IS IN EVERY PREDICATE, AND R17 IS WHERE THAT COSTS SOMETHING ──────────────────
//
// `ai_invocation`'s PK is `(id, invoked_at)` and `invoked_at` is the RANGE partition key, so a lookup by
// id alone scans every monthly partition. R16's search always carries a time predicate (defaulted to the
// last 90 days when the caller supplies none — stated in the route, not invented here) so the planner
// prunes. R17 takes only an id, and rather than scan, it bounds the lookup by the same default window and
// answers `null` outside it. That is a REAL limit and it is deliberate: an invocation older than the
// window is reachable by searching with an explicit `from`, which is what a §164.528 accounting for a
// 2026 disclosure does in 2031 anyway.
//
// ── R22's WINDOW IS THE CALENDAR MONTH, BECAUSE THAT IS WHAT THE LEDGER IS PARTITIONED BY ───────────
//
// §3.8 partitions `ai_token_ledger` monthly and §1.1's budget is a monthly figure. Computing a forecast
// over a rolling 30 days would straddle two partitions for no benefit and would answer a different
// question from the one the cap enforces.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  AiEvaluationRunDecision,
  AiEvaluationRunStage,
  AiEvaluationRunStatus,
  AiInvocationHitlOutcome,
  AiInvocationStatus,
  AiRoutingDecision,
} from "@chartwarden/types";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import type { AiTokenBudgetResolver } from "../invocation/store";
import {
  type AiBackendHealthView,
  type AiDriftFindingView,
  type AiHealthView,
  type AiInvocationLedgerPage,
  type AiInvocationLedgerView,
  type AiInvocationSearchFilters,
  type AiPlatformReadActor,
  type AiTokenForecastView,
  type AiTokenLedgerFilters,
  type AiTokenLedgerPage,
  type M32ReadService,
  clampLimit,
  maskInvocationForActor,
} from "./read-service";

/**
 * The default search window (§4.1 R16/R17) — ninety days back from `at`.
 *
 * Chosen because it is the shortest window that covers a full quarter's compliance review, and because
 * an UNBOUNDED default would make the first page of the invocation console a full scan of every monthly
 * partition the deployment has ever written. An explicit `from` overrides it; R17 does not take one (see
 * the header).
 */
export const M32_DEFAULT_SEARCH_WINDOW_DAYS = 90;

/** §4.1 R31 — the drift view's row cap. Bounded so a wide `withinHours` cannot page a console to death. */
export const M32_DEFAULT_DRIFT_LIMIT = 200;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function daysBefore(at: string, days: number): Date {
  return new Date(Date.parse(at) - days * 24 * 60 * 60 * 1000);
}

/** The calendar month containing `at`, as `[start, end)` — R21/R22's window (see the header). */
export function calendarMonthWindow(at: string): { start: Date; end: Date } {
  const when = new Date(at);
  const start = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), 1));
  const end = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth() + 1, 1));
  return { start, end };
}

type InvocationSelect = typeof schema.aiInvocation.$inferSelect;

export interface M32ReadDeps {
  readonly db: DbClient;
  /**
   * The token budget the R22 forecast projects against — M2's fact, not M32's (see
   * ../invocation/store.ts). The Phase-1 binding answers `null` for everything, which is why
   * {@link AiTokenForecastView.projectedBreach} is three-valued.
   */
  readonly budgets: AiTokenBudgetResolver;
  /** True while `ai.full` is OFF — R32 reports it so "no healthy backend" does not read as an outage. */
  readonly capabilityShellMode: boolean;
}

/**
 * Project one `ai_invocation` row into the ledger view.
 *
 * `disclosedToVendor` is resolved from the JOINED backend `kind` and NOT from `routingDecision`: a
 * routing decision records what M32 CHOSE, and a fallback that ran after the choice is exactly the case
 * where the two disagree. §164.528 asks what actually left the building.
 */
function toLedgerView(row: InvocationSelect, backendKind: string | null): AiInvocationLedgerView {
  return {
    invocationId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
    capabilityId: row.capabilityId,
    capabilityKey: row.capabilityKey,
    backendId: row.backendId,
    backendKey: row.backendKey,
    modelVersionPin: row.modelVersionPin,
    promptTemplateVersion: row.promptTemplateVersion,
    actorMembershipId: row.actorMembershipId,
    actorRole: row.actorRole,
    patientId: row.patientId,
    touchedPatientChart: row.patientId !== null,
    consumerCorrelationId: row.consumerCorrelationId,
    routingDecision: row.routingDecision as AiRoutingDecision,
    routingReason: row.routingReason,
    inputTokenCount: row.inputTokenCount,
    outputTokenCount: row.outputTokenCount,
    durationMs: row.durationMs,
    status: row.status as AiInvocationStatus,
    errorClass: row.errorClass,
    errorMessage: row.errorMessage,
    hitlOutcome: row.hitlOutcome as AiInvocationHitlOutcome,
    zdrConfirmed: row.zdrConfirmed,
    invokedAt: iso(row.invokedAt),
    completedAt: row.completedAt === null ? null : iso(row.completedAt),
    disclosedToVendor: backendKind === "cloud",
  };
}

function toBackendHealth(row: typeof schema.aiModelBackend.$inferSelect): AiBackendHealthView {
  return {
    backendId: row.id,
    backendKey: row.backendKey,
    kind: row.kind,
    isActive: row.isActive,
    // A NULL that read as `healthy` would show a backend nobody has probed as green (the M32-T04 rule).
    lastHealthStatus: row.lastHealthStatus ?? "unknown",
    zdrStatus: row.zdrStatus,
    modelVersionPin: row.modelVersionPin,
  };
}

/** Build the Drizzle-backed §4.1 read service. */
export function buildDrizzleM32ReadService(deps: M32ReadDeps): M32ReadService {
  const { db, budgets } = deps;
  const ctx = (actor: AiPlatformReadActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });

  async function invocationWindow(
    filters: AiInvocationSearchFilters,
    at: string,
  ): Promise<{ from: Date; to: Date | null }> {
    return {
      from:
        filters.from === undefined
          ? daysBefore(at, M32_DEFAULT_SEARCH_WINDOW_DAYS)
          : new Date(filters.from),
      to: filters.to === undefined ? null : new Date(filters.to),
    };
  }

  return {
    async searchInvocations(actor, filters): Promise<AiInvocationLedgerPage> {
      const at = new Date().toISOString();
      const window = await invocationWindow(filters, at);
      const limit = clampLimit(filters.limit);
      return withOrgContext(db, ctx(actor), async (tx) => {
        const predicates = [
          eq(schema.aiInvocation.organizationId, actor.organizationId),
          gte(schema.aiInvocation.invokedAt, window.from),
        ];
        if (window.to !== null) predicates.push(lt(schema.aiInvocation.invokedAt, window.to));
        if (filters.capabilityId !== undefined) {
          predicates.push(eq(schema.aiInvocation.capabilityId, filters.capabilityId));
        }
        if (filters.capabilityKey !== undefined) {
          predicates.push(eq(schema.aiInvocation.capabilityKey, filters.capabilityKey));
        }
        if (filters.backendKey !== undefined) {
          predicates.push(eq(schema.aiInvocation.backendKey, filters.backendKey));
        }
        if (filters.status !== undefined) {
          predicates.push(eq(schema.aiInvocation.status, filters.status));
        }
        if (filters.patientId !== undefined) {
          predicates.push(eq(schema.aiInvocation.patientId, filters.patientId));
        }
        if (filters.disclosuresOnly === true) {
          predicates.push(eq(schema.aiModelBackend.kind, "cloud"));
        }
        const rows = await tx
          .select({ invocation: schema.aiInvocation, backendKind: schema.aiModelBackend.kind })
          .from(schema.aiInvocation)
          .leftJoin(
            schema.aiModelBackend,
            eq(schema.aiModelBackend.id, schema.aiInvocation.backendId),
          )
          .where(and(...predicates))
          .orderBy(desc(schema.aiInvocation.invokedAt))
          .limit(limit + 1);

        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          rows: page.map((r) =>
            maskInvocationForActor(toLedgerView(r.invocation, r.backendKind), actor.phiFullRead),
          ),
          // The cursor is the PARTITION key, not an offset — the next page prunes the same way this one
          // did. `null` when the page was not full: there is nothing after it to ask for.
          nextInvokedAtBefore:
            rows.length > limit && last !== undefined ? iso(last.invocation.invokedAt) : null,
        };
      });
    },

    async getInvocation(actor, invocationId) {
      const from = daysBefore(new Date().toISOString(), M32_DEFAULT_SEARCH_WINDOW_DAYS);
      return withOrgContext(db, ctx(actor), async (tx) => {
        const rows = await tx
          .select({ invocation: schema.aiInvocation, backendKind: schema.aiModelBackend.kind })
          .from(schema.aiInvocation)
          .leftJoin(
            schema.aiModelBackend,
            eq(schema.aiModelBackend.id, schema.aiInvocation.backendId),
          )
          .where(
            and(
              eq(schema.aiInvocation.id, invocationId),
              eq(schema.aiInvocation.organizationId, actor.organizationId),
              gte(schema.aiInvocation.invokedAt, from),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (row === undefined) return null;
        return maskInvocationForActor(
          toLedgerView(row.invocation, row.backendKind),
          actor.phiFullRead,
        );
      });
    },

    async tokenLedger(actor, filters: AiTokenLedgerFilters): Promise<AiTokenLedgerPage> {
      const at = new Date().toISOString();
      const month = calendarMonthWindow(at);
      const from = filters.from === undefined ? month.start : new Date(filters.from);
      const to = filters.to === undefined ? month.end : new Date(filters.to);
      const limit = clampLimit(filters.limit);
      return withOrgContext(db, ctx(actor), async (tx) => {
        const predicates = [
          eq(schema.aiTokenLedger.organizationId, actor.organizationId),
          gte(schema.aiTokenLedger.accruedAt, from),
          lt(schema.aiTokenLedger.accruedAt, to),
        ];
        if (filters.capabilityId !== undefined) {
          predicates.push(eq(schema.aiTokenLedger.capabilityId, filters.capabilityId));
        }
        const where = and(...predicates);
        const [entries, totals] = await Promise.all([
          tx
            .select()
            .from(schema.aiTokenLedger)
            .where(where)
            .orderBy(desc(schema.aiTokenLedger.accruedAt))
            .limit(limit),
          tx
            .select({
              input: sql<string>`coalesce(sum(${schema.aiTokenLedger.inputTokens}), 0)`,
              output: sql<string>`coalesce(sum(${schema.aiTokenLedger.outputTokens}), 0)`,
            })
            .from(schema.aiTokenLedger)
            .where(where),
        ]);
        const total = totals[0];
        return {
          entries: entries.map((row) => ({
            ledgerId: row.id,
            capabilityId: row.capabilityId,
            backendId: row.backendId,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cloudCostUsd: row.cloudCostUsd,
            localComputeAttribution: row.localComputeAttribution,
            accruedAt: iso(row.accruedAt),
          })),
          // `sum()` comes back as a numeric STRING from pg; Number() on a coalesced 0 is 0, and the
          // token counts are integers well inside the safe range (§3.2.9 counts tokens, not cents).
          windowInputTokens: Number(total?.input ?? 0),
          windowOutputTokens: Number(total?.output ?? 0),
        };
      });
    },

    async tokenForecast(actor, capabilityId, at): Promise<readonly AiTokenForecastView[]> {
      const { start, end } = calendarMonthWindow(at);
      const spend = await withOrgContext(db, ctx(actor), async (tx) => {
        const predicates = [
          eq(schema.aiTokenLedger.organizationId, actor.organizationId),
          gte(schema.aiTokenLedger.accruedAt, start),
          lt(schema.aiTokenLedger.accruedAt, end),
        ];
        if (capabilityId !== null) {
          predicates.push(eq(schema.aiTokenLedger.capabilityId, capabilityId));
        }
        return tx
          .select({
            capabilityId: schema.aiTokenLedger.capabilityId,
            spent: sql<string>`coalesce(sum(${schema.aiTokenLedger.inputTokens} + ${schema.aiTokenLedger.outputTokens}), 0)`,
          })
          .from(schema.aiTokenLedger)
          .where(and(...predicates))
          .groupBy(schema.aiTokenLedger.capabilityId);
      });

      const ids = spend.map((r) => r.capabilityId);
      // The capability KEY is what a console shows and what `budgetFor` is keyed on; resolving it here
      // (one platform-shared read) beats making the route join per row.
      const keyed =
        ids.length === 0
          ? []
          : await db
              .select({ id: schema.aiCapability.id, key: schema.aiCapability.capabilityKey })
              .from(schema.aiCapability)
              .where(inArray(schema.aiCapability.id, ids));
      const keyById = new Map(keyed.map((row) => [row.id, row.key]));

      const elapsedHours = Math.max(
        (Date.parse(at) - start.getTime()) / (60 * 60 * 1000),
        // Guard the first instant of a month: a zero denominator would make every burn rate Infinity.
        1 / 60,
      );
      const windowHours = (end.getTime() - start.getTime()) / (60 * 60 * 1000);

      return Promise.all(
        spend.map(async (row) => {
          const key = keyById.get(row.capabilityId) ?? row.capabilityId;
          const budget = await budgets.budgetFor(actor.organizationId, key);
          const spentTokens = Number(row.spent ?? 0);
          const burnRatePerHour = spentTokens / elapsedHours;
          const projectedWindowTotal = Math.round(burnRatePerHour * windowHours);
          return {
            capabilityId: row.capabilityId,
            capabilityKey: key,
            windowStart: start.toISOString(),
            windowEnd: end.toISOString(),
            spentTokens,
            softCap: budget?.softCapTokens ?? null,
            hardCap: budget?.hardCapTokens ?? null,
            burnRatePerHour,
            projectedWindowTotal,
            // `null`, never `false`, when no cap is configured — see read-service.ts's header.
            projectedBreach:
              budget === null || budget === undefined
                ? null
                : projectedWindowTotal >= budget.hardCapTokens,
          };
        }),
      );
    },

    async recentDrift(_actor, withinHours): Promise<readonly AiDriftFindingView[]> {
      // PLATFORM-SHARED: `ai_evaluation_run` and `ai_capability` are both `USING (true)` for
      // `wardenx_app` (0116), and a drift finding is a property of the MODEL, not of a tenant. Scoping
      // it to the caller's org would hide from one agency a degradation every agency is exposed to.
      const since = new Date(Date.now() - Math.max(withinHours, 0) * 60 * 60 * 1000);
      const rows = await db
        .select({ run: schema.aiEvaluationRun, key: schema.aiCapability.capabilityKey })
        .from(schema.aiEvaluationRun)
        .innerJoin(
          schema.aiCapability,
          eq(schema.aiCapability.id, schema.aiEvaluationRun.capabilityId),
        )
        .where(
          and(
            eq(schema.aiEvaluationRun.stage, "drift_response"),
            gte(schema.aiEvaluationRun.createdAt, since),
          ),
        )
        .orderBy(desc(schema.aiEvaluationRun.createdAt))
        .limit(M32_DEFAULT_DRIFT_LIMIT);
      return rows.map((row) => ({
        capabilityKey: row.key,
        run: {
          id: row.run.id,
          capabilityId: row.run.capabilityId,
          backendId: row.run.backendId,
          datasetVersionRef: row.run.datasetVersionRef,
          mlflowRunId: row.run.mlflowRunId,
          stage: row.run.stage as AiEvaluationRunStage,
          status: row.run.status as AiEvaluationRunStatus,
          decision: row.run.decision as AiEvaluationRunDecision,
          summaryMetrics: (row.run.summaryMetrics ?? {}) as Record<string, unknown>,
          initiatedByMembershipId: row.run.initiatedByMembershipId,
          startedAt: row.run.startedAt === null ? null : iso(row.run.startedAt),
          completedAt: row.run.completedAt === null ? null : iso(row.run.completedAt),
          createdAt: iso(row.run.createdAt),
        },
      }));
    },

    async health(at): Promise<AiHealthView> {
      const rows = await db
        .select()
        .from(schema.aiModelBackend)
        .orderBy(asc(schema.aiModelBackend.backendKey));
      const backends = rows.map(toBackendHealth);
      const anyHealthy = backends.some((b) => b.isActive && b.lastHealthStatus === "healthy");
      return {
        // With `ai.full` OFF there is nothing to be degraded FROM, so shell mode reports `ok` and lets
        // `capabilityShellMode` carry the nuance. Reporting `degraded` for the platform's intended
        // Phase-1 state would make the health endpoint red on every deployment that is working
        // correctly — the fastest way to teach an operator to ignore it.
        status: deps.capabilityShellMode || anyHealthy ? "ok" : "degraded",
        checkedAt: at,
        backends,
        capabilityShellMode: deps.capabilityShellMode,
      };
    },
  };
}
