// @chartwarden/db — `destruction_certificate` (M4 Audit §3.5, §2.4.2). The accountable record of a
// retention-driven destruction run: what data class, how many rows, over which range, by which
// method, and its state-machine status (`partial_refused` covers the §6 eraser refusing Part 2
// rows during the patient lifetime — W-M4-09). Org-scoped on organization_id (standard app.org_id
// RLS lands in M4-T05); not a PHI table (carries counts/ranges/refs only, no PE/location columns).
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { destructionStatus } from "../enums";
import { organizations } from "./organizations";
import { users } from "./users";

export const destructionCertificates = pgTable(
  "destruction_certificate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    dataClass: text("data_class").notNull(),
    /** What the approver approved. Immutable once the certificate leaves `pending` (migration 1159 guard). */
    recordCount: integer("record_count").notNull(),
    /** M36 message executor (migration 1159): committed deletions, only ever goes up. */
    destroyedCount: integer("destroyed_count").notNull().default(0),
    /** Planned but not yet settled batches. remaining = record_count - destroyed_count - reserved_count. */
    reservedCount: integer("reserved_count").notNull().default(0),
    dateRangeStart: timestamp("date_range_start", { withTimezone: true }).notNull(),
    dateRangeEnd: timestamp("date_range_end", { withTimezone: true }).notNull(),
    method: text("method").notNull(), // crypto_erasure | secure_delete
    status: destructionStatus("status").notNull().default("pending"),
    approvedBy: uuid("approved_by").references(() => users.id),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    /** M34 shred evidence: when the tenant DEK crossed the irreversible destruction boundary. */
    dekDestroyedAt: timestamp("dek_destroyed_at", { withTimezone: true }),
    /** Typed refusal evidence for a Part 2 re-defer; null on a completed certificate. */
    refusalReason: text("refusal_reason"),
    /** Per-data-class refused row counts captured before the DEK destruction gate. */
    refusedRowsByModule: jsonb("refused_rows_by_module").notNull().default([]),
    certificatePdfRef: uuid("certificate_pdf_ref"), // MinIO doc id
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("destruction_cert_org_idx").on(t.organizationId),
  }),
);

export type DestructionCertificate = typeof destructionCertificates.$inferSelect;
export type NewDestructionCertificate = typeof destructionCertificates.$inferInsert;
