// @chartwarden/db — `hope_submission_result_event` (M10 Phase 7). External iQIES / FVR results
// are stored separately from ChartWarden-computed `hope_validation_finding` rows so provenance stays clear.
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { hopeSubmissionItems } from "./hope-submission-items";
import { hopeSubmissions } from "./hope-submissions";

export const hopeSubmissionResultEvents = pgTable(
  "hope_submission_result_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    hopeSubmissionId: uuid("hope_submission_id")
      .notNull()
      .references(() => hopeSubmissions.id, { onDelete: "restrict" }),
    hopeSubmissionItemId: uuid("hope_submission_item_id").references(() => hopeSubmissionItems.id, {
      onDelete: "restrict",
    }),
    source: text("source").notNull().default("iqies"),
    reportHash: text("report_hash").notNull(),
    reportReference: text("report_reference"),
    resultScope: text("result_scope").notNull().default("record"),
    resultStatus: text("result_status").notNull(),
    cmsSeverity: text("cms_severity"),
    cmsEditCode: text("cms_edit_code"),
    itemCode: text("item_code"),
    message: text("message"),
    rawResult: jsonb("raw_result"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySubmission: index("idx_hope_sub_result_submission").on(t.hopeSubmissionId, t.resultStatus),
    byItem: index("idx_hope_sub_result_item").on(t.hopeSubmissionItemId, t.cmsEditCode),
    uniqueImportedFinding: uniqueIndex("uniq_hope_sub_result_event_import")
      .on(
        t.hopeSubmissionId,
        t.hopeSubmissionItemId,
        t.reportHash,
        t.resultScope,
        t.cmsEditCode,
        t.itemCode,
      )
      .where(sql`cms_edit_code IS NOT NULL`),
  }),
);

export type HopeSubmissionResultEvent = typeof hopeSubmissionResultEvents.$inferSelect;
export type NewHopeSubmissionResultEvent = typeof hopeSubmissionResultEvents.$inferInsert;
