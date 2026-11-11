import { index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { claimmdEraM25Stage } from "./claimmd-era";

/** Append-only reviewer decisions over an already tenant-owned Claim.MD M25 stage. */
export const claimMdEraMatchDecision = pgTable("claimmd_era_match_decision", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  providerEntityId: uuid("provider_entity_id").notNull(),
  stageId: uuid("stage_id").notNull().references(() => claimmdEraM25Stage.id, { onDelete: "restrict" }),
  transactionSetControlNumber: varchar("transaction_set_control_number", { length: 9 }).notNull(),
  claimIndex: integer("claim_index").notNull(),
  decisionVersion: integer("decision_version").notNull(),
  outcome: text("outcome").notNull(),
  claimId: uuid("claim_id"),
  sourceDigest: varchar("source_digest", { length: 64 }).notNull(),
  evidence: jsonb("evidence").notNull(),
  reason: varchar("reason", { length: 500 }).notNull(),
  actorMembershipId: uuid("actor_membership_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byStageClaim: index("claimmd_era_match_decision_stage_claim_ix").on(t.stageId, t.transactionSetControlNumber, t.claimIndex, t.decisionVersion),
}));

export type ClaimMdEraMatchDecision = typeof claimMdEraMatchDecision.$inferSelect;
export type NewClaimMdEraMatchDecision = typeof claimMdEraMatchDecision.$inferInsert;
