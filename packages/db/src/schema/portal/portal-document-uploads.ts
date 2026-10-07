// @wardenx/db — `portal_document_upload` (M31 §3.3; migration 0423, GAP-092). The ENCRYPTED STAGING row behind a
// portal document upload: the bytes the caregiver PUT, sealed under the tenant DEK in `content_cipher`
// (audit-denylisted, §3.6), until `upload-complete` hands them to M22's intake and clears them. Patient-bearing, so
// it carries the ARCH-011 provider_entity_id NOT NULL + location_id (nullable), copied from the account's active grant.
// `document_id` / `intake_batch_id` are logical FKs into M22 (app-validated; no cross-module DB FK).
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { portalAccounts } from "./portal-accounts";

export const portalDocumentUploads = pgTable(
  "portal_document_upload",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    portalAccountId: uuid("portal_account_id")
      .notNull()
      .references(() => portalAccounts.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical FK → M5 patient
    purpose: text("purpose").notNull(),
    declaredMime: text("declared_mime").notNull(),
    expectedByteSize: integer("expected_byte_size").notNull(),
    /** initiated | staged | submitted | rejected | expired (CHECK-constrained in the migration). */
    status: text("status").notNull().default("initiated"),
    /** Tenant-DEK envelope of the staged bytes — present exactly while `status = 'staged'`; DENYLISTED (§3.6). */
    contentCipher: text("content_cipher"),
    contentKeyVersion: integer("content_key_version"),
    byteSize: integer("byte_size"),
    contentSha256: text("content_sha256"),
    rejectionCode: text("rejection_code"),
    documentId: uuid("document_id"), // logical FK → M22 document
    intakeBatchId: uuid("intake_batch_id"), // logical FK → M22 intake batch
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    stagedAt: timestamp("staged_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountIdx: index("portal_document_upload_account_idx").on(t.portalAccountId, t.createdAt),
    orgStatusIdx: index("portal_document_upload_org_status_idx").on(
      t.organizationId,
      t.status,
      t.createdAt,
    ),
    patientIdx: index("portal_document_upload_patient_idx").on(t.patientId),
  }),
);

export type PortalDocumentUploadRow = typeof portalDocumentUploads.$inferSelect;
export type NewPortalDocumentUploadRow = typeof portalDocumentUploads.$inferInsert;
