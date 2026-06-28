// @wardenx/cost-report · repositories — the financial-import audit-replay records: `trial_balance_import`
// (every Xero trial-balance pull or manual CSV; `normalized_accounts` holds the post-normalization GL
// rows) and `wage_data_import` (every Gusto wage-data pull or manual entry feeding Worksheet S-3 Part II;
// `normalized_wage_rows` holds per-discipline paid-hours/salary/fringe — D6) (M27 §3.3). HISTORY IS
// PRESERVED (never updated post-completion) — the latest `status='complete'` row per (cost_report,
// source) is canonical. ORG-SCOPED; the import worker wraps these in `withOrgContext`. `raw_payload_cipher`
// is envelope-encrypted + audit-denylisted (§3.6) — this port returns the row; the service decrypts/projects.
import { schema } from "@wardenx/db";
import { and, desc, eq } from "drizzle-orm";
import type { CostReportDb } from "./db";

const TB = schema.trialBalanceImport;
const WG = schema.wageDataImport;

/** Data port for `trial_balance_import` + `wage_data_import` (append-only; latest-complete-pull canonical). */
export class ImportsRepository {
  constructor(private readonly db: CostReportDb) {}

  // ── trial_balance_import ─────────────────────────────────────────────────────────────────────

  async createTrialBalance(
    values: schema.NewTrialBalanceImport,
  ): Promise<schema.TrialBalanceImport> {
    const [row] = await this.db.insert(TB).values(values).returning();
    if (!row) throw new Error("trial_balance_import insert returned no row");
    return row;
  }

  async findTrialBalanceById(id: string): Promise<schema.TrialBalanceImport | null> {
    const [row] = await this.db.select().from(TB).where(eq(TB.id, id)).limit(1);
    return row ?? null;
  }

  /** A report's trial-balance pulls (§3.4 `idx_tb_import_org_report_pulled`), newest-pulled first. */
  async listTrialBalanceForReport(
    organizationId: string,
    costReportId: string,
    opts: { limit?: number } = {},
  ): Promise<readonly schema.TrialBalanceImport[]> {
    return this.db
      .select()
      .from(TB)
      .where(and(eq(TB.organizationId, organizationId), eq(TB.costReportId, costReportId)))
      .orderBy(desc(TB.pulledAt))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /** The canonical trial balance: the latest `status='complete'` pull for a report, or `null`. */
  async findLatestCompleteTrialBalance(
    organizationId: string,
    costReportId: string,
  ): Promise<schema.TrialBalanceImport | null> {
    const [row] = await this.db
      .select()
      .from(TB)
      .where(
        and(
          eq(TB.organizationId, organizationId),
          eq(TB.costReportId, costReportId),
          eq(TB.status, "complete"),
        ),
      )
      .orderBy(desc(TB.pulledAt))
      .limit(1);
    return row ?? null;
  }

  /** Finalize an in-flight trial-balance pull (status + normalized rows / failure reason). */
  async completeTrialBalance(
    id: string,
    patch: Partial<
      Pick<schema.NewTrialBalanceImport, "status" | "normalizedAccounts" | "rawPayloadCipher" | "failureReason">
    >,
  ): Promise<schema.TrialBalanceImport> {
    const [row] = await this.db.update(TB).set(patch).where(eq(TB.id, id)).returning();
    if (!row) throw new Error(`trial_balance_import ${id} not found for update`);
    return row;
  }

  // ── wage_data_import ─────────────────────────────────────────────────────────────────────────

  async createWageData(values: schema.NewWageDataImport): Promise<schema.WageDataImport> {
    const [row] = await this.db.insert(WG).values(values).returning();
    if (!row) throw new Error("wage_data_import insert returned no row");
    return row;
  }

  async findWageDataById(id: string): Promise<schema.WageDataImport | null> {
    const [row] = await this.db.select().from(WG).where(eq(WG.id, id)).limit(1);
    return row ?? null;
  }

  /** A report's wage-data pulls (§3.4 `idx_wage_import_org_report_pulled`), newest-pulled first. */
  async listWageDataForReport(
    organizationId: string,
    costReportId: string,
    opts: { limit?: number } = {},
  ): Promise<readonly schema.WageDataImport[]> {
    return this.db
      .select()
      .from(WG)
      .where(and(eq(WG.organizationId, organizationId), eq(WG.costReportId, costReportId)))
      .orderBy(desc(WG.pulledAt))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /** The canonical wage data: the latest `status='complete'` pull for a report, or `null`. */
  async findLatestCompleteWageData(
    organizationId: string,
    costReportId: string,
  ): Promise<schema.WageDataImport | null> {
    const [row] = await this.db
      .select()
      .from(WG)
      .where(
        and(
          eq(WG.organizationId, organizationId),
          eq(WG.costReportId, costReportId),
          eq(WG.status, "complete"),
        ),
      )
      .orderBy(desc(WG.pulledAt))
      .limit(1);
    return row ?? null;
  }

  /** Finalize an in-flight wage-data pull (status + normalized rows / failure reason). */
  async completeWageData(
    id: string,
    patch: Partial<
      Pick<schema.NewWageDataImport, "status" | "normalizedWageRows" | "rawPayloadCipher" | "failureReason">
    >,
  ): Promise<schema.WageDataImport> {
    const [row] = await this.db.update(WG).set(patch).where(eq(WG.id, id)).returning();
    if (!row) throw new Error(`wage_data_import ${id} not found for update`);
    return row;
  }
}
