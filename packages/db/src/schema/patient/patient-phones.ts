// @chartwarden/db — `patient_phone` (M5 §3.3). E.164-normalized phone numbers. PHI-bearing →
// three-column tenancy rule. One primary per patient.
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { patientPhoneKind } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { patients } from "./patients";

export const patientPhones = pgTable(
  "patient_phone",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    kind: patientPhoneKind("kind").notNull().default("home"),
    e164: text("e164").notNull(), // normalized E.164
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("patient_phone_patient_idx").on(t.patientId),
    primaryUnique: uniqueIndex("patient_phone_primary_unique")
      .on(t.patientId)
      .where(sql`${t.isPrimary} = true`),
  }),
);

export type PatientPhone = typeof patientPhones.$inferSelect;
export type NewPatientPhone = typeof patientPhones.$inferInsert;
