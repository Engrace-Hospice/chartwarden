// @wardenx/billing · repositories — `wage_index_factor` (platform-shared per-CCN annual CMS wage-index
// schedule, §3.3, D12; non-partitioned; retention class `reference`). The ONLY M23 table with NO
// `organization_id` — PLATFORM-SHARED reference data consumed by the HIPPS/per-diem calculator at claim
// assembly (snapshotted onto `per_diem_rate_calculation` so the math stays reproducible).
//
// PLATFORM-READ-ONLY (D12 / §3.2 Phase D): the migration REVOKEs INSERT on this table from `app_user`; only
// the `platform_loader` role loads CMS rate files. This repo therefore offers READS ONLY — there is NO
// create/insert/update/delete surface. The annual CMS-file load is a platform-loader job, NOT a tenant
// write path, and is deliberately absent from this data port. RLS on the table is SELECT `USING (true)` for
// `app_user`, so these reads need no `app.org_id` scope (and the service still runs them under
// `withOrgContext` for uniformity). No PHI (D18).
import * as schema from "@wardenx/db/schema";
import { and, desc, eq } from "drizzle-orm";
import {
  type BillingDb,
  type CursorPage,
  buildCursorPage,
  decodeCursor,
  keysetBefore,
  pageSizeOf,
} from "./db";

const W = schema.wageIndexFactor;

/** Data port for `wage_index_factor` (PLATFORM-READ-ONLY: reads only; loads are a platform_loader job). */
export class WageIndexFactorRepository {
  constructor(private readonly db: BillingDb) {}

  /** Point read by id, or `null`. */
  async findById(id: string): Promise<schema.WageIndexFactor | null> {
    const [row] = await this.db.select().from(W).where(eq(W.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * The wage-index factor for a `(ccn, fiscal_year_starting)` — the deterministic lookup (the
   * `wage_index_factor_ccn_fy_uq` unique surface) the HIPPS calculator performs per claim, with the fiscal
   * year derived from the claim's service period by the service layer. Returns `null` when CMS has not
   * loaded a factor for that CCN/year (the calculator then fails closed / surfaces a validation error).
   */
  async findByCcnAndFiscalYear(
    ccn: string,
    fiscalYearStarting: number,
  ): Promise<schema.WageIndexFactor | null> {
    const [row] = await this.db
      .select()
      .from(W)
      .where(and(eq(W.ccn, ccn), eq(W.fiscalYearStarting, fiscalYearStarting)))
      .limit(1);
    return row ?? null;
  }

  /**
   * One keyset page of every CCN's factor for a fiscal year (`loaded_at DESC, id DESC`) — the
   * platform/admin review of a loaded CMS rate file. Over-fetches `size + 1` rows so {@link buildCursorPage}
   * reveals `hasMore` + mints the next cursor.
   */
  async listForFiscalYearPage(
    fiscalYearStarting: number,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<schema.WageIndexFactor>> {
    const size = pageSizeOf(limit);
    const where = and(
      eq(W.fiscalYearStarting, fiscalYearStarting),
      keysetBefore(W.loadedAt, W.id, cursor ? decodeCursor(cursor) : undefined),
    );
    const rows = await this.db
      .select()
      .from(W)
      .where(where)
      .orderBy(desc(W.loadedAt), desc(W.id))
      .limit(size + 1);
    return buildCursorPage(rows, size, (r) => ({ createdAt: r.loadedAt.toISOString(), id: r.id }));
  }
}
