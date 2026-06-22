// @wardenx/db — `patient_communication_preference` (M5 §3.4). One row per patient (patient_id PK):
// preferred language/channel, interpreter need, accessible format, do-not-contact/mail flags.
// PHI-bearing → three-column tenancy rule.
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { patients } from "./patients";

export const patientCommunicationPreferences = pgTable("patient_communication_preference", {
  patientId: uuid("patient_id")
    .primaryKey()
    .references(() => patients.id, { onDelete: "restrict" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
    onDelete: "restrict",
  }),
  locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
  preferredLanguageCode: text("preferred_language_code"), // ISO-639 via M38
  interpreterNeeded: boolean("interpreter_needed").notNull().default(false),
  preferredChannel: text("preferred_channel"), // 'phone' | 'sms' | 'email' | 'portal'
  accessibleFormat: text("accessible_format"), // 'large_print' | 'braille' | 'audio' | null
  doNotContact: boolean("do_not_contact").notNull().default(false),
  doNotMailReason: text("do_not_mail_reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PatientCommunicationPreference = typeof patientCommunicationPreferences.$inferSelect;
export type NewPatientCommunicationPreference = typeof patientCommunicationPreferences.$inferInsert;
