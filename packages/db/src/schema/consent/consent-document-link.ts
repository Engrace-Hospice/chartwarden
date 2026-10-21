// @chartwarden/db — `consent_document_link` (M39 Consent §3.3 #9). The back-ref join to the M22 signed
// PDF (D15): consent_record_id (PK, 1:1) ↔ M22 document_id + version. Stamped by the
// m22-document-backref consumer when m22.document.rendered fires for the consent_record template.
// M39 stores only the link; M22 holds the bytes. Org-scoped child of consent_record → standard
// app.org_id RLS in M39-T03. document_id / document_version_id are app-validated M22 ids (no FK).
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { consentRecord } from "./consent-record";

export const consentDocumentLink = pgTable(
  "consent_document_link",
  {
    consentRecordId: uuid("consent_record_id")
      .primaryKey()
      .references(() => consentRecord.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    documentId: uuid("document_id").notNull(), // M22 FK; app-side only
    documentVersionId: uuid("document_version_id").notNull(),
    templateVersion: text("template_version").notNull(),
    renderedAt: timestamp("rendered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    docIdx: index("ix_cdl_document").on(t.documentId),
  }),
);

export type ConsentDocumentLink = typeof consentDocumentLink.$inferSelect;
export type NewConsentDocumentLink = typeof consentDocumentLink.$inferInsert;
