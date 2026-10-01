// @wardenx/db — `election_period` (M6 §3.3). The benefit-period ledger hanging off an admission
// (90/90/60/60…). Org-scoped (no direct patient identifier; tenancy via the admission FK).
// `election_statement_id` / `cti_id` are deferred FKs installed in the migration once both child
// tables exist (avoids a TS import cycle); `completed_by_event_id` is a logical FK whose target
// varies by cause. RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import {
  bigint,
  date,
  index,
  pgTable,
  smallint,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  electionPeriodCompletionCause,
  electionPeriodKind,
  electionPeriodStatus,
} from "../../enums";
import { organizations } from "../organizations";
import { admissions } from "./admissions";

export const electionPeriods = pgTable(
  "election_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    sequenceNumber: smallint("sequence_number").notNull(),
    periodKind: electionPeriodKind("period_kind").notNull(),
    effectiveAt: date("effective_at"),
    scheduledEndAt: date("scheduled_end_at"),
    actualEndAt: date("actual_end_at"),
    status: electionPeriodStatus("status").notNull().default("pending"),
    // Deferred FKs to election_statement / cti — enforced in the migration after both tables exist.
    electionStatementId: uuid("election_statement_id"),
    ctiId: uuid("cti_id"),
    completedByCause: electionPeriodCompletionCause("completed_by_cause"),
    completedByEventId: uuid("completed_by_event_id"), // FK varies by cause; left logical, not enforced
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    // F-223 — the triggering M11 `order_record.id` (logical uuid, no SQL FK: M6's dependsOn excludes M11).
    // NULL for every period opened by the HTTP route; only the order-triggered consumer sets it.
    sourceOrderId: uuid("source_order_id"),
  },
  (t) => ({
    admSeqUnique: uniqueIndex("election_period_admission_seq_idx").on(
      t.admissionId,
      t.sequenceNumber,
    ),
    admIdx: index("election_period_admission_idx").on(t.admissionId, t.sequenceNumber),
    sourceOrderUq: unique("election_period_source_order_id_uq").on(
      t.organizationId,
      t.sourceOrderId,
    ),
  }),
);

export type ElectionPeriod = typeof electionPeriods.$inferSelect;
export type NewElectionPeriod = typeof electionPeriods.$inferInsert;
