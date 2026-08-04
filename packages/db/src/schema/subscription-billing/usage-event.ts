import { sql } from "drizzle-orm";
// @wardenx/db — `usage_event` (M35 §3.3). TENANT-SCOPED, RLS on app.org_id (0143). Append-only, high
// volume, MONTHLY-PARTITIONED by `recorded_at` (declared `PARTITION BY RANGE (recorded_at)` in migration
// 0142). PostgreSQL requires the partition key in every unique/primary constraint, so the REAL keys in
// SQL are the composite PK `(id, recorded_at)` and the dedup unique
// `(organization_id, source_module, source_event_id, recorded_at)`; the `.primaryKey()` on `id` below is
// only the ORM's view of row identity (Drizzle cannot express a partitioned table). Its write-audit
// trigger is a GENERATED function that hard-codes the parent name, because M1's baseline trigger would
// stamp `TG_TABLE_NAME` = the dated partition (the M32 `ai_token_ledger` lesson). `organization_id` is a
// logical uuid (M35-F04); `metadata_redacted` is PHI-free (redactor-checked).
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { usageEventSourceModule, usageEventType } from "../../enums";

export const usageEvent = pgTable(
  "usage_event",
  {
    // Composite PK (id, recorded_at) declared in SQL (0142) — see header.
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    subscriptionId: uuid("subscription_id"),
    eventType: usageEventType("event_type").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
    sourceModule: usageEventSourceModule("source_module").notNull(),
    sourceEventId: text("source_event_id"),
    metadataRedacted: jsonb("metadata_redacted").notNull().default({}),
  },
  (t) => ({
    sourceDedupUq: uniqueIndex("usage_event_source_dedup_uq")
      .on(t.organizationId, t.sourceModule, t.sourceEventId, t.recordedAt)
      .where(sql`source_event_id IS NOT NULL`),
    orgRecordedIx: index("usage_event_org_recorded_ix").on(t.organizationId, t.recordedAt),
    eventTypeIx: index("usage_event_event_type_ix").on(t.eventType, t.recordedAt),
  }),
);

export type UsageEventRow = typeof usageEvent.$inferSelect;
export type NewUsageEventRow = typeof usageEvent.$inferInsert;
