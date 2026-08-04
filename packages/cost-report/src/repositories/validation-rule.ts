// @wardenx/cost-report · repositories — the configurable rule library: `cost_report_validation_rule`
// (platform defaults `organization_id IS NULL` layered with per-tenant rules; `regulatory_required` rules
// cannot be tenant-disabled; MAC-jurisdiction-scoped rules ship additively; `predicate_spec` is consumed
// by the rule engine — D16/D21) (M27 §3.3). This is the ONE M27 table with a NULLABLE organization_id
// (the M3 permission-catalog precedent); the rule resolver UNIONs the platform-default rows with the
// tenant's rows under `withOrgContext`. No PHI (D18).
import { schema } from "@wardenx/db";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { CostReportDb } from "./db";

const R = schema.costReportValidationRule;

/** Data port for `cost_report_validation_rule` (platform-default + per-tenant layered). */
export class ValidationRuleRepository {
  constructor(private readonly db: CostReportDb) {}

  async create(
    values: schema.NewCostReportValidationRule,
  ): Promise<schema.CostReportValidationRule> {
    const [row] = await this.db.insert(R).values(values).returning();
    if (!row) throw new Error("cost_report_validation_rule insert returned no row");
    return row;
  }

  async findById(id: string): Promise<schema.CostReportValidationRule | null> {
    const [row] = await this.db.select().from(R).where(eq(R.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * The effective rule set for an org at a rule-set version: the platform defaults
   * (`organization_id IS NULL`) UNIONed with this org's own rows, `active` only by default, by category
   * then code. The service layers tenant overrides over platform rows by `rule_code`.
   */
  async listEffective(
    organizationId: string,
    ruleSetVersion: number,
    opts: { status?: schema.CostReportValidationRule["status"] } = {},
  ): Promise<readonly schema.CostReportValidationRule[]> {
    const status = opts.status ?? "active";
    return this.db
      .select()
      .from(R)
      .where(
        and(
          eq(R.ruleSetVersion, ruleSetVersion),
          eq(R.status, status),
          or(isNull(R.organizationId), eq(R.organizationId, organizationId)),
        ),
      )
      .orderBy(asc(R.category), asc(R.ruleCode));
  }

  /** Only the platform-default rows (`organization_id IS NULL`) at a rule-set version, by category/code. */
  async listPlatformDefaults(
    ruleSetVersion: number,
  ): Promise<readonly schema.CostReportValidationRule[]> {
    return this.db
      .select()
      .from(R)
      .where(and(isNull(R.organizationId), eq(R.ruleSetVersion, ruleSetVersion)))
      .orderBy(asc(R.category), asc(R.ruleCode));
  }

  /** Auto-suggestion review queue (D20): `draft_suggestion` rows for an org (or platform), newest first. */
  async listSuggestions(
    organizationId: string | null,
  ): Promise<readonly schema.CostReportValidationRule[]> {
    const where = and(
      eq(R.status, "draft_suggestion"),
      organizationId === null ? isNull(R.organizationId) : eq(R.organizationId, organizationId),
    );
    return this.db.select().from(R).where(where).orderBy(asc(R.publishedAt));
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        schema.NewCostReportValidationRule,
        | "description"
        | "severity"
        | "status"
        | "macJurisdictionScope"
        | "predicateSpec"
        | "deprecatedAt"
      >
    >,
  ): Promise<schema.CostReportValidationRule> {
    const [row] = await this.db.update(R).set(patch).where(eq(R.id, id)).returning();
    if (!row) throw new Error(`cost_report_validation_rule ${id} not found for update`);
    return row;
  }

  /** Deprecate a set of rules (status + `deprecated_at`) in one statement (rule-set version rollover). */
  async deprecateMany(ids: readonly string[], deprecatedAt: Date = new Date()): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db
      .update(R)
      .set({ status: "deprecated", deprecatedAt })
      .where(inArray(R.id, [...ids]))
      .returning({ id: R.id });
    return rows.length;
  }
}
