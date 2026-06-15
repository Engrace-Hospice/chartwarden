// @wardenx/db — `location` (M1 Foundation §3.5). Leaf of the tenancy spine (a service
// site under a provider_entity). NON_ORG_SCOPED in check-tenancy.ts: it defines the
// location scope that PHI tables key on via the three-column rule.
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locationStatus } from "../enums";
import { providerEntities } from "./provider-entities";

export const locations = pgTable(
  "location",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    city: text("city").notNull(),
    state: text("state").notNull(),
    postalCode: text("postal_code").notNull(),
    phone: text("phone"),
    fax: text("fax"),
    timezone: text("timezone").notNull(),
    serviceArea: jsonb("service_area").notNull().default([]),
    status: locationStatus("status").notNull().default("created"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerEntityIdx: index("location_provider_entity_idx").on(t.providerEntityId),
    stateIdx: index("location_state_idx").on(t.state),
  }),
);

export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;
