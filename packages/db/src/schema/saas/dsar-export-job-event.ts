// @chartwarden/db — `dsar_export_job_event` (M34 SaaS Tenant Platform §3.7). The append-only
// disclosure-accounting ledger for a DSAR export job: one row per status transition / shard receipt.
//
// M34-F02 / M34-F10 / ADR-0010: NEW table — carries its own `organization_id` NOT NULL
// (denormalized from the parent job) so the canonical app.org_id RLS predicate applies directly,
// and as the LIST co-partition key. The parent `dsar_export_job_id` is a plain uuid app-validated
// cross-row ref; only the org spine carries a SQL FK.
//
// Co-partitioned LIST organization_id → RANGE occurred_at (sub-partition DDL in §3.10; registered
// in partition.rotate, OPS-021): the Drizzle definition here is the LOGICAL shape (composite PK
// incl. the partition keys); the PARTITION BY + children land in the RLS migration (0052), which
// drops the plain table 0051 emits and re-creates it partitioned (the M18 `evv_event` precedent).
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const dsarExportJobEvent = pgTable(
  "dsar_export_job_event",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with the partition keys
    // M34-F02 / M34-F10 / ADR-0010: tenant-scoping key + LIST co-partition key.
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    dsarExportJobId: uuid("dsar_export_job_id").notNull(), // parent job (app-validated)
    eventKind: text("event_kind").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    shardReceipt: jsonb("shard_receipt"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(), // RANGE partition key
  },
  (t) => ({
    // Partition keys (organization_id LIST → occurred_at RANGE) must be in the PK.
    pk: primaryKey({ columns: [t.id, t.organizationId, t.occurredAt] }),
    // M34-F02 / ADR-0010: SD-028 composite index leads with organization_id.
    orgOccurredIdx: index("dsar_event_org_occurred_idx").on(t.organizationId, t.occurredAt),
    jobEventIdx: index("dsar_event_job_idx").on(t.dsarExportJobId, t.occurredAt),
  }),
);

export type DsarExportJobEvent = typeof dsarExportJobEvent.$inferSelect;
export type NewDsarExportJobEvent = typeof dsarExportJobEvent.$inferInsert;
