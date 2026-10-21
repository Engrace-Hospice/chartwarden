// @chartwarden/db — `cahps_export_job` (M30 §4.1 R-14/R-15; migration 0421, GAP-087). The durable CAHPS vendor
// export job: one row per R-14 request, driven queued -> running -> completed|failed by the `m30.cahps_export`
// worker. The rendered vendor file (caregiver names / phones / emails — PHI) is stored ONLY as a tenant-DEK
// envelope in `file_cipher` (audit-denylisted, §3.6). ORG-SCOPED (canonical app.org_id RLS). `vendor_binding_id`
// is a logical FK to `cahps_vendor_binding` (the binding may later be retired; the job keeps its adapter id).
import { date, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const cahpsExportJob = pgTable("cahps_export_job", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  vendorBindingId: uuid("vendor_binding_id").notNull(),
  vendorAdapterId: text("vendor_adapter_id").notNull(),
  samplingCycleMonth: date("sampling_cycle_month").notNull(),
  samplePeriodStart: date("sample_period_start").notNull(),
  samplePeriodEnd: date("sample_period_end").notNull(),
  /** queued | running | completed | failed (CHECK-constrained in the migration). */
  status: text("status").notNull().default("queued"),
  decedentCount: integer("decedent_count").notNull().default(0),
  filename: text("filename"),
  mimeType: text("mime_type"),
  /** Tenant-DEK envelope of the rendered file bytes (base64 inside the envelope) — DENYLISTED (§3.6). */
  fileCipher: text("file_cipher"),
  fileSha256: text("file_sha256"),
  /** pushed | no_push (CHECK-constrained). */
  pushStatus: text("push_status"),
  vendorJobId: text("vendor_job_id"),
  failureReason: text("failure_reason"),
  requestedByUserId: uuid("requested_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type CahpsExportJobRow = typeof cahpsExportJob.$inferSelect;
export type NewCahpsExportJobRow = typeof cahpsExportJob.$inferInsert;
