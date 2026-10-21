// @chartwarden/cost-report · repositories — the pre-submission validation cluster: `cost_report_validation`
// (one row per run with rolled-up counts + rule-set-version pinning — a 2027 rule-set update does not
// retroactively alter a 2026 history; `failed_to_run` captures infra failures distinct from rule
// failures — D9), its `cost_report_validation_result` children (one row per rule applied), and the
// `cost_report_validation_override` per-result override (elevated approval + step-up + reason; UNIQUE per
// result — D14) (M27 §3.3). ORG-SCOPED; the validation service wraps these in `withOrgContext` and owns
// the run lifecycle (the pure rule engine `runValidation`/`DEFAULT_RULES` lives in @chartwarden/cost-report).
import { schema } from "@chartwarden/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { CostReportDb } from "./db";

const VR = schema.costReportValidation;
const RS = schema.costReportValidationResult;
const OV = schema.costReportValidationOverride;

/** Data port for the validation-run cluster (run · result · override). */
export class ValidationRepository {
  constructor(private readonly db: CostReportDb) {}

  // ── cost_report_validation ───────────────────────────────────────────────────────────────────

  async createRun(values: schema.NewCostReportValidation): Promise<schema.CostReportValidation> {
    const [row] = await this.db.insert(VR).values(values).returning();
    if (!row) throw new Error("cost_report_validation insert returned no row");
    return row;
  }

  async findRunById(id: string): Promise<schema.CostReportValidation | null> {
    const [row] = await this.db.select().from(VR).where(eq(VR.id, id)).limit(1);
    return row ?? null;
  }

  /** A report's validation runs (§3.4 `idx_validation_org_report_run`), newest-started first. */
  async listRunsForReport(
    organizationId: string,
    costReportId: string,
    opts: { limit?: number } = {},
  ): Promise<readonly schema.CostReportValidation[]> {
    return this.db
      .select()
      .from(VR)
      .where(and(eq(VR.organizationId, organizationId), eq(VR.costReportId, costReportId)))
      .orderBy(desc(VR.runStartedAt))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /** The most-recent run for a report (the validation worklist head), or `null`. */
  async findLatestRunForReport(
    organizationId: string,
    costReportId: string,
  ): Promise<schema.CostReportValidation | null> {
    const [row] = await this.db
      .select()
      .from(VR)
      .where(and(eq(VR.organizationId, organizationId), eq(VR.costReportId, costReportId)))
      .orderBy(desc(VR.runStartedAt))
      .limit(1);
    return row ?? null;
  }

  /** Finalize a run (status + rolled-up counts + `run_completed_at`). Returns the updated row. */
  async updateRun(
    id: string,
    patch: Partial<
      Pick<
        schema.NewCostReportValidation,
        | "status"
        | "passedCount"
        | "failedCount"
        | "overriddenCount"
        | "warningCount"
        | "skippedCount"
        | "snapshotId"
        | "runCompletedAt"
      >
    >,
  ): Promise<schema.CostReportValidation> {
    const [row] = await this.db.update(VR).set(patch).where(eq(VR.id, id)).returning();
    if (!row) throw new Error(`cost_report_validation ${id} not found for update`);
    return row;
  }

  // ── cost_report_validation_result ────────────────────────────────────────────────────────────

  async createResult(
    values: schema.NewCostReportValidationResult,
  ): Promise<schema.CostReportValidationResult> {
    const [row] = await this.db.insert(RS).values(values).returning();
    if (!row) throw new Error("cost_report_validation_result insert returned no row");
    return row;
  }

  /** Bulk-insert a run's results in one statement. Returns the inserted rows. */
  async createResults(
    values: readonly schema.NewCostReportValidationResult[],
  ): Promise<readonly schema.CostReportValidationResult[]> {
    if (values.length === 0) return [];
    return this.db
      .insert(RS)
      .values([...values])
      .returning();
  }

  async findResultById(id: string): Promise<schema.CostReportValidationResult | null> {
    const [row] = await this.db.select().from(RS).where(eq(RS.id, id)).limit(1);
    return row ?? null;
  }

  /** A run's results (§3.4 `idx_val_result_validation_outcome`), optionally narrowed by outcome. */
  async listResults(
    validationId: string,
    outcome?: schema.CostReportValidationResult["outcome"],
  ): Promise<readonly schema.CostReportValidationResult[]> {
    const where = and(
      eq(RS.validationId, validationId),
      outcome ? eq(RS.outcome, outcome) : undefined,
    );
    return this.db.select().from(RS).where(where).orderBy(asc(RS.recordedAt));
  }

  // ── cost_report_validation_override ──────────────────────────────────────────────────────────

  /** Record an override of a failing result (INSERT-only; UNIQUE per result). Returns the inserted row. */
  async createOverride(
    values: schema.NewCostReportValidationOverride,
  ): Promise<schema.CostReportValidationOverride> {
    const [row] = await this.db.insert(OV).values(values).returning();
    if (!row) throw new Error("cost_report_validation_override insert returned no row");
    return row;
  }

  /** The override for a result (the `uniq_override_result` surface), or `null`. */
  async findOverrideForResult(
    validationResultId: string,
  ): Promise<schema.CostReportValidationOverride | null> {
    const [row] = await this.db
      .select()
      .from(OV)
      .where(eq(OV.validationResultId, validationResultId))
      .limit(1);
    return row ?? null;
  }

  /** An org's override decisions (the auditor's who-overrode-what-rule-when surface, §3.4), newest first. */
  async listOverridesForOrg(
    organizationId: string,
    opts: { limit?: number } = {},
  ): Promise<readonly schema.CostReportValidationOverride[]> {
    return this.db
      .select()
      .from(OV)
      .where(eq(OV.organizationId, organizationId))
      .orderBy(desc(OV.overriddenAt))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  }
}
