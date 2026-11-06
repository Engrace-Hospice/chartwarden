import { integer, index, pgTable, text, timestamp, uuid, primaryKey } from "drizzle-orm/pg-core";
import { claimmdResponseEvents } from "./claimmd-response-inbox";

/** Account-scoped delivery queue. It contains no tenant assignment or response text. */
export const claimmdAckDeliveries = pgTable("claimmd_ack_delivery", {
  eventId: uuid("event_id").notNull().references(() => claimmdResponseEvents.id, { onDelete: "restrict" }),
  mode: text("mode").$type<"shadow" | "apply">().notNull(),
  accountReference: text("account_reference").notNull(),
  usage: text("usage").$type<"test" | "production">().notNull(),
  state: text("state").$type<"pending" | "complete" | "needs_review">().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: uuid("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  errorCode: text("error_code"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.eventId, t.mode], name: "claimmd_ack_delivery_pk" }),
  index("claimmd_ack_delivery_due_ix").on(t.accountReference, t.usage, t.mode, t.state, t.nextAttemptAt)]);
