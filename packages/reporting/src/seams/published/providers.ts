// @chartwarden/reporting — concrete implementations of the three PUBLISHED seams (M33 §4.3).
//
// The seam INTERFACES live beside this file (`metrics-provider.ts` / `dashboard-catalog-provider.ts` /
// `scheduled-report-provider.ts`); these are the live classes the composition root binds into the M1
// SeamRegistry at boot (P2C), over the Phase-0 deny-stub. Every read opens its own `withReportSession`
// read-replica session (the seam consumers — M30/M34/M37 — call these OUTSIDE M33's own read backend, so
// each impl owns its session, §8.1.2 / D3). All reads are aggregate-by-default (D6 — no row-level PHI).
//
// PORT-INJECTED (the package's no-apps-backend-edge posture): the impls take the M1 `read_replica_session`
// port + lag gate (the same ports `withReportSession` composes over) and the package's own repositories.
// The metric evaluation (translator → `report_mv` MV substrate) is a single injected
// {@link DashboardMetricExecutorPort} — UNBOUND it returns the forward-seam deny-stub (`value:null,
// isForwardSeamDenyStub:true`), so a not-yet-materialized metric never fabricates a number (D6/D13). The
// recipient-revocation cascade is an injected {@link ScheduleCascadeStore} (a WRITE surface) — UNBOUND it is
// a no-op `{0,0}`. The cascade DECISION is the total pure {@link decideRecipientCascade}.
import { computeFreshnessSeconds } from "../../refresh/lag-probe";
import { ReportCatalogRepository } from "../../repositories/catalogs";
import type { ReportingDb } from "../../repositories/db";
import { ReportDefinitionRepository } from "../../repositories/definitions";
import { ReportScheduleRepository } from "../../repositories/schedules";
import { ReportViewRepository } from "../../repositories/views";
import {
  type ReadReplicaSessionPort,
  type ReplicaLagGatePort,
  withReportSession,
} from "../../session/with-report-session";
import type { DashboardCatalogProvider } from "./dashboard-catalog-provider";
import type { MetricsProvider } from "./metrics-provider";
import type { ScheduledReportProvider } from "./scheduled-report-provider";

// ── shared deps ────────────────────────────────────────────────────────────────────────────────────────

/** The read-session ports every published-seam impl opens its replica read under (§8.1.2). */
export interface ReportingPublishedSeamDeps {
  /** The M1 `read_replica_session` port `withReportSession` runs each read under. */
  readonly replica: ReadReplicaSessionPort;
  /** Optional D14 lag breaker — feeds the `dataFreshnessSeconds` chip + the degrade decision. */
  readonly lag?: ReplicaLagGatePort;
}

const sampleLagSeconds = async (lag?: ReplicaLagGatePort): Promise<number> => {
  if (!lag) return 0;
  const r = await lag.read();
  return r.lagSeconds;
};

// ── 1. MetricsProvider ───────────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates ONE dashboard metric over the MV substrate (the translator → `report_mv.select_<mvKey>` path,
 * bound at P2C). When UNBOUND every evaluation is the forward-seam deny-stub — `value:null,
 * isForwardSeamDenyStub:true` — so a registered-but-not-materialized metric (or an absent executor) never
 * fabricates a number (D6/D13). Org-scoped; aggregate-only.
 */
export interface DashboardMetricExecutorPort {
  evaluate(input: {
    readonly metricKey: string;
    readonly organizationId: string;
    readonly asOf?: string;
    readonly period?: { from: string; to: string };
    readonly dimensions?: Record<string, string>;
  }): Promise<{ value: number | null; rowCount: number; isForwardSeamDenyStub: boolean }>;
}

/** Deps for {@link MetricsProviderImpl}: the read-session ports + the optional MV metric executor. */
export interface MetricsProviderDeps extends ReportingPublishedSeamDeps {
  /** Evaluates a metric over the MV substrate; UNBOUND ⇒ every read is the forward-seam deny-stub. */
  readonly executor?: DashboardMetricExecutorPort;
}

/**
 * The live `MetricsProvider` seam (§4.3) — backs the internal `/metrics_seam/dashboard/:metricKey` endpoint
 * (#42) and the embedded tiles M30/M34/M37 read. Resolves the metric from `report_metric_catalog` (its unit)
 * under a `tile`-tier read session, then delegates the value to the injected MV executor. A metric absent
 * from the catalog, an `executor` not yet bound, or a not-yet-materialized MV all resolve the forward-seam
 * deny-stub (`value:null, isForwardSeamDenyStub:true`) — never a fabricated number (D6/D13).
 */
export class MetricsProviderImpl implements MetricsProvider {
  constructor(private readonly deps: MetricsProviderDeps) {}

  private read<T>(orgId: string, fn: (db: ReportingDb) => Promise<T>): Promise<T> {
    return withReportSession<T>(
      { orgId, tier: "tile" },
      { replica: this.deps.replica, lag: this.deps.lag },
      fn,
    );
  }

