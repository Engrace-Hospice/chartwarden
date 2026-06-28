// @wardenx/db — `trial_balance_import` (M27 §3.3, D6; non-partitioned; retention class `compliance`).
// Audit-replay record of every Xero trial-balance pull (or manual CSV). `raw_payload_cipher` is
// envelope-encrypted at rest (per-tenant DEK) and audit-denylisted (§3.6); `normalized_accounts` holds
// the post-normalization GL rows. History is preserved (never updated) — the latest status='complete'
// row per (cost_report, source) is canonical. Defines the shared m27_import_source / m27_import_status
// enums (reused by wage_data_import). ORG-SCOPED. No PHI (financial PII, not PHI — D18).
import { sql } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { costReport } from "./cost-report";
import type { EnvelopeCipher, NormalizedAccount } from "./types";

export const m27ImportSource = pgEnum("m27_import_source", ["xero", "manual_csv", "gusto"]);
export const m27ImportStatus = pgEnum("m27_import_status", ["pending", "complete", "failed"]);

export const trialBalanceImport = pgTable(
  "trial_balance_import",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    costReportId: uuid("cost_report_id")
      .notNull()
      .references(() => costReport.id, { onDelete: "cascade" }),
    source: m27ImportSource("source").notNull(),
    xeroTenantId: varchar("xero_tenant_id", { length: 100 }),
    rawPayloadCipher: jsonb("raw_payload_cipher").$type<EnvelopeCipher>(), // envelope-encrypted; denylisted
    normalizedAccounts: jsonb("normalized_accounts")
      .$type<NormalizedAccount[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: m27ImportStatus("status").notNull(),
    failureReason: varchar("failure_reason", { length: 1000 }),
    pulledByMembershipId: uuid("pulled_by_membership_id"),
    pulledAt: timestamp("pulled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxOrgReportPulled: index("idx_tb_import_org_report_pulled").on(
      t.organizationId,
      t.costReportId,
      t.pulledAt,
    ),
  }),
);

export type TrialBalanceImport = typeof trialBalanceImport.$inferSelect;
export type NewTrialBalanceImport = typeof trialBalanceImport.$inferInsert;
