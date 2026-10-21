// apps/backend/src/modules/33-reporting/erasers/reporting-eraser.ts — the M33 `reporting_class` data eraser
// (M4 destruction registry, §3.7 / D6 / §8.4). On tenant offboarding M33's eraseFn deletes the org's
// OPERATIONAL reporting rows (report_schedule + the run ledgers, dashboard_tile_cache, report_view /
// report_share, report_definition / report_definition_version) in FK-safe order, REFUSES the compliance-class
// `report_drilldown_audit` (D9 survey-evidence — insert-only, destruction-blocked), and leaves the PLATFORM
// catalogs (report_base_catalog / report_metric_catalog / materialized_view_metadata) untouched (shared
// reference data, migration-retired only). Like M34, `subjectId` here is the ORG being offboarded (reporting
// has no patient subject), so the `DataEraser.erase(scope, subjectId)` bridge passes `subjectId` (the org)
// straight to the package's pure `eraseTenantReporting(orgId, store)`.
//
// The pure eraseFn + its narrow store port + the in-memory store live in `@chartwarden/reporting` (eraser.ts);
// this backend wrapper only adapts them to the M1 `DataEraser` contract and registers the REAL eraser over the
// Phase-0 `reporting_class` deny-stub via the composition-root hook (after wireErasers(), before
// validateErasers() — the same M22/M34/M36/M40 registration shape).
import { type DbClient, schema } from "@chartwarden/db";
import {
  type ReportingEraseStore,
  createInMemoryReportingEraseStore,
  eraseTenantReporting,
} from "@chartwarden/reporting";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DataEraser } from "@chartwarden/types";
import { eq, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** Deps for the M33 eraser registration; absent ⇒ the in-memory slice store (prod injects the Drizzle store). */
export interface ReportingEraserDeps {
  /** The Drizzle-backed `ReportingEraseStore` in prod (each DELETE under the tenant/platform tenancy context);
   *  the in-memory slice store by default. */
  readonly store?: ReportingEraseStore;
}

/** Optional side-effect deps the Drizzle store can carry (prod binds the outbox emit at the root). */
export interface DrizzleReportingEraseDeps {
  /** Route `m33.tenant_eraser.complete` (best-effort); absent ⇒ the optional port method is omitted. */
  readonly emitEraserComplete?: NonNullable<ReportingEraseStore["emitEraserComplete"]>;
}

/**
 * The Drizzle-backed {@link ReportingEraseStore}: the REAL §3.7 tenant-offboarding destruction path
 * (TASK-003 / ARCH-007). Every statement runs inside `withOrgContext` pinned to the OFFBOARDING org, so
 * RLS scopes each DELETE/COUNT to that tenant (a reporting erase can never reach across tenants), and
 * every count comes from `returning(...)` lengths — rows ACTUALLY removed, never a seed.
 *
 * FK-SAFE UNDER THE FIXED §3.7 SEQUENCE. `eraseTenantReporting` deletes PARENTS before their children
 * (`report_schedule` before `report_schedule_run`, `report_view` before `report_share`,
 * `report_definition` before `report_definition_version`), but the SQL FKs point child→parent with no
 * cascade — a naive per-table DELETE in that order would violate the FK. Each parent delete therefore
 * removes the org's child rows FIRST inside the same transaction and CARRIES the child count forward, so
 * the child's own port method reports carried + remaining (exact per-table counts, sequence unchanged).
 * `report_run` rows with `organization_id IS NULL` (platform-wide refreshes) are never matched by the
 * org-equality predicate — they are shared platform ledger rows, not tenant rows.
 * `report_drilldown_audit` is COUNT-ONLY here (compliance class, destruction-blocked, §3.7).
 */
export function createDrizzleReportingEraseStore(
  db: DbClient,
  deps: DrizzleReportingEraseDeps = {},
): ReportingEraseStore {
  const SCHEDULE = schema.reportSchedule;
  const SCHEDULE_RUN = schema.reportScheduleRun;
  const RUN = schema.reportRun;
  const TILE = schema.dashboardTileCache;
  const VIEW = schema.reportView;
  const SHARE = schema.reportShare;
  const DEF = schema.reportDefinition;
  const DEF_VERSION = schema.reportDefinitionVersion;
  const DRILLDOWN = schema.reportDrilldownAudit;

  const inOrg = <T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, fn);

  /** Child counts a parent delete already removed, consumed once by the child's own method. */
  const carried = new Map<
    string,
    { scheduleRuns: number; shares: number; definitionVersions: number }
  >();
  const carryFor = (org: string) => {
    let c = carried.get(org);
    if (!c) {
      c = { scheduleRuns: 0, shares: 0, definitionVersions: 0 };
      carried.set(org, c);
    }
    return c;
  };
  const takeCarry = (
    org: string,
    key: "scheduleRuns" | "shares" | "definitionVersions",
  ): number => {
    const c = carried.get(org);
    if (!c) return 0;
    const n = c[key];
    c[key] = 0;
    return n;
  };

  return {
    async deleteSchedules(organizationId) {
      return inOrg(organizationId, async (tx) => {
        // FK: report_schedule_run → report_schedule (no cascade). Children go first, count carried.
        const runs = await tx
          .delete(SCHEDULE_RUN)
          .where(eq(SCHEDULE_RUN.organizationId, organizationId))
          .returning({ org: SCHEDULE_RUN.organizationId });
        carryFor(organizationId).scheduleRuns = runs.length;
        const schedules = await tx
          .delete(SCHEDULE)
          .where(eq(SCHEDULE.organizationId, organizationId))
          .returning({ org: SCHEDULE.organizationId });
        return schedules.length;
      });
    },

    async deleteScheduleRuns(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const rows = await tx
          .delete(SCHEDULE_RUN)
          .where(eq(SCHEDULE_RUN.organizationId, organizationId))
          .returning({ org: SCHEDULE_RUN.organizationId });
        return rows.length + takeCarry(organizationId, "scheduleRuns");
      });
    },

    async deleteRuns(organizationId) {
      return inOrg(organizationId, async (tx) => {
        // `organization_id IS NULL` platform-wide refresh rows are never matched (shared ledger).
        const rows = await tx
          .delete(RUN)
          .where(eq(RUN.organizationId, organizationId))
          .returning({ id: RUN.id });
        return rows.length;
      });
    },

    async deleteTileCache(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const rows = await tx
          .delete(TILE)
          .where(eq(TILE.organizationId, organizationId))
          .returning({ org: TILE.organizationId });
        return rows.length;
      });
    },

    async deleteViews(organizationId) {
      return inOrg(organizationId, async (tx) => {
        // FK: report_share → report_view (no cascade). Shares go first, count carried.
        const shares = await tx
          .delete(SHARE)
          .where(eq(SHARE.organizationId, organizationId))
          .returning({ org: SHARE.organizationId });
        carryFor(organizationId).shares = shares.length;
        const views = await tx
          .delete(VIEW)
          .where(eq(VIEW.organizationId, organizationId))
          .returning({ org: VIEW.organizationId });
        return views.length;
      });
    },

    async deleteShares(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const rows = await tx
          .delete(SHARE)
          .where(eq(SHARE.organizationId, organizationId))
          .returning({ org: SHARE.organizationId });
        return rows.length + takeCarry(organizationId, "shares");
      });
    },

    async deleteDefinitions(organizationId) {
      return inOrg(organizationId, async (tx) => {
        // FK: report_definition_version → report_definition (no cascade). Versions first, carried.
        // (report_view → report_definition_version is already gone: the sequence deletes views earlier.)
        const versions = await tx
          .delete(DEF_VERSION)
          .where(eq(DEF_VERSION.organizationId, organizationId))
          .returning({ org: DEF_VERSION.organizationId });
        carryFor(organizationId).definitionVersions = versions.length;
        const defs = await tx
          .delete(DEF)
          .where(eq(DEF.organizationId, organizationId))
          .returning({ org: DEF.organizationId });
        return defs.length;
      });
    },

    async deleteDefinitionVersions(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const rows = await tx
          .delete(DEF_VERSION)
          .where(eq(DEF_VERSION.organizationId, organizationId))
          .returning({ org: DEF_VERSION.organizationId });
        return rows.length + takeCarry(organizationId, "definitionVersions");
      });
    },

    async countDrilldownAudit(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(DRILLDOWN)
          .where(eq(DRILLDOWN.organizationId, organizationId));
        return row?.n ?? 0;
      });
    },

    ...(deps.emitEraserComplete ? { emitEraserComplete: deps.emitEraserComplete } : {}),
  };
}