  async getDashboardMetric(params: {
    metricKey: string;
    organizationId: string;
    asOf?: string;
    period?: { from: string; to: string };
    dimensions?: Record<string, string>;
  }): Promise<{
    metricKey: string;
    value: number | null;
    unit: string;
    rowCount: number;
    asOf: string;
    dataFreshnessSeconds: number;
    isForwardSeamDenyStub: boolean;
  }> {
    const lagSeconds = await sampleLagSeconds(this.deps.lag);
    const asOf = params.asOf ?? new Date(Date.now() - lagSeconds * 1000).toISOString();
    const dataFreshnessSeconds = computeFreshnessSeconds(lagSeconds);

    const metric = await this.read(params.organizationId, (db) =>
      new ReportCatalogRepository(db).findMetricByKey(params.metricKey),
    );
    const unit = metric?.unit ?? "count";

    // No catalog metric, no executor, or the executor's MV is not materialized → forward-seam deny-stub.
    if (!metric || !this.deps.executor) {
      return {
        metricKey: params.metricKey,
        value: null,
        unit,
        rowCount: 0,
        asOf,
        dataFreshnessSeconds,
        isForwardSeamDenyStub: true,
      };
    }

    const r = await this.deps.executor.evaluate({
      metricKey: params.metricKey,
      organizationId: params.organizationId,
      asOf: params.asOf,
      period: params.period,
      dimensions: params.dimensions,
    });
    return {
      metricKey: params.metricKey,
      value: r.value,
      unit,
      rowCount: r.rowCount,
      asOf,
      dataFreshnessSeconds,
      isForwardSeamDenyStub: r.isForwardSeamDenyStub,
    };
  }

  async getDashboardMetricsBulk(params: {
    metricKeys: string[];
    organizationId: string;
    asOf?: string;
    period?: { from: string; to: string };
  }): Promise<{ metricKey: string; value: number | null; unit: string }[]> {
    // §4.3 — bounded to 50 metrics/call for embedded surfaces.
    const keys = params.metricKeys.slice(0, 50);
    const out: { metricKey: string; value: number | null; unit: string }[] = [];
    for (const metricKey of keys) {
      const r = await this.getDashboardMetric({
        metricKey,
        organizationId: params.organizationId,
        asOf: params.asOf,
        period: params.period,
      });
      out.push({ metricKey: r.metricKey, value: r.value, unit: r.unit });
    }
    return out;
  }
}

// ── 2. DashboardCatalogProvider ──────────────────────────────────────────────────────────────────────────

/** Deps for {@link DashboardCatalogProviderImpl}: just the read-session ports. */
export type DashboardCatalogProviderDeps = ReportingPublishedSeamDeps;

/**
 * The live `DashboardCatalogProvider` seam (§4.3) — M34's tenant ops console enumerates an org's dashboards.
 * A "dashboard" is an org-shared saved view (`report_view`, `share_scope='org'`); `tileCount` is the bound
 * definition version's measure+dimension count, `authorship` is the bound definition's authorship. Aggregate
 * metadata only (no tile results, no PHI). Read under a `tile`-tier replica session.
 */
export class DashboardCatalogProviderImpl implements DashboardCatalogProvider {
  constructor(private readonly deps: DashboardCatalogProviderDeps) {}

  async listDashboardsForOrg(organizationId: string): Promise<
    {
      dashboardId: string;
      displayName: string;
      authorship: "system" | "tenant";
      tileCount: number;
      shareScope: "private" | "role" | "org";
      isOrgDefault: boolean;
    }[]
  > {
    return withReportSession(
      { orgId: organizationId, tier: "tile" },
      { replica: this.deps.replica, lag: this.deps.lag },
      async (db) => {
        const views = await new ReportViewRepository(db).listOrgShared(organizationId);
        const defRepo = new ReportDefinitionRepository(db);
        const out: {
          dashboardId: string;
          displayName: string;
          authorship: "system" | "tenant";
          tileCount: number;
          shareScope: "private" | "role" | "org";
          isOrgDefault: boolean;
        }[] = [];
        for (const view of views) {
          const version = await defRepo.findVersionById(view.definitionVersionId);
          const definition = version
            ? await defRepo.findDefinitionById(version.definitionId)
            : null;
          // F-044 — a TILE, not a column. This counted `measures + dimensions` off the spec, which is the
          // number of things a tile PROJECTS, not the number of tiles: the demo dashboard reported 3 while
          // `GET /dashboards/:id`'s manifest listed 1, for the same dashboard on the same screen. A
          // definition binds exactly one `base_key` and `readTile`'s key IS a base key, so a dashboard has
          // one tile per bound definition — and 0 when the version is missing, which is not the same as 1.
          const tileCount = definition ? 1 : 0;
          out.push({
            dashboardId: view.id,
            displayName: view.displayName,
            authorship: definition?.authorship ?? "tenant",
            tileCount,
            shareScope: view.shareScope,
            isOrgDefault: view.isOrgDefault,
          });
        }
        return out;
      },
    );
  }
}

// ── 3. ScheduledReportProvider ───────────────────────────────────────────────────────────────────────────

