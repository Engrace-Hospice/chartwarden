// @chartwarden/cost-report · repositories — the shared worksheet row: `cost_report_worksheet` (all 21
// CMS-1984-14 worksheets via the `worksheet_code` discriminator + a TypeBox-typed `data` jsonb; UNIQUE
// per (cost_report_id, worksheet_code) — D3) (M27 §3.3). ORG-SCOPED; the worksheet service wraps these in
// `withOrgContext`, validates `data` per-code against the resolved WORKSHEET_SCHEMAS, and owns the
// read-only-when-parent-locked guard (§2.3). The `data` payload is replaced wholesale per write; `version`
// drives §2.5 optimistic concurrency (`updateWithVersion`). No PHI (D18).
import { schema } from "@chartwarden/db";
import { and, asc, eq } from "drizzle-orm";
import type { CostReportDb, VersionedUpdateResult } from "./db";

const W = schema.costReportWorksheet;

/** Data port for `cost_report_worksheet`. */
export class CostReportWorksheetRepository {
  constructor(private readonly db: CostReportDb) {}

  /** Insert a worksheet row (the lazy first-write of a worksheet code). Returns the inserted row. */
  async create(values: schema.NewCostReportWorksheet): Promise<schema.CostReportWorksheet> {
    const [row] = await this.db.insert(W).values(values).returning();
    if (!row) throw new Error("cost_report_worksheet insert returned no row");
    return row;
  }

  async findById(id: string): Promise<schema.CostReportWorksheet | null> {
    const [row] = await this.db.select().from(W).where(eq(W.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * The single worksheet for a (cost_report, code) (the `uniq_worksheet_report_code` surface), or `null`
   * — the lazy-create probe: a `null` means the service returns the empty TypeBox default (§2.3).
   */
  async findByReportAndCode(
    costReportId: string,
    worksheetCode: schema.CostReportWorksheet["worksheetCode"],
  ): Promise<schema.CostReportWorksheet | null> {
    const [row] = await this.db
      .select()
      .from(W)
      .where(and(eq(W.costReportId, costReportId), eq(W.worksheetCode, worksheetCode)))
      .limit(1);
    return row ?? null;
  }

  /** All persisted worksheets for a cost report (§3.4 `idx_worksheet_org_report`), by worksheet code. */
  async listByReport(
    organizationId: string,
    costReportId: string,
  ): Promise<readonly schema.CostReportWorksheet[]> {
    return this.db
      .select()
      .from(W)
      .where(and(eq(W.organizationId, organizationId), eq(W.costReportId, costReportId)))
      .orderBy(asc(W.worksheetCode));
  }

  /**
   * Optimistic-concurrency update (§2.5): replace `data` (and stamp `computed_at` for derived worksheets)
   * only when the persisted version equals `expectedVersion`, bumping `version` + `updated_at`. On a
   * version mismatch returns the `VERSION_CONFLICT` signal with the current version for client re-read.
   */
  async updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<schema.NewCostReportWorksheet, "data" | "computedAt">>,
  ): Promise<VersionedUpdateResult<schema.CostReportWorksheet>> {
    const [row] = await this.db
      .update(W)
      .set({ ...patch, version: expectedVersion + 1, updatedAt: new Date() })
      .where(and(eq(W.id, id), eq(W.version, expectedVersion)))
      .returning();
    if (row) return { ok: true, row };
    const current = await this.findById(id);
    return { ok: false, conflict: "VERSION_CONFLICT", currentVersion: current?.version ?? null };
  }
}
