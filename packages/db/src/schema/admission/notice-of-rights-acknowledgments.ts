// @wardenx/db — `notice_of_rights_acknowledgment` (M6 §3.3). The beneficiary's acknowledgment of the
// hospice notice of rights at admission. PHI-bearing (carries a patient reference) → the three-column
// tenancy rule (org NOT NULL + nullable provider_entity_id / location_id). `witness_user_id` is an M1
// user (FK); cross-module refs (M5 patient, M39 representative consent, M22 document) are plain uuid
// app-validated; the admission FK is intra-M6. One acknowledgment per admission (unique). RLS + the
// M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import { bigint, date, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { electionSignerKind, norAcknowledgmentMethod } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { users } from "../users";
import { admissions } from "./admissions";

export const noticeOfRightsAcknowledgments = pgTable(
  "notice_of_rights_acknowledgment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }), // ARCH-011 (nullable)
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }), // ARCH-011 (nullable)
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    signerKind: electionSignerKind("signer_kind").notNull(),
    representativeConsentId: uuid("representative_consent_id"), // M39 consent (app-validated)
    acknowledgedAt: date("acknowledged_at").notNull(),
    acknowledgmentMethod: norAcknowledgmentMethod("acknowledgment_method").notNull(),
    witnessUserId: uuid("witness_user_id").references(() => users.id, { onDelete: "set null" }),
    documentId: uuid("document_id"), // M22 document (app-validated)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    admUnique: uniqueIndex("nor_admission_idx").on(t.admissionId),
  }),
);

export type NoticeOfRightsAcknowledgment = typeof noticeOfRightsAcknowledgments.$inferSelect;
export type NewNoticeOfRightsAcknowledgment = typeof noticeOfRightsAcknowledgments.$inferInsert;
