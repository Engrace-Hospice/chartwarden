// @wardenx/cost-report · repositories — the filing-deadline timer: `cost_report_compliance_window` (one
// per cost report — UNIQUE cost_report_id; due FYE + 5 months per 42 CFR §413.24(f); the cron scan emits
// tiered M36 alerts t4_months → t4_5_months → t4_75_months → past_deadline; MAC-granted extensions update
// `current_effective_deadline_date` and reset the cadence — D15; mirrors M6's compliance-window pattern)
// (M27 §3.3). ORG-SCOPED; the filing-deadline-scan worker wraps these in `withOrgContext`. No PHI (D18).
import { schema } from "@wardenx/db";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { CostReportDb } from "./db";

const W = schema.costReportComplianceWindow;

/** Data port for `cost_report_compliance_window`. */
export class ComplianceWindowRepository {
  constructor(private readonly db: CostReportDb) {}

  async create(
    values: schema.NewCostReportComplianceWindow,
  ): Promise<schema.CostReportComplianceWindow> {
    const [row] = await this.db.insert(W).values(values).returning();
    if (!row) throw new Error("cost_report_compliance_window insert returned no row");
    return row;
  }

  async findById(id: string): Promise<schema.CostReportComplianceWindow | null> {
    const [row] = await this.db.select().from(W).where(eq(W.id, id)).limit(1);
    return row ?? null;
  }

  /** The single window for a report (the `cost_report_id` UNIQUE surface), or `null`. */
  async findByReport(
    organizationId: string,
    costReportId: string,
  ): Promise<schema.CostReportComplianceWindow | null> {
    const [row] = await this.db
      .select()
      .from(W)
      .where(and(eq(W.organizationId, organizationId), eq(W.costReportId, costReportId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The cron's deadline-scan worklist: still-open windows (`closed_at IS NULL`) whose effective deadline
   * is on/before `asOf` (§3.4 `idx_window_org_deadline` / `idx_window_last_tier`), oldest-due first. The
   * worker re-evaluates each row's tier and emits the M36 alert when the tier advances.
   */
  async listDueForScan(
    asOf: Date,
    opts: { organizationId?: string; limit?: number } = {},
  ): Promise<readonly schema.CostReportComplianceWindow[]> {
    const where = and(
      isNull(W.closedAt),
      lte(W.currentEffectiveDeadlineDate, asOf.toISOString().slice(0, 10)),
      opts.organizationId ? eq(W.organizationId, opts.organizationId) : undefined,
    );
    return this.db
      .select()
      .from(W)
      .where(where)
      .orderBy(asc(W.currentEffectiveDeadlineDate))
      .limit(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
  }

  /** Stamp the emitted tier after an alert fires (drives the once-per-tier debounce). */
  async update(
    id: string,
    patch: Partial<
      Pick<
        schema.NewCostReportComplianceWindow,
        | "currentEffectiveDeadlineDate"
        | "lastAlertTier"
        | "lastAlertTierEmittedAt"
        | "closedAt"
      >
    >,
  ): Promise<schema.CostReportComplianceWindow> {
    const [row] = await this.db.update(W).set(patch).where(eq(W.id, id)).returning();
    if (!row) throw new Error(`cost_report_compliance_window ${id} not found for update`);
    return row;
  }
}
