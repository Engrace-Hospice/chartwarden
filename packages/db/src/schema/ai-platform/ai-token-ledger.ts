// @chartwarden/db — `ai_token_ledger` (M32 §3.2.9). The per-tenant token/cost accrual W2's hard cap reads.
//
// TENANT-SCOPED: organization_id NOT NULL, RLS keyed ONLY on app.org_id (0116). No provider_entity_id /
// location_id and no patient column — this table holds token counts and dollars, not clinical content;
// the three-column rule attaches to PHI-bearing tables, and the PHI lives one hop away in `ai_invocation`.
//
// PARTITIONED MONTHLY on `accrued_at`, so the composite primary key `(id, accrued_at)` — declared in
// migration 0115. The month IS the billing period, so partition pruning and the cap window are the same
// boundary: "this tenant's spend this month" reads exactly one partition. Retention is 6 years (§3.8) —
// shorter than `ai_invocation`'s 7 because this is the SaaS billing audit trail (M35), not the
// disclosure accounting.
//
// APPEND-ONLY (§3.5): UPDATE and DELETE both refused by the 0116 trigger, and `wardenx_app` is granted
// SELECT/INSERT only. A ledger that can be edited cannot bound anything — W2's hard cap is enforced by
// summing this table, and a mutable row means the sum is a claim rather than a total. A correction is a
// compensating row.
//
// `invocation_id` is a LOGICAL uuid with NO foreign key, and that is forced rather than chosen: its
// parent `ai_invocation` is itself partitioned, so a real FK would have to reference the full composite
// key `(id, invoked_at)` — dragging the invocation's partition key into this table's rows purely to
// satisfy the constraint, and coupling two independent partition schemes. The pairing is validated at the
// write boundary, where both rows are written in one transaction.
//
// BOTH cost columns are NULLABLE and exactly one is expected per row: `cloud_cost_usd` for a vendor call
// (real money), `local_compute_attribution` for a local model (an internal allocation, not a bill). A
// single "cost" column would make a local run look like spend on the invoice the tenant reads.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { aiCapability } from "./ai-capabilities";
import { aiModelBackend } from "./ai-model-backends";

export const aiTokenLedger = pgTable(
  "ai_token_ledger",
  {
    // Composite PK (id, accrued_at) declared in SQL (0115) — see header.
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    /** Logical uuid → `ai_invocation` (see header: partitioned parent, no FK). */
    invocationId: uuid("invocation_id").notNull(),

    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => aiCapability.id, { onDelete: "restrict" }),
    backendId: uuid("backend_id")
      .notNull()
      .references(() => aiModelBackend.id, { onDelete: "restrict" }),

    /** The vendor's published rate AT THE TIME, frozen — a later price change must not rewrite history. */
    vendorRateAtInvocation: text("vendor_rate_at_invocation"),

    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),

    /** Real money on a vendor call (see header). */
    cloudCostUsd: numeric("cloud_cost_usd", { precision: 12, scale: 6 }),
    /** An internal allocation for a local model — never billed as spend. */
    localComputeAttribution: numeric("local_compute_attribution", { precision: 12, scale: 6 }),

    accruedAt: timestamp("accrued_at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgAccruedIdx: index("ai_token_ledger_org_accrued_idx").on(
      t.organizationId,
      t.accruedAt.desc(),
    ),
    capabilityAccruedIdx: index("ai_token_ledger_cap_accrued_idx").on(
      t.organizationId,
      t.capabilityId,
      t.accruedAt.desc(),
    ),

    // Token counts are counts. A negative accrual would silently refund a tenant against the hard cap.
    nonNegativeTokens: check(
      "ai_token_ledger_nonneg_tokens",
      sql`input_tokens >= 0 AND output_tokens >= 0`,
    ),
  }),
);

export type AiTokenLedgerRow = typeof aiTokenLedger.$inferSelect;
export type NewAiTokenLedgerRow = typeof aiTokenLedger.$inferInsert;
