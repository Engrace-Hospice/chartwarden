// @wardenx/db — `consent_record_recipient` (M39 Consent §3.3 #4). The per-recipient grant join (D6)
// for the four per-recipient consent types: each named recipient (M40 entity by kind, or free-text)
// with an optional purpose limitation + per-recipient expiry. Adding/removing a recipient does NOT
// supersede the parent consent record (§2.2.2). Org-scoped child of consent_record (no patient
// field of its own) → standard app.org_id RLS in M39-T03. The recipient_entity_id ↔ recipient_kind
// FK is service-validated against the M40 MdmEntityProvider seam (no hard cross-module FK).
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { consentRecipientKind } from "../../enums";
import { organizations } from "../organizations";
import { consentRecord } from "./consent-record";

export const consentRecordRecipient = pgTable(
  "consent_record_recipient",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    consentRecordId: uuid("consent_record_id")
      .notNull()
      .references(() => consentRecord.id, { onDelete: "restrict" }),
    recipientKind: consentRecipientKind("recipient_kind").notNull(),
    recipientEntityId: uuid("recipient_entity_id"), // M40 FK by kind; service validates
    recipientFreeText: text("recipient_free_text"),
    recipientResolvedDisplayName: text("recipient_resolved_display_name").notNull(),
    purposeCode: text("purpose_code"), // M38 value set ref
    purposeFreeText: text("purpose_free_text"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    addedById: uuid("added_by_id").notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedById: uuid("removed_by_id"),
    removedReasonText: text("removed_reason_text"),
  },
  (t) => ({
    consentIdx: index("ix_crr_consent").on(t.consentRecordId),
    activeByConsentIdx: index("ix_crr_active_by_consent")
      .on(t.consentRecordId)
      .where(sql`removed_at IS NULL`),
    resolvedEntityIdx: index("ix_crr_resolved_entity")
      .on(t.recipientKind, t.recipientEntityId)
      .where(sql`removed_at IS NULL`),
    freeTextOrEntity: check(
      "crr_freetext_or_entity",
      sql`(recipient_kind = 'free_text' AND recipient_entity_id IS NULL AND recipient_free_text IS NOT NULL)
       OR (recipient_kind <> 'free_text' AND recipient_entity_id IS NOT NULL)`,
    ),
  }),
);

export type ConsentRecordRecipient = typeof consentRecordRecipient.$inferSelect;
export type NewConsentRecordRecipient = typeof consentRecordRecipient.$inferInsert;
