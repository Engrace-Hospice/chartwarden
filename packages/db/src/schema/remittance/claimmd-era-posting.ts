import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { claimmdEraM25Stage } from "./claimmd-era";

/** Immutable server-calculated plan. Sensitive source material remains in the protected stage. */
export const claimMdEraPostingPlan = pgTable(
  "claimmd_era_posting_plan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => claimmdEraM25Stage.id, { onDelete: "restrict" }),
    planDigest: varchar("plan_digest", { length: 64 }).notNull(),
    plan: jsonb("plan").notNull(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourcePlan: uniqueIndex("claimmd_era_posting_plan_source_uq").on(t.stageId, t.planDigest),
    byTenantStage: index("claimmd_era_posting_plan_tenant_stage_ix").on(
      t.organizationId,
      t.providerEntityId,
      t.stageId,
      t.createdAt,
    ),
  }),
);

/** Append-only approval/execution evidence; approval itself never creates financial effects. */
export const claimMdEraPostingEvent = pgTable(
  "claimmd_era_posting_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => claimmdEraM25Stage.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => claimMdEraPostingPlan.id, { onDelete: "restrict" }),
    eventType: text("event_type").$type<"approved" | "posted">().notNull(),
    planDigest: varchar("plan_digest", { length: 64 }).notNull(),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", { length: 64 }).notNull(),
    adviceId: uuid("advice_id"),
    remittanceLineId: uuid("remittance_line_id"),
    reason: varchar("reason", { length: 500 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idem: uniqueIndex("claimmd_era_posting_event_idempotency_uq").on(
      t.organizationId,
      t.idempotencyKeyHash,
    ),
    planEvent: index("claimmd_era_posting_event_plan_ix").on(t.planId, t.createdAt),
  }),
);
