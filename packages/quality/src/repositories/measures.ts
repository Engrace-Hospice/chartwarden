// @chartwarden/quality · repositories — the HQRP measure-value ledger: `quality_measure_value` (the
// append-only / soft-supersede ledger of computed HQRP measures — one CURRENT row per (measure,
// provider_entity, period) with `superseded_at IS NULL`; recompute writes a new row and stamps the
// prior) (M30 §3.3). ORG-SCOPED; the measure-recompute worker / read service wrap these in
// `withOrgContext`. `computation_snapshot` is audit-denylisted (§3.6); this port never reads it back to
// a PHI-exposed surface — it returns the whole `$inferSelect` row and the service projects.
import { schema } from "@chartwarden/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { QualityDb } from "./db";

const V = schema.qualityMeasureValue;

/** Data port for `quality_measure_value`. */
export class QualityMeasureValueRepository {
  constructor(private readonly db: QualityDb) {}

  /** Insert a computed measure row (the new current value). Returns the inserted row. */
  async insertValue(values: schema.NewQualityMeasureValue): Promise<schema.QualityMeasureValue> {
    const [row] = await this.db.insert(V).values(values).returning();
    if (!row) throw new Error("quality_measure_value insert returned no row");
    return row;
  }

  /** Fetch a measure-value row by id, or `null`. */
  async findById(id: string): Promise<schema.QualityMeasureValue | null> {
    const [row] = await this.db.select().from(V).where(eq(V.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * The single CURRENT value for a (measure, provider_entity, period) — the row with `superseded_at IS
   * NULL` (the V-4 partial-unique surface), or `null`.
   */
  async findCurrent(
    measureCode: string,
    providerEntityId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<schema.QualityMeasureValue | null> {
    const [row] = await this.db
      .select()
      .from(V)
      .where(
        and(
          eq(V.measureCode, measureCode),
          eq(V.providerEntityId, providerEntityId),
          eq(V.periodStart, periodStart),
          eq(V.periodEnd, periodEnd),
          isNull(V.supersededAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The current measure scorecard for a provider (§3.4 `idx_quality_measure_value_by_period`): the
   * CURRENT rows (`superseded_at IS NULL`), optionally narrowed to one measure, newest period first.
   */
  async listCurrentForProvider(
    organizationId: string,
    providerEntityId: string,
    opts: { measureCode?: string; limit?: number } = {},
  ): Promise<readonly schema.QualityMeasureValue[]> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const where = and(
      eq(V.organizationId, organizationId),
      eq(V.providerEntityId, providerEntityId),
      isNull(V.supersededAt),
      opts.measureCode ? eq(V.measureCode, opts.measureCode) : undefined,
    );
    return this.db.select().from(V).where(where).orderBy(desc(V.periodEnd)).limit(limit);
  }

  /**
   * The full recompute history for a (measure, provider_entity, period) — every row incl. superseded
   * ones, newest first (the measure-value trend/audit surface).
   */
  async listHistory(
    measureCode: string,
    providerEntityId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<readonly schema.QualityMeasureValue[]> {
    return this.db
      .select()
      .from(V)
      .where(
        and(
          eq(V.measureCode, measureCode),
          eq(V.providerEntityId, providerEntityId),
          eq(V.periodStart, periodStart),
          eq(V.periodEnd, periodEnd),
        ),
      )
      .orderBy(desc(V.computedAt));
  }

  /**
   * Soft-supersede a prior current row (stamp `superseded_at` + the successor id) — the recompute
   * worker calls this then inserts the new current value in the SAME transaction. Returns the
   * superseded row.
   */
  async supersede(
    id: string,
    supersededBy: string,
    supersededAt: Date = new Date(),
  ): Promise<schema.QualityMeasureValue> {
    const [row] = await this.db
      .update(V)
      .set({ supersededAt, supersededBy })
      .where(and(eq(V.id, id), isNull(V.supersededAt)))
      .returning();
    if (!row) throw new Error(`quality_measure_value ${id} not found (or already superseded)`);
    return row;
  }
}
