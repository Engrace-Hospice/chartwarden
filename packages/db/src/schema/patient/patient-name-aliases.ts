// @wardenx/db — `patient_name_alias` (M5 §3.3). Preferred / maiden / AKA names. PHI-bearing →
// three-column tenancy rule. Name parts are on the M4 audit denylist (M5-T05). Append-style history.
import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { patients } from "./patients";

export const patientNameAliases = pgTable(
  "patient_name_alias",
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
    kind: text("kind").notNull(), // 'preferred' | 'maiden' | 'aka'
    firstName: text("first_name"),
    middleName: text("middle_name"),
    lastName: text("last_name"),
    fullName: text("full_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("patient_name_alias_patient_idx").on(t.patientId),
  }),
);

export type PatientNameAlias = typeof patientNameAliases.$inferSelect;
export type NewPatientNameAlias = typeof patientNameAliases.$inferInsert;
