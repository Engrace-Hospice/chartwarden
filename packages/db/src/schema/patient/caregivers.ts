// @wardenx/db — `caregiver` (M5 §3.4). A caregiver person (org-scoped). Linked to patients via
// `patient_caregiver` (many-to-many) — carries no patient_id itself. Three-column tenancy rule.
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const caregivers = pgTable(
  "caregiver",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    preferredLanguageCode: text("preferred_language_code"), // ISO-639 via M38
    /** GAP-158 (migration 0462) - the M2 user who claimed this caregiver's portal login; logical FK, NULL until
     *  a portal invitation issued for this caregiver is accepted (`linkCaregiverToUserInTx`). */
    userId: uuid("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("caregiver_org_idx").on(t.organizationId),
  }),
);

export type Caregiver = typeof caregivers.$inferSelect;
export type NewCaregiver = typeof caregivers.$inferInsert;
