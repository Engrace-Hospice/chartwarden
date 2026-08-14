// @wardenx/db — `hipps_calculation` (M23 Billing-Medicare §3.3; append-only, 1:1 with `claim`;
// non-partitioned; retention class `compliance`). Captures the reproducible HIPPS payment math for a
// claim: the 5-char HIPPS code, the per-diem rate, and the wage-index SNAPSHOT (CCN + fiscal year +
// factor stored as text, NOT a pointer — the platform-shared `wage_index_factor` file can be re-loaded,
// so the math must stay reproducible). The per-segment level-of-care breakdown is in `segments`.
// ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS).
//
// CROSS-MODULE FK POLICY (architecture WINS): only `organization_id` (core) + `claim_id` (intra-M23)
// get real `.references(...)`. No PHI / MBI is stored here (D13, §8.7).
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { claim } from "./claim";
import type { HippsCalculationSegments } from "./types";

export const hippsCalculation = pgTable(
  "hipps_calculation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claim.id, { onDelete: "restrict" }),

    hippsCode: text("hipps_code").notNull(), // 5-char HIPPS string e.g. "C2HJF"
    hippsRateCents: bigint("hipps_rate_cents", { mode: "number" }).notNull(),

    // Wage-index applied at calculation time (snapshot, not pointer — wage-index file is platform-shared
    // but the math must be reproducible):
    wageIndexCcn: text("wage_index_ccn").notNull(),
    wageIndexFiscalYear: integer("wage_index_fiscal_year").notNull(),
    wageIndexFactor: text("wage_index_factor").notNull(), // decimal as text e.g. "0.9234"

    // Period-segment breakdown (typed):
    segments: jsonb("segments").$type<HippsCalculationSegments>().notNull(), // [{ levelOfCare, dateFrom, dateTo, ratePerDiemCents, hippsCharPosition }]

    // ADR-0001 RHC day-60 two-tier day counts (RHC-High days 1-60 / RHC-Low day 61+, 80 FR 47142):
    rhcDays1to60: integer("rhc_days_1_to_60").notNull().default(0),
    rhcDays61Plus: integer("rhc_days_61_plus").notNull().default(0),

    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneToOne: uniqueIndex("hipps_calculation_claim_uq").on(t.claimId),
    // §3.4 hipps_calculation_ccn_fy — platform-side reporting / CMS rate-update reconciliation trail:
    ccnFy: index("hipps_calculation_ccn_fy_idx").on(t.wageIndexCcn, t.wageIndexFiscalYear),
  }),
);

export type HippsCalculation = typeof hippsCalculation.$inferSelect;
export type NewHippsCalculation = typeof hippsCalculation.$inferInsert;
