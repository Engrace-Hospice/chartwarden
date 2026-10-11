// @wardenx/db — `clearinghouse_submission_attempt` (M23 Billing-Medicare; ADR-0053 D4; non-partitioned). The durable
// record of what the platform sent a clearinghouse: reserved before the send, completed once the vendor has taken it,
// released on a definitive refusal. Vendors expire idempotency keys and share one credential across tenants, so the
// replay / conflict / tenant-isolation guarantee lives here.
// ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS, ENABLED + FORCEd). No PHI and no payload: the key
// and control number are ours, `identity` is a SHA-256, the vendor id is opaque.
//
// CROSS-MODULE FK POLICY: only `organization_id` (core) gets a real `.references(...)`; `provider_entity_id` (M40) is a
// LOGICAL FK validated at runtime.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const CLEARINGHOUSE_ATTEMPT_STATUS_VALUES = ["reserved", "sent", "released"] as const;
export type ClearinghouseAttemptStatusValue = (typeof CLEARINGHOUSE_ATTEMPT_STATUS_VALUES)[number];

export const CLEARINGHOUSE_ATTEMPT_KIND_VALUES = ["claim", "noe", "notr"] as const;
export type ClearinghouseAttemptKindValue = (typeof CLEARINGHOUSE_ATTEMPT_KIND_VALUES)[number];

export const clearinghouseSubmissionAttempts = pgTable(
  "clearinghouse_submission_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    scope: text("scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    controlNumber: text("control_number").notNull(),
    kind: text("kind").$type<ClearinghouseAttemptKindValue>().notNull(),
    identity: text("identity").notNull(),
    status: text("status").$type<ClearinghouseAttemptStatusValue>().notNull().default("reserved"),
    clearinghouseSubmissionId: text("clearinghouse_submission_id"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("clearinghouse_submission_attempt_key_live_uq")
      .on(t.organizationId, t.scope, t.idempotencyKey)
      .where(sql`${t.status} <> 'released'`),
    uniqueIndex("clearinghouse_submission_attempt_control_live_uq")
      .on(t.organizationId, t.scope, t.controlNumber)
      .where(sql`${t.status} <> 'released'`),
    index("clearinghouse_submission_attempt_reserved_idx")
      .on(t.organizationId, t.reservedAt)
      .where(sql`${t.status} = 'reserved'`),
  ],
);

export type ClearinghouseSubmissionAttemptRow = typeof clearinghouseSubmissionAttempts.$inferSelect;
