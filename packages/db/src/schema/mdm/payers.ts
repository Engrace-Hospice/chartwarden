// @chartwarden/db — `payer` (M40 MDM §3.3). The CANONICAL payer record: one org-less row per
// real-world payer, keyed by the X12 5010 payer id (UNIQUE where non-null). `kind` is the §3.3
// payer subtype; `state_code` scopes Medicaid. Per-tenant negotiated contract terms are NOT
// canonical — they live in the (Phase-2) payer overlay (§2.3); Phase 1 ships the canonical
// table only (manifest owns 11 tables). A `merged` row redirects to its survivor via
// `merged_into_id` (§2.4.1, §7.2). Canonical → no organization_id (NON_ORG_SCOPED allowlist).
// RLS/grants/audit triggers land in M40-T03 (§3.6). Not PHI.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mdmEntityStatus, payerKind } from "../../enums";

export const payers = pgTable(
  "payer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: payerKind("kind").notNull(),
    stateCode: text("state_code"), // for Medicaid
    payerId: text("payer_id"), // X12 5010 id
    name: text("name").notNull(),
    status: mdmEntityStatus("status").notNull().default("active"),
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => payers.id, {
      onDelete: "restrict",
    }),
    mergedFrom: uuid("merged_from").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    payerIdIdx: uniqueIndex("payer_x12_idx").on(t.payerId).where(sql`payer_id IS NOT NULL`),
    nameTrgmIdx: index("payer_name_trgm_idx").using("gin", sql`name gin_trgm_ops`),
    kindStateIdx: index("payer_kind_state_idx").on(t.kind, t.stateCode),
    mergedConsistency: check(
      "payer_merged_consistency",
      sql`(status = 'merged') = (merged_into_id IS NOT NULL)`,
    ),
  }),
);

export type Payer = typeof payers.$inferSelect;
export type NewPayer = typeof payers.$inferInsert;
