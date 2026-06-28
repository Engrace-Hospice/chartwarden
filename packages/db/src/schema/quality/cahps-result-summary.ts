// @wardenx/db — `cahps_result_summary` (M30 §3.3; non-partitioned; retention class `compliance`).
// The ingested CAHPS Hospice results for a reporting period: per-question top-box percentages, the six
// CMS composites, response counts, and the dedup hash of the vendor payload. ORG-SCOPED:
// organization_id NOT NULL (canonical app.org_id RLS). provider_entity_id is a logical FK to M40. No
// PHI (aggregate scores only); no audit denylist.
import {
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import type { CahpsCompositeScores, CahpsTopBoxPercentages } from "./types";

export const cahpsResultSummary = pgTable(
  "cahps_result_summary",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    reportingPeriodStart: date("reporting_period_start").notNull(),
    reportingPeriodEnd: date("reporting_period_end").notNull(),
    vendorAdapterId: text("vendor_adapter_id").notNull(),
    topBoxPercentages: jsonb("top_box_percentages").$type<CahpsTopBoxPercentages>().notNull(), // per-question top-box pct
    compositeScores: jsonb("composite_scores").$type<CahpsCompositeScores>().notNull(), // 6 CMS composites
    responseCount: integer("response_count").notNull(),
    attemptedSampleCount: integer("attempted_sample_count").notNull(),
    responseRate: numeric("response_rate", { precision: 5, scale: 4 }),
    vendorResponsePayloadHash: text("vendor_response_payload_hash").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqIdempotent: uniqueIndex("uq_cahps_result_idempotent").on(
      t.providerEntityId,
      t.vendorAdapterId,
      t.reportingPeriodStart,
      t.reportingPeriodEnd,
      t.vendorResponsePayloadHash,
    ),
  }),
);

export type CahpsResultSummary = typeof cahpsResultSummary.$inferSelect;
export type NewCahpsResultSummary = typeof cahpsResultSummary.$inferInsert;
