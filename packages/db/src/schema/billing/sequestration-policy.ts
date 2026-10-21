import { sql } from "drizzle-orm";
// @chartwarden/db — `sequestration_policy` (M23 Billing-Medicare §3.3; non-partitioned; retention class
// `operational`). The per-provider-entity sequestration-percentage schedule applied at claim assembly
// (snapshotted onto claim.sequestration_applied_pct). ORG-SCOPED: organization_id NOT NULL (canonical
// app.org_id RLS).
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): only organization_id (core) gets a real
// `.references(...)`. provider_entity_id (M40) and set_by_membership_id (core memberships) are LOGICAL
// FKs — plain uuid, validated at runtime (mirrors the M27 cost-report precedent). No PHI (D18).
import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const sequestrationPolicy = pgTable(
  "sequestration_policy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40

    percentage: text("percentage").notNull(), // decimal as text e.g. "2.00"
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"), // NULL = currently active

    setByMembershipId: uuid("set_by_membership_id").notNull(), // logical FK → memberships
    setReason: text("set_reason"),

    /** F-212 (migration 0281): a correction SUPERSEDES a row; a superseded row is frozen history, not "live". */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeUq: uniqueIndex("sequestration_policy_active_uq")
      .on(t.providerEntityId, t.effectiveFrom)
      .where(sql`effective_to IS NULL AND superseded_at IS NULL`),
    byPe: index("sequestration_policy_by_pe_idx").on(t.providerEntityId, t.effectiveFrom),
    // F-212 (migration 0281) — append-only + overlap-safe, in SQL only (drizzle cannot express an EXCLUDE): the
    // `sequestration_policy_no_overlap` EXCLUDE (two LIVE rows for one provider entity never overlap in date), CHECKs
    // (`_percentage_chk` decimal in [0, 2], `_start_chk` >= 2013-04-01, `_period_chk`, `_superseded_chk`), a column-level
    // UPDATE GRANT (effective_to + the two supersede columns only) and the `sequestration_policy_guard` trigger.
    // NO `forwardOnly` CHECK (DB-005, dropped in migration 0162): an `effective_from > CURRENT_DATE`
    // CHECK re-validates on every future write using the CURRENT date, not the date the row was
    // created — so the CURRENTLY-ACTIVE policy (the normal, expected steady state once a
    // formerly-future effective_from naturally arrives) becomes unupdatable, and `pg_restore`'s
    // COPY-time re-validation rejects any such row restored after its start date. Enforced at write
    // time instead (F-212: the plausibility band + effective window live in `validateSequestrationPolicyEntry`, and the
    // service in apps/backend/src/modules/23-billing-medicare/routes/sequestration-policy-service.ts).
  }),
);

export type SequestrationPolicy = typeof sequestrationPolicy.$inferSelect;
export type NewSequestrationPolicy = typeof sequestrationPolicy.$inferInsert;
