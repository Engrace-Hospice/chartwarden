// @wardenx/db — `bad_debt_record` (M27 §3.3, D7; non-partitioned; retention class `compliance`).
// Opt-in per cost report (`cost_report.bad_debt_claimed`): the un-collectible portion of Medicare
// deductibles/coinsurance claimed under PRM I Ch 3-4 allowability (collection efforts documented). Add/
// edit only while parent is draft/populating; soft-delete (`deleted_at` tombstone) preserves the row for
// audit. supporting_document_ids are M22 doc refs (aggregate-to-period; no patient identifier). ORG-
// SCOPED. No PHI (D18) — `period_label` is a month bucket, not a patient.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { costReport } from "./cost-report";

export const m27BadDebtKind = pgEnum("m27_bad_debt_kind", ["deductible", "coinsurance"]);

export const badDebtRecord = pgTable(
  "bad_debt_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    costReportId: uuid("cost_report_id")
      .notNull()
      .references(() => costReport.id, { onDelete: "cascade" }),
    periodLabel: varchar("period_label", { length: 20 }).notNull(), // e.g. "2026-03"
    debtKind: m27BadDebtKind("debt_kind").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    collectionEffortsDocumented: boolean("collection_efforts_documented")
      .notNull()
      .default(false),
    supportingDocumentIds: jsonb("supporting_document_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    addedByMembershipId: uuid("added_by_membership_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByMembershipId: uuid("deleted_by_membership_id"),
  },
  (t) => ({
    idxOrgReportPeriod: index("idx_bad_debt_org_report_period").on(
      t.organizationId,
      t.costReportId,
      t.periodLabel,
    ),
  }),
);

export type BadDebtRecord = typeof badDebtRecord.$inferSelect;
export type NewBadDebtRecord = typeof badDebtRecord.$inferInsert;
