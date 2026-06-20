// @wardenx/db — `patient_email` (M5 §3.3). Email addresses. PHI-bearing → three-column tenancy rule.
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { patients } from "./patients";

export const patientEmails = pgTable(
  "patient_email",
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
    email: text("email").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("patient_email_patient_idx").on(t.patientId),
  }),
);

export type PatientEmail = typeof patientEmails.$inferSelect;
export type NewPatientEmail = typeof patientEmails.$inferInsert;
