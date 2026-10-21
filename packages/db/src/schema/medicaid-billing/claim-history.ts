// @chartwarden/db — M24 Billing — Medicaid §3.3 — the append-only per-claim transition log.
// PARTITION BY LIST(organization_id); composite PK (id, organization_id) including the partition key,
// declared in SQL (0095). medicaid_claim_id is a LOGICAL uuid (medicaid_claim is partitioned with a
// composite PK — not a single-column FK target). organization_id → organizations is the only real FK.
import { index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m24ClaimState } from "./enums";

export const medicaidClaimStateHistory = pgTable(
  "medicaid_claim_state_history",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, organization_id) in SQL
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }), // partition key
    medicaidClaimId: uuid("medicaid_claim_id").notNull(), // logical FK → medicaid_claim
    fromState: m24ClaimState("from_state"), // null on initial DRAFT
    toState: m24ClaimState("to_state").notNull(),
    reason: text("reason"),
    triggerSource: varchar("trigger_source", { length: 32 }).notNull(), // user | worker | consumer | cron
    actorMembershipId: uuid("actor_membership_id"), // null when worker/cron
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClaimAt: index("medicaid_claim_state_history_by_claim_at").on(t.medicaidClaimId, t.at),
  }),
);
