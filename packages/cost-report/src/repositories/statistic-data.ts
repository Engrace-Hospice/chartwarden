// @chartwarden/cost-report · repositories — the S-3 statistical inputs: `statistic_data` (one row per cost
// report — UNIQUE cost_report_id — aggregating M6 level-of-care periods, M8 encounter stats, and M23
// billed days (deny-stub today) into monthly-by-LOC-by-program breakdowns + visit counts + FTE +
// bereavement census) (M27 §3.3). ORG-SCOPED; the statistics service wraps these in `withOrgContext` and
// owns the seam-fan-in refresh. AGGREGATE-ONLY (D18) — counts by month/LOC/program, never a patient id.
import { schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";
import type { CostReportDb } from "./db";

const ST = schema.statisticData;

/** Data port for `statistic_data` (one row per report; upsert-on-refresh). */
export class StatisticDataRepository {
  constructor(private readonly db: CostReportDb) {}

  async create(values: schema.NewStatisticData): Promise<schema.StatisticData> {
    const [row] = await this.db.insert(ST).values(values).returning();
    if (!row) throw new Error("statistic_data insert returned no row");
    return row;
  }

  async findById(id: string): Promise<schema.StatisticData | null> {
    const [row] = await this.db.select().from(ST).where(eq(ST.id, id)).limit(1);
    return row ?? null;
  }

  /** The single statistics row for a report (the `cost_report_id` UNIQUE surface), or `null`. */
  async findByReport(
    organizationId: string,
    costReportId: string,
  ): Promise<schema.StatisticData | null> {
    const [row] = await this.db
      .select()
      .from(ST)
      .where(and(eq(ST.organizationId, organizationId), eq(ST.costReportId, costReportId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Refresh the materialized statistics (replace the breakdown jsonb wholesale + stamp refresh metadata),
   * bumping `version`. Returns the updated row.
   */
  async update(
    id: string,
    patch: Partial<
      Pick<
        schema.NewStatisticData,
        | "monthlyBreakdown"
        | "visitCountsByDiscipline"
        | "fteCalculations"
        | "bereavementCensus"
        | "refreshedByMembershipId"
      >
    >,
    expectedVersion: number,
  ): Promise<schema.StatisticData> {
    const [row] = await this.db
      .update(ST)
      .set({ ...patch, version: expectedVersion + 1, refreshedAt: new Date() })
      .where(eq(ST.id, id))
      .returning();
    if (!row) throw new Error(`statistic_data ${id} not found for update`);
    return row;
  }
}
