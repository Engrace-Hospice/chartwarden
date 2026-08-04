// @wardenx/db — `cost_report_worksheet` (M27 §3.3, D3; non-partitioned; retention class `compliance`).
// All 21 CMS-1984-14 worksheets share this table via the `worksheet_code` discriminator + a
// TypeBox-typed `data` jsonb (validated per-code at the service layer, P2). UNIQUE per
// (cost_report_id, worksheet_code). ORG-SCOPED. No PHI (D18).
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { costReport } from "./cost-report";
import type { WorksheetData } from "./types";

// The actual Form CMS-1984-14 worksheet set (certified — see audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md).
export const m27WorksheetCode = pgEnum("m27_worksheet_code", [
  "S",
  "S-1",
  "S-2",
  "A",
  "A-1",
  "A-2",
  "A-3",
  "A-4",
  "A-6",
  "A-8",
  "A-8-1",
  "B",
  "B-1",
  "C",
  "F",
  "F-1",
  "F-2",
]);

export const costReportWorksheet = pgTable(
  "cost_report_worksheet",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    costReportId: uuid("cost_report_id")
      .notNull()
      .references(() => costReport.id, { onDelete: "cascade" }),
    worksheetCode: m27WorksheetCode("worksheet_code").notNull(),
    data: jsonb("data").$type<WorksheetData>().notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqReportCode: unique("uniq_worksheet_report_code").on(t.costReportId, t.worksheetCode),
    idxOrgReport: index("idx_worksheet_org_report").on(t.organizationId, t.costReportId),
  }),
);

export type CostReportWorksheet = typeof costReportWorksheet.$inferSelect;
export type NewCostReportWorksheet = typeof costReportWorksheet.$inferInsert;
