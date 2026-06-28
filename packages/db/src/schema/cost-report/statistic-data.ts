// @wardenx/db — `statistic_data` (M27 §3.3; non-partitioned; retention class `compliance`). One row per
// cost report (UNIQUE cost_report_id): the S-3 statistical inputs aggregated from M6 (level-of-care
// periods), M8 (encounter stats), and M23 (billed days, deny-stub today). monthly_breakdown is by month
// × LOC × program; visit_counts_by_discipline / fte_calculations / bereavement_census back S-3 Parts
// II-IV. AGGREGATE-ONLY (D18) — no patient identifier; counts by month/LOC/program only. ORG-SCOPED.
import { index, integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { costReport } from "./cost-report";
import type {
  BereavementCensus,
  FteCalculations,
  StatisticMonthlyBreakdown,
  VisitCountsByDiscipline,
} from "./types";

export const statisticData = pgTable(
  "statistic_data",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    costReportId: uuid("cost_report_id")
      .notNull()
      .unique()
      .references(() => costReport.id, { onDelete: "cascade" }),
    monthlyBreakdown: jsonb("monthly_breakdown").$type<StatisticMonthlyBreakdown>().notNull(),
    visitCountsByDiscipline: jsonb("visit_counts_by_discipline")
      .$type<VisitCountsByDiscipline>()
      .notNull(),
    fteCalculations: jsonb("fte_calculations").$type<FteCalculations>().notNull(),
    bereavementCensus: jsonb("bereavement_census").$type<BereavementCensus>().notNull(),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
    refreshedByMembershipId: uuid("refreshed_by_membership_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    idxOrgReport: index("idx_stats_org_report").on(t.organizationId, t.costReportId),
  }),
);

export type StatisticData = typeof statisticData.$inferSelect;
export type NewStatisticData = typeof statisticData.$inferInsert;