/** A schedule row the cascade decision reasons over (the recipient list + lifecycle status). */
export interface CascadeScheduleRow {
  readonly id: string;
  readonly recipientMembershipIds: readonly string[];
  readonly status: "active" | "paused" | "cancelled";
}

/** One recipient-cascade patch: the schedule, its new recipient list, and whether it auto-paused. */
export interface CascadeSchedulePatch {
  readonly scheduleId: string;
  readonly recipientMembershipIds: readonly string[];
  readonly autoPaused: boolean;
}

/** The decided cascade: the per-schedule patches + the §4.3 affected/paused counts. */
export interface RecipientCascadeDecision {
  readonly patches: readonly CascadeSchedulePatch[];
  readonly schedulesAffected: number;
  readonly schedulesPaused: number;
}

/**
 * Decide the recipient-revocation cascade for one membership (PURE, total, §4.3). For each schedule whose
 * recipient list contains `membershipId`, the membership is removed; a NON-cancelled schedule left with zero
 * recipients is auto-paused (a cancelled schedule keeps its terminal status). Schedules that did not list the
 * membership produce no patch. `schedulesAffected` counts the patched schedules; `schedulesPaused` counts the
 * subset that auto-paused.
 */
export function decideRecipientCascade(
  rows: readonly CascadeScheduleRow[],
  membershipId: string,
): RecipientCascadeDecision {
  const patches: CascadeSchedulePatch[] = [];
  for (const row of rows) {
    if (!row.recipientMembershipIds.includes(membershipId)) continue;
    const recipientMembershipIds = row.recipientMembershipIds.filter((id) => id !== membershipId);
    const autoPaused = recipientMembershipIds.length === 0 && row.status !== "cancelled";
    patches.push({ scheduleId: row.id, recipientMembershipIds, autoPaused });
  }
  return {
    patches,
    schedulesAffected: patches.length,
    schedulesPaused: patches.filter((p) => p.autoPaused).length,
  };
}

/**
 * The WRITE surface the recipient-revocation cascade applies through (a `report_schedule` find-and-update
 * across the membership's schedules). UNBOUND ⇒ the cascade is a no-op `{0,0}`. The composition root binds
 * this over `withOrgContext` at P2C (recipient lists are RLS-scoped to the membership's own org).
 */
export interface ScheduleCascadeStore {
  /** Every schedule (any status) whose recipient list contains `membershipId`. */
  findSchedulesWithRecipient(membershipId: string): Promise<readonly CascadeScheduleRow[]>;
  /** Apply one decided patch: write the trimmed recipient list, and pause when `autoPaused`. */
  applyPatch(patch: CascadeSchedulePatch): Promise<void>;
}

/** Deps for {@link ScheduledReportProviderImpl}: the read-session ports + the optional cascade write store. */
export interface ScheduledReportProviderDeps extends ReportingPublishedSeamDeps {
  /** The recipient-revocation cascade write surface; UNBOUND ⇒ `cascadeRecipientRevocation` is a no-op. */
  readonly cascade?: ScheduleCascadeStore;
}

/**
 * The live `ScheduledReportProvider` seam (§4.3) — M34 consults it at offboarding + on membership revocation.
 * `listActiveSchedulesForOrg` reads the org's active schedules under a `tile`-tier replica session;
 * `cascadeRecipientRevocation` removes a revoked membership from every recipient list it appears on and
 * auto-pauses any schedule left with zero recipients (the decision is the pure {@link decideRecipientCascade};
 * the apply is the injected {@link ScheduleCascadeStore}, a no-op until P2C binds it).
 */
export class ScheduledReportProviderImpl implements ScheduledReportProvider {
  constructor(private readonly deps: ScheduledReportProviderDeps) {}

  async listActiveSchedulesForOrg(organizationId: string): Promise<
    {
      scheduleId: string;
      reportViewId: string;
      ownerMembershipId: string;
      cronExpression: string;
      recipientCount: number;
      nextRunAt: string | null;
    }[]
  > {
    return withReportSession(
      { orgId: organizationId, tier: "tile" },
      { replica: this.deps.replica, lag: this.deps.lag },
      async (db) => {
        const rows = await new ReportScheduleRepository(db).listActiveForOrg(organizationId);
        return rows.map((s) => ({
          scheduleId: s.id,
          reportViewId: s.reportViewId,
          ownerMembershipId: s.ownerMembershipId,
          cronExpression: s.cronExpression,
          recipientCount: (s.recipientMembershipIds ?? []).length,
          nextRunAt: s.nextRunAt ? s.nextRunAt.toISOString() : null,
        }));
      },
    );
  }

  async cascadeRecipientRevocation(
    membershipId: string,
  ): Promise<{ schedulesAffected: number; schedulesPaused: number }> {
    if (!this.deps.cascade) return { schedulesAffected: 0, schedulesPaused: 0 };
    const rows = await this.deps.cascade.findSchedulesWithRecipient(membershipId);
    const decision = decideRecipientCascade(rows, membershipId);
    for (const patch of decision.patches) await this.deps.cascade.applyPatch(patch);
    return {
      schedulesAffected: decision.schedulesAffected,
      schedulesPaused: decision.schedulesPaused,
    };
  }
}
