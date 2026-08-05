import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { documentAggregateType, documentRetentionClass } from "../../enums";
import { organizations } from "../organizations";

/** Durable, tenant-scoped ledger for the presigned direct-upload protocol. */
export const documentUploads = pgTable(
  "document_upload",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    targetDocumentId: uuid("target_document_id"),
    patientId: uuid("patient_id"),
    admissionId: uuid("admission_id"),
    retentionClass: documentRetentionClass("retention_class").notNull(),
    aggregateType: documentAggregateType("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id"),
    title: text("title").notNull(),
    patientFacing: boolean("patient_facing").notNull().default(false),
    objectKey: text("object_key").notNull(),
    mimeType: text("mime_type").notNull(),
    expectedByteSize: text("expected_byte_size").notNull(),
    expectedSha256Hex: text("expected_sha256_hex").notNull(),
    status: text("status").notNull().default("pending"),
    completedDocumentId: uuid("completed_document_id"),
    completedVersionId: uuid("completed_version_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    objectKeyUnique: uniqueIndex("document_upload_object_key_uk").on(t.objectKey),
    pendingExpiry: index("document_upload_pending_expiry_idx").on(
      t.organizationId,
      t.status,
      t.expiresAt,
    ),
    statusShape: check(
      "document_upload_status_shape",
      sql`${t.status} in ('pending', 'completed', 'aborted', 'expired')`,
    ),
    byteSizeShape: check(
      "document_upload_byte_size_shape",
      sql`${t.expectedByteSize} ~ '^[1-9][0-9]*$'`,
    ),
    shaShape: check("document_upload_sha256_shape", sql`${t.expectedSha256Hex} ~ '^[0-9a-f]{64}$'`),
    completionShape: check(
      "document_upload_completion_shape",
      sql`(${t.status} = 'completed') = (${t.completedDocumentId} is not null and ${t.completedVersionId} is not null and ${t.completedAt} is not null)`,
    ),
  }),
);

export type DocumentUpload = typeof documentUploads.$inferSelect;
export type NewDocumentUpload = typeof documentUploads.$inferInsert;
