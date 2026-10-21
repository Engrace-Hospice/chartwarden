import { sql } from "drizzle-orm";
// @chartwarden/db — `patient_pseudonym_key` (M35 §3.3). M35-private catalog of the active + historic HMAC
// keys used for patient/user pseudonym computation. PLATFORM-ONLY (no organization_id) — never exposed
// to tenant queries; read+write via chartwarden_admin only (0143). The key bytes are envelope-encrypted at
// the application layer (KMS-wrapped). §3.6 requests FULL AUDIT EXCLUSION — the key-rotation timeline
// must never enter the audit log — so NO write-audit trigger is attached (the column has no `organization_id`
// substring, so the phi-guards gate does not force one). Listed in check-tenancy's NON_ORG_SCOPED set.
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const patientPseudonymKey = pgTable(
  "patient_pseudonym_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyEpoch: text("key_epoch").notNull(),
    keyMaterialCiphertext: text("key_material_ciphertext").notNull(),
    keyKmsRef: text("key_kms_ref").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    epochUq: uniqueIndex("patient_pseudonym_key_epoch_uq").on(t.keyEpoch),
    oneActiveUq: uniqueIndex("patient_pseudonym_key_one_active_uq")
      .on(t.isActive)
      .where(sql`is_active = true`),
  }),
);

export type PatientPseudonymKeyRow = typeof patientPseudonymKey.$inferSelect;
export type NewPatientPseudonymKeyRow = typeof patientPseudonymKey.$inferInsert;
