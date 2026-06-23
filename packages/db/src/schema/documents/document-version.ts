// @wardenx/db — `document_version` (M22 §3.3 / §2.2.2). Append-only version ledger: one row per
// rendered/uploaded byte payload of a document. "Superseding" never edits a version — it inserts a
// new row and flips `document.active_version_id` (service-layer, F19/§2.2.2). No user soft-delete.
//
// Org-scoped (no patient_id of its own — joins to PHI via document_id). The MinIO object key carries
// a tenant+patient prefix (structural), so it is DENYLISTED in the audit trigger (§3.6) along with
// `byte_payload_cipher` (DEK-encrypted in-row PHI). `document_id` carries a SQL FK to the M22-owned
// `document`; `replaces_version_id` / `render_form_fill_id` are plain uuid app-validated.
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../organizations";
import { documents } from "./document";

export const documentVersions = pgTable(
  "document_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    versionNumber: text("version_number").notNull(), // app-side serial within document
    replacesVersionId: uuid("replaces_version_id"),
    minioObjectKey: text("minio_object_key").notNull(), // DENYLISTED (§3.6) — tenant+patient prefix
    mimeType: text("mime_type").notNull(),
    byteSize: text("byte_size").notNull(), // bigint stored as text per M1 convention
    sha256Hex: text("sha256_hex").notNull(),
    // last integrity re-hash pass (RenderedDocumentProvider.getVersionWithIntegrityCheck, §8.1).
    sha256VerifiedAt: timestamp("sha256_verified_at", { withTimezone: true }),
    // DEK-encrypted PHI metadata if version contains in-row PHI; DENYLISTED (§3.6).
    bytePayloadCipher: text("byte_payload_cipher"),
    uploadedByMembershipId: uuid("uploaded_by_membership_id"), // nullable for system_render
    uploadedByKind: text("uploaded_by_kind").notNull(), // user|system_render|api|portal|fax
    renderFormFillId: uuid("render_form_fill_id"), // populated when source_kind=form_render
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDocumentVersion: uniqueIndex("document_version_doc_version_uk").on(
      t.documentId,
      t.versionNumber,
    ),
    byMinioKey: uniqueIndex("document_version_minio_key_uk").on(t.minioObjectKey),
    bySha256: index("document_version_sha256_idx").on(t.sha256Hex),
    byOrgCreated: index("document_version_org_created_idx").on(
      t.organizationId,
      t.createdAt.desc(),
    ),
    uploaderShape: check(
      "document_version_uploader_shape",
      sql`(uploaded_by_kind = 'user') = (uploaded_by_membership_id IS NOT NULL)`,
    ),
  }),
);

export type DocumentVersion = typeof documentVersions.$inferSelect;
export type NewDocumentVersion = typeof documentVersions.$inferInsert;
