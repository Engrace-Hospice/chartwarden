// @chartwarden/db — `delivery_endpoint` (M36 Secure Messaging §3.5). A user's registered
// out-of-band destination (web-push subscription, E.164 phone, email). Endpoints belong to
// the human, not the tenant, so the table carries NO organization_id and is opted out of the
// three-column rule via the check-tenancy NON_ORG_SCOPED allowlist (a reviewed change) —
// same posture as `session`/`presence`. `consecutive_failures` drives endpoint quarantine.
// RLS (user-ownership) lands in M36-T03.
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import {
  deliveryEndpointChannel,
  deliveryEndpointProvider,
  deliveryEndpointVerification,
} from "../../enums";
import { users } from "../users";

export const deliveryEndpoints = pgTable(
  "delivery_endpoint",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: deliveryEndpointChannel("channel").notNull(),
    endpointValue: text("endpoint_value").notNull(), // web push subscription JSON | FCM/APNs token | E.164 | email
    // WP 5.11 (migration 1153): who delivers a push endpoint. `web` for every non-push channel (a CHECK pins it).
    provider: deliveryEndpointProvider("provider").notNull().default("web"),
    verificationStatus: deliveryEndpointVerification("verification_status")
      .notNull()
      .default("pending"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    // GAP-166 (migration 0471): the §4.2 OTP. Only a salted SHA-256 of the code is stored.
    verificationTokenHash: text("verification_token_hash"),
    verificationTokenExpiresAt: timestamp("verification_token_expires_at", { withTimezone: true }),
    verificationAttempts: integer("verification_attempts").notNull().default(0),
    // WP 5.5 (migration 1130): the session that registered the endpoint. No FK on purpose (`session` is M2's table); a session revoke expires
    // the endpoints linked to it in the same transaction. NULL = registered before the link or without a session.
    sessionId: text("session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerUserChannel: uniqueIndex("delivery_endpoint_unique").on(
      t.userId,
      t.channel,
      t.endpointValue,
    ),
    byUserChannel: index("delivery_endpoint_user_channel_idx").on(t.userId, t.channel),
    bySession: index("delivery_endpoint_session_idx")
      .on(t.userId, t.sessionId)
      .where(sql`${t.sessionId} IS NOT NULL`),
  }),
);

export type DeliveryEndpoint = typeof deliveryEndpoints.$inferSelect;
export type NewDeliveryEndpoint = typeof deliveryEndpoints.$inferInsert;
