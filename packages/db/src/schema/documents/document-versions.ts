// @wardenx/db — `document_version` (M22 §3.3 / §2.2.2). Append-only version ledger for `document`: one row per
// stored byte payload (a MinIO object). "Superseding" never edits a version — it inserts a new version row and
// flips `document.active_version_id` at the service layer (F19/§2.2.2; there is no per-version is_current
// flag). Org-scoped; PHI-adjacent (the MinIO object key embeds tenant+patient prefix, and `byte_payload_cipher`
// holds DEK-encrypted in-row PHI) but carries no `patient_id` column → only org-scope RLS applies. The
// `minio_object_key` (structural; contains tenant+patient prefix) and `byte_payload_cipher` columns are
// DENYLISTED in the §3.6 write-audit trigger. RLS + grants + the M4 write-audit trigger land in 0049.
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../organizations";
import { documents } from "./documents";

export const documentVersions = pgTable(
  "document_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    versionNumber: text("version_number").notNull(), // app-side serial within document
    replacesVersionId: uuid("replaces_version_id"),
    minioObjectKey: text("minio_object_key").notNull(), // contains tenant+patient prefix → DENYLISTED (§3.6)
    mimeType: text("mime_type").notNull(),
    byteSize: text("byte_size").notNull(), // bigint stored as text per M1 convention
    sha256Hex: text("sha256_hex").notNull(),
    // last integrity re-hash pass (RenderedDocumentProvider.getVersionWithIntegrityCheck, §8.1)
    sha256VerifiedAt: timestamp("sha256_verified_at", { withTimezone: true }),
    // DEK-encrypted PHI metadata if version contains in-row PHI → DENYLISTED (§3.6)
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
    byOrgCreated: index("document_version_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    uploaderShape: check(
      "document_version_uploader_shape",
      sql`(uploaded_by_kind = 'user') = (uploaded_by_membership_id IS NOT NULL)`,
    ),
  }),
);

export type DocumentVersion = typeof documentVersions.$inferSelect;
export type NewDocumentVersion = typeof documentVersions.$inferInsert;