/** Adapt the package's pure `eraseTenantReporting(orgId, store)` to the M1 `DataEraser` contract. */
export function createReportingEraser(store: ReportingEraseStore): DataEraser {
  return {
    // `subjectId` IS the offboarding org for this reporting class (no patient subject); the M4 destruction
    // registry hands it in as the subject the certificate records. The §3.7 co-sign gate (which needs the
    // destruction certificate's approver list) binds once the M4 cert-driven destruction binding lands.
    async erase(_scope, subjectId) {
      const { erased } = await eraseTenantReporting(subjectId, store);
      return { erased };
    },
  };
}

/**
 * Register the REAL M33 reporting eraser over the Phase-0 `reporting_class` deny-stub. Called by the
 * composition root's `registerModuleErasers` hook (after wireErasers(), before validateErasers()), the same
 * hook M5/M6/M22/M34/M36/M40 use. The in-memory slice store is the default; prod injects
 * `createDrizzleReportingEraseStore(db)` (each DELETE under the offboarding org's tenancy context,
 * `report_drilldown_audit` count-only) via `deps.store` so the eraser runs against the real M33 tables.
 *
 * TODO(M33 boot-wiring): wire the §3.7 `decisionCert` co-sign gate once the M4 cert-driven destruction
 * binding lands.
 */
export function registerReportingErasers(deps: ReportingEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryReportingEraseStore().store;
  registerEraser("reporting_class", createReportingEraser(store));
}
