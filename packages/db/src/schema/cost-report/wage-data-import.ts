// @wardenx/db — `wage_data_import` (M27 §3.3, D6; non-partitioned; retention class `compliance`).
// Audit-replay record of every Gusto wage-data pull (or manual entry) feeding Worksheet S-3 Part II.
// `raw_payload_cipher` is envelope-encrypted + audit-denylisted (§3.6); `normalized_wage_rows` holds the
// per-discipline paid-hours/salary/fringe rows. Reuses the m27_import_source / m27_import_status enums
// (defined in trial-balance-import.ts). ORG-SCOPED. No PHI (financial PII, not PHI — D18).
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { costReport } from "./cost-report";
import { m27ImportSource, m27ImportStatus } from "./trial-balance-import";
import type { EnvelopeCipher, NormalizedWageRow } from "./types";

export const wageDataImport = pgTable(
  "wage_data_import",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    costReportId: uuid("cost_report_id")
      .notNull()
      .references(() => costReport.id, { onDelete: "cascade" }),
    source: m27ImportSource("source").notNull(),
    gustoCompanyId: varchar("gusto_company_id", { length: 100 }),
    rawPayloadCipher: jsonb("raw_payload_cipher").$type<EnvelopeCipher>(), // envelope-encrypted; denylisted
    normalizedWageRows: jsonb("normalized_wage_rows")
      .$type<NormalizedWageRow[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: m27ImportStatus("status").notNull(),
    failureReason: varchar("failure_reason", { length: 1000 }),
    pulledByMembershipId: uuid("pulled_by_membership_id"),
    pulledAt: timestamp("pulled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxOrgReportPulled: index("idx_wage_import_org_report_pulled").on(
      t.organizationId,
      t.costReportId,
      t.pulledAt,
    ),
  }),
);

export type WageDataImport = typeof wageDataImport.$inferSelect;
export type NewWageDataImport = typeof wageDataImport.$inferInsert;
