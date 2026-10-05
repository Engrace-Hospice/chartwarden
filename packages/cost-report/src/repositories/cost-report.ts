// @wardenx/cost-report · repositories — the regulatory-financial-record root: `cost_report` (one row per
// (provider_entity, fiscal-year-end); composite uniqueness `(org, provider_entity, fye)` enforces one
// CMS-1984-14 report per CCN per FY — D1; the XState lifecycle (D4) lives in `state`) (M27 §3.3).
// ORG-SCOPED; the cost-report service wraps these in `withOrgContext` and owns the lifecycle guards (the
// pure reducer lives in @wardenx/cost-report). No PHI (D18) — aggregate financial/statistical only.
// `updateWithVersion` realizes the §2.5 optimistic-concurrency contract (`WHERE id=? AND version=?`).
import { schema } from "@wardenx/db";
import { and, desc, eq } from "drizzle-orm";
import type { CostReportDb, VersionedUpdateResult } from "./db";

const CR = schema.costReport;

/** Data port for `cost_report`. */
export class CostReportRepository {
  constructor(private readonly db: CostReportDb) {}

  /** Insert a cost report (defaults to `draft`). Returns the inserted row. */
  async create(values: schema.NewCostReport): Promise<schema.CostReport> {
    const [row] = await this.db.insert(CR).values(values).returning();
    if (!row) throw new Error("cost_report insert returned no row");
    return row;
  }

  /** Point read by id, or `null`. */
  async findById(id: string): Promise<schema.CostReport | null> {
    const [row] = await this.db.select().from(CR).where(eq(CR.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * The single report for a (provider_entity, fiscal-year-end) (the `uniq_cost_report_provider_fye`
   * surface), or `null`.
   */
  async findByProviderFye(
    organizationId: string,
    providerEntityId: string,
    fiscalYearEndDate: string,
  ): Promise<schema.CostReport | null> {
    const [row] = await this.db
      .select()
      .from(CR)
      .where(
        and(
          eq(CR.organizationId, organizationId),
          eq(CR.providerEntityId, providerEntityId),
          eq(CR.fiscalYearEndDate, fiscalYearEndDate),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** An org's cost reports (optionally narrowed by state), newest fiscal-year-end first. */
  async listByOrg(
    organizationId: string,
    opts: { state?: schema.CostReport["state"]; limit?: number } = {},
  ): Promise<readonly schema.CostReport[]> {
    const where = and(
      eq(CR.organizationId, organizationId),
      opts.state ? eq(CR.state, opts.state) : undefined,
    );
    return this.db
      .select()
      .from(CR)
      .where(where)
      .orderBy(desc(CR.fiscalYearEndDate))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  }

  /** A provider's cost reports across fiscal years (§3.4 `idx_cost_report_provider_fye_date`), newest first. */
  async listForProvider(
    organizationId: string,
    providerEntityId: string,
  ): Promise<readonly schema.CostReport[]> {
    return this.db
      .select()
      .from(CR)
      .where(and(eq(CR.organizationId, organizationId), eq(CR.providerEntityId, providerEntityId)))
      .orderBy(desc(CR.fiscalYearEndDate));
  }

  /**
   * Optimistic-concurrency update (§2.5): apply `patch` only when the persisted version equals
   * `expectedVersion`, bumping `version` + `updated_at`. On a version mismatch returns the
   * `VERSION_CONFLICT` signal carrying the current version (or `null` when the row vanished) so the
   * service can surface it for client refresh.
   */
  async updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<
        schema.NewCostReport,
        | "state"
        | "reopenCount"
        | "latestSnapshotId"
        | "badDebtClaimed"
        | "wageSource"
        | "deadlineExtensionUntilDate"
        | "closedAt"
        | "approvedByMembershipId"
        | "approvedAt"
      >
    >,
  ): Promise<VersionedUpdateResult<schema.CostReport>> {
    const [row] = await this.db
      .update(CR)
      .set({ ...patch, version: expectedVersion + 1, updatedAt: new Date() })
      .where(and(eq(CR.id, id), eq(CR.version, expectedVersion)))
      .returning();
    if (row) return { ok: true, row };
    const current = await this.findById(id);
    return { ok: false, conflict: "VERSION_CONFLICT", currentVersion: current?.version ?? null };
  }
}
