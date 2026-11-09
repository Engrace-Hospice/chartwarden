import { integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { claimmdEraM25Stage } from "./claimmd-era";

/** Append-only M25 nonposting reviewer decisions. This table is separate from accounting/posting state. */
export const claimMdEraFinancialReviewDecision = pgTable(
  "claimmd_era_financial_review_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => claimmdEraM25Stage.id, { onDelete: "restrict" }),
    itemType: text("item_type").$type<"era" | "claim">().notNull(),
    itemIndex: integer("item_index").notNull(),
    decisionVersion: integer("decision_version").notNull(),
    disposition: text("disposition")
      .$type<"note" | "follow_up" | "reviewed" | "reopened" | "completed">()
      .notNull(),
    sourceDigest: varchar("source_digest", { length: 64 }).notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    itemVersionUnique: uniqueIndex("claimmd_era_fin_review_item_version_uq").on(
      t.stageId,
      t.itemType,
      t.itemIndex,
      t.decisionVersion,
    ),
    idempotencyUnique: uniqueIndex("claimmd_era_fin_review_idempotency_uq").on(
      t.organizationId,
      t.idempotencyKeyHash,
    ),
  }),
);

export type ClaimMdEraFinancialReviewDecision =
  typeof claimMdEraFinancialReviewDecision.$inferSelect;
