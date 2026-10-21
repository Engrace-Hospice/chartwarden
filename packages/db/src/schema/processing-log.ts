// @chartwarden/db — `processing_log` (M1 Foundation). The §4.8 BullMQ worker consumer-idempotency ledger:
// every M30/M33-style background worker opens its `process()` with an `already_processed` short-circuit
// against this table (the application-layer complement to BullMQ `removeOnComplete`, so a job replayed
// from the DLQ — or re-delivered after a crash before its ack — never re-applies its effects). HELPER-ONLY
// in spirit (workers read/write it exclusively by exact `job_id`, never a cross-job scan): a feature module
// binds `ProcessingLogPort` over this table, it never queries it directly. org-scoped: carries
// organization_id (no PHI columns → three-column PE/location not required, WX-PR-014).
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const processingLog = pgTable(
  "processing_log",
  {
    // The BullMQ job id (globally unique per queue) — the idempotency key itself, not a synthetic row id.
    jobId: text("job_id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    queueName: text("queue_name").notNull(),
    outcome: jsonb("outcome").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgProcessedIdx: index("processing_log_org_processed_idx").on(t.organizationId, t.processedAt),
  }),
);

export type ProcessingLogRow = typeof processingLog.$inferSelect;
export type NewProcessingLogRow = typeof processingLog.$inferInsert;
