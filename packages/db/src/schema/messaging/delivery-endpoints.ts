// @wardenx/db — `delivery_endpoint` (M36 Secure Messaging §3.5). A user's registered
// out-of-band destination (web-push subscription, E.164 phone, email). Endpoints belong to
// the human, not the tenant, so the table carries NO organization_id and is opted out of the
// three-column rule via the check-tenancy NON_ORG_SCOPED allowlist (a reviewed change) —
// same posture as `session`/`presence`. `consecutive_failures` drives endpoint quarantine.
// RLS (user-ownership) lands in M36-T03.
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { deliveryEndpointChannel, deliveryEndpointVerification } from "../../enums";
import { users } from "../users";

export const deliveryEndpoints = pgTable(
  "delivery_endpoint",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: deliveryEndpointChannel("channel").notNull(),
    endpointValue: text("endpoint_value").notNull(), // VAPID sub | E.164 | email
    verificationStatus: deliveryEndpointVerification("verification_status")
      .notNull()
      .default("pending"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerUserChannel: uniqueIndex("delivery_endpoint_unique").on(
      t.userId,
      t.channel,
      t.endpointValue,
    ),
    byUserChannel: index("delivery_endpoint_user_channel_idx").on(t.userId, t.channel),
  }),
);

export type DeliveryEndpoint = typeof deliveryEndpoints.$inferSelect;
export type NewDeliveryEndpoint = typeof deliveryEndpoints.$inferInsert;
