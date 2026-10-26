// @chartwarden/db - M23 (migration 1269): the per-(provider entity, route) EDI profile the 837I loader reads for the
// interchange parties the chart cannot supply (submitter name/id/contact, receiver name/id/GS03). Tenant-entered, never
// seeded; a missing row is a typed gap in the loader. `route_key` is the CLEARINGHOUSE_VENDOR value (text, no enum).
// Business contact details only: no PHI, no secret. provider_entity_id / set_by_membership_id are logical FKs.
import { integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const billingEdiProfile = pgTable(
  "billing_edi_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    routeKey: text("route_key").notNull(),
    submitterName: text("submitter_name").notNull(),
    submitterId: text("submitter_id").notNull(),
    submitterContactName: text("submitter_contact_name").notNull(),
    submitterContactPhone: text("submitter_contact_phone").notNull(),
    receiverName: text("receiver_name").notNull(),
    receiverId: text("receiver_id").notNull(),
    receiverApplicationCode: text("receiver_application_code").notNull(),
    setByMembershipId: uuid("set_by_membership_id").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("billing_edi_profile_key").on(t.organizationId, t.providerEntityId, t.routeKey)],
);

export type BillingEdiProfile = typeof billingEdiProfile.$inferSelect;
export type NewBillingEdiProfile = typeof billingEdiProfile.$inferInsert;
