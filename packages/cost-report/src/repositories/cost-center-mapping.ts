// @chartwarden/cost-report · repositories — the GL-account → cost-center mapping: `cost_center_mapping`
// (per-(tenant, provider_entity, fiscal_year); platform defaults seeded, tenant overrides/extensions
// layer on top; versioned per FY so a 2027 re-mapping does not alter the 2026 report; UNIQUE per
// (org, provider, fy, xero_account_code) — no double-mapping of one GL account in one FY — D5) (M27 §3.3).
// ORG-SCOPED; the mapping service wraps these in `withOrgContext` and owns the read-only-when-parent-locked
// guard. `cms_cost_center_code` is an M38 value-set member (`cms_cost_center_v1984_14`). No PHI (D18).
import { schema } from "@chartwarden/db";
import { and, asc, eq } from "drizzle-orm";
import type { CostReportDb } from "./db";

const M = schema.costCenterMapping;

/** Data port for `cost_center_mapping`. */
export class CostCenterMappingRepository {
  constructor(private readonly db: CostReportDb) {}

  async create(values: schema.NewCostCenterMapping): Promise<schema.CostCenterMapping> {
    const [row] = await this.db.insert(M).values(values).returning();
    if (!row) throw new Error("cost_center_mapping insert returned no row");
    return row;
  }

  async findById(id: string): Promise<schema.CostCenterMapping | null> {
    const [row] = await this.db.select().from(M).where(eq(M.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * The single mapping for a (provider, fy, xero account) (the `uniq_mapping_org_provider_fy_account`
   * surface) — the unmapped-account probe for `tb.no_orphan_accounts`, or `null`.
   */
  async findByAccount(
    organizationId: string,
    providerEntityId: string,
    fiscalYearInt: number,
    xeroAccountCode: string,
  ): Promise<schema.CostCenterMapping | null> {
    const [row] = await this.db
      .select()
      .from(M)
      .where(
        and(
          eq(M.organizationId, organizationId),
          eq(M.providerEntityId, providerEntityId),
          eq(M.fiscalYearInt, fiscalYearInt),
          eq(M.xeroAccountCode, xeroAccountCode),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The full mapping set for a (provider, fiscal year) (§3.4 `idx_mapping_org_provider_fy`), by account. */
  async listForProviderFy(
    organizationId: string,
    providerEntityId: string,
    fiscalYearInt: number,
  ): Promise<readonly schema.CostCenterMapping[]> {
    return this.db
      .select()
      .from(M)
      .where(
        and(
          eq(M.organizationId, organizationId),
          eq(M.providerEntityId, providerEntityId),
          eq(M.fiscalYearInt, fiscalYearInt),
        ),
      )
      .orderBy(asc(M.xeroAccountCode));
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        schema.NewCostCenterMapping,
        "xeroAccountName" | "cmsCostCenterCode" | "mappingSource" | "version"
      >
    >,
  ): Promise<schema.CostCenterMapping> {
    const [row] = await this.db
      .update(M)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(M.id, id))
      .returning();
    if (!row) throw new Error(`cost_center_mapping ${id} not found for update`);
    return row;
  }
}
